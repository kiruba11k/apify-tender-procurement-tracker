import { Actor, log } from 'apify';
import pLimit from 'p-limit';
import dayjs from 'dayjs';
import { classifyTender, isIcpRelevant, splitKeywords } from './classifiers/categoryClassifier.js';
import { isExpired, isRecentlyClosed, isDuplicate, resetDedup, formatBudget } from './utils/helpers.js';
import { scrapeSamGov }       from './scrapers/samGov.js';
import { scrapeTedEuropa }    from './scrapers/tedEuropa.js';
import { scrapeGemIndia }     from './scrapers/gemIndia.js';
import {
  scrapeFindATender,
  scrapeContractsFinder,
  scrapeUNGM,
  scrapeWorldBank,
  scrapeMerxCanada,
  scrapeAusTendering,
  scrapeEBRD,
  scrapeADB,
} from './scrapers/otherSources.js';

const SOURCE_MAP = {
  sam_gov:           { fn: scrapeSamGov,          region: 'US',           label: 'SAM.gov (US Federal)' },
  ted_europa:        { fn: scrapeTedEuropa,        region: 'EU',           label: 'TED Europa (EU)' },
  gem_india:         { fn: scrapeGemIndia,         region: 'India',        label: 'GEM India' },
  find_a_tender_uk:  { fn: scrapeFindATender,      region: 'UK',           label: 'Find-a-Tender (UK)' },
  contracts_finder:  { fn: scrapeContractsFinder,  region: 'UK',           label: 'Contracts Finder (UK)' },
  ungm:              { fn: scrapeUNGM,             region: 'Global',       label: 'UNGM (UN)' },
  worldbank:         { fn: scrapeWorldBank,        region: 'Global',       label: 'World Bank' },
  ebrd:              { fn: scrapeEBRD,             region: 'Global',       label: 'EBRD' },
  adb:               { fn: scrapeADB,              region: 'Asia-Pacific', label: 'ADB (Asian Dev. Bank)' },
  merx_canada:       { fn: scrapeMerxCanada,       region: 'Canada',       label: 'MERX Canada' },
  austendering:      { fn: scrapeAusTendering,     region: 'Australia',    label: 'AusTendering' },
};

const ALWAYS_ON = new Set(['ungm', 'worldbank', 'ebrd']);

const REGION_SOURCE_MAP = {
  US: ['sam_gov'],
  EU: ['ted_europa'],
  UK: ['find_a_tender_uk', 'contracts_finder'],
  India: ['gem_india'],
  Canada: ['merx_canada'],
  Australia: ['austendering'],
  'Asia-Pacific': ['adb'],
};

function resolveActiveSources(regions = []) {
  const selected = new Set(ALWAYS_ON);
  const isGlobal = regions.length === 0 || regions.includes('Global');
  if (isGlobal) {
    Object.keys(SOURCE_MAP).forEach(k => selected.add(k));
  } else {
    for (const r of regions) {
      (REGION_SOURCE_MAP[r] || []).forEach(k => selected.add(k));
    }
  }
  return [...selected];
}

await Actor.main(async () => {
  const input = await Actor.getInput();
  const {
    keywords = [],
    company_names = [],
    industry = 'All',
    regions = ['US', 'EU', 'India'],
    budget_threshold = 10000,
    max_results = 200,
    include_closed = false,
    proxy_config = { useApifyProxy: true },
  } = input || {};

  log.info('🚀 Starting Tender Tracker...');

  let proxyUrl = null;
  if (proxy_config?.useApifyProxy) {
    const proxyConfig = await Actor.createProxyConfiguration(proxy_config);
    proxyUrl = await proxyConfig.newUrl();
  }

  // FIX: Clean keywords for API requests (remove quotes that cause 400 OCDS errors)
  const apiKeywords = keywords.map(k => k.replace(/"/g, ''));
  const activeSources = resolveActiveSources(regions);
  
  const limiter = pLimit(2); 
  const perSourceLimit = Math.ceil(max_results / activeSources.length) + 15;
  const allRaw = [];

  const tasks = activeSources.map(sourceKey =>
    limiter(async () => {
      const src = SOURCE_MAP[sourceKey];
      try {
        const items = await src.fn({ keywords: apiKeywords, maxResults: perSourceLimit, proxyUrl });
        allRaw.push(...items);
      } catch (err) {
        log.error(`[${src.label}] API error: ${err.message}`);
      }
    })
  );

  await Promise.all(tasks);
  resetDedup();
  const dataset = await Actor.openDataset();
  let savedCount = 0;

  for (const raw of allRaw) {
    if (savedCount >= max_results) break;

    // Strict Company Name Matching
    if (company_names.length > 0) {
      const orgLower = (raw.organization_name || '').toLowerCase();
      if (!company_names.some(cn => orgLower.includes(cn.toLowerCase()))) continue; 
    }

    const { category, confidence } = classifyTender(raw.tender_title, raw.description);
    if (category === 'Other' && confidence < 15 && industry !== 'All') continue;

    raw.category = category;
    if (!isIcpRelevant(raw, keywords, industry)) continue;

    await dataset.pushData({
      ...raw,
      budget: raw.budget_usd ? formatBudget(raw.budget_usd) : raw.budget_raw || null,
      classification_confidence: confidence,
      scraped_at: new Date().toISOString(),
    });
    savedCount++;
  }
  log.info(`✅ Run Complete. Saved ${savedCount} tenders.`);
});
