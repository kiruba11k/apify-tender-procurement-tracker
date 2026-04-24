/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║        TENDER & PROCUREMENT TRACKER — Apify Actor                   ║
 * ║  Multi-source • AI-classified • ICP-filtered • Global coverage       ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 */

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

// ── Source registry ──────────────────────────────────────────────────────────
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
  US:            ['sam_gov'],
  EU:            ['ted_europa'],
  UK:            ['find_a_tender_uk', 'contracts_finder'],
  India:         ['gem_india'],
  Canada:        ['merx_canada'],
  Australia:     ['austendering'],
  'Asia-Pacific':['adb'],
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

// ── Main ─────────────────────────────────────────────────────────────────────
await Actor.main(async () => {
  const input = await Actor.getInput();

  const {
    keywords         = [],
    company_names    = [],
    industry         = 'All',
    regions          = ['US', 'EU', 'India'],
    budget_threshold = 10000,
    max_results      = 200,
    include_closed   = false,
    proxy_config     = { useApifyProxy: true },
  } = input || {};

  log.info('🚀 Starting Tender Tracker with Strict Company Filtering...');

  // ── Resolve proxy ──────────────────────────────────────────────────────────
  let proxyUrl = null;
  try {
    if (proxy_config?.useApifyProxy) {
      const proxyConfig = await Actor.createProxyConfiguration(proxy_config);
      proxyUrl = await proxyConfig.newUrl();
      log.info('Proxy configured successfully.');
    }
  } catch (e) {
    log.warning('Proxy initialization failed, continuing without proxy.');
  }

  // ── KEYWORD SPLITTING & QUOTING ────────────────────────────────────────────
  // FIX: We split terms for broad API matching but ALSO include the full phrase 
  // in quotes to force exact matches on platforms that support it.
  const splitTerms = splitKeywords(keywords);
  const quotedPhrases = keywords.map(k => `"${k}"`);
  const searchKeywords = [...new Set([...splitTerms, ...quotedPhrases])];

  const activeSources = resolveActiveSources(regions);
  log.info(`Searching ${activeSources.length} sources for: ${searchKeywords.join(', ')}`);

  // ── Parallel scraping ─────────────────────────────────────────────────────
  // Lowered concurrency (limiter 2) to reduce "getaddrinfo" and DNS failures
  const limiter = pLimit(2); 
  const perSourceLimit = Math.ceil(max_results / activeSources.length) + 15;
  const scrapeArgs = { keywords: searchKeywords, maxResults: perSourceLimit, proxyUrl };
  const allRaw = [];

  const tasks = activeSources.map(sourceKey =>
    limiter(async () => {
      const src = SOURCE_MAP[sourceKey];
      try {
        const items = await src.fn(scrapeArgs);
        allRaw.push(...items);
      } catch (err) {
        log.error(`[${src.label}] Connection/API error: ${err.message}`);
      }
    })
  );

  await Promise.all(tasks);

  // ── Post-processing ────────────────────────────────────────────────────────
  resetDedup();
  const dataset = await Actor.openDataset();
  let savedCount = 0;
  
  // Sort by Status (Open first) then by Date (Newest first)
  const sorted = allRaw.sort((a, b) => {
    if (a.tender_status === 'Open' && b.tender_status !== 'Open') return -1;
    if (b.tender_status === 'Open' && a.tender_status !== 'Open') return 1;
    return dayjs(b.announcement_date || '2000-01-01').valueOf() - dayjs(a.announcement_date || '2000-01-01').valueOf();
  });

  for (const raw of sorted) {
    if (savedCount >= max_results) break;

    // 1. Strict Company name filter (Solves "Public Toilet Cleaning" issue)
    // If user provided company names, DISCARD anything that doesn't match.
    if (company_names.length > 0) {
      const orgLower = (raw.organization_name || '').toLowerCase();
      const isCorrectCompany = company_names.some(cn => orgLower.includes(cn.toLowerCase()));
      if (!isCorrectCompany) continue; 
    }

    // 2. Expired filter
    if (!include_closed && isExpired(raw.deadline)) {
      if (!isRecentlyClosed(raw.deadline, 7)) continue;
      raw.tender_status = 'Closed';
    }

    // 3. Classify and Noise Filter
    const { category, confidence } = classifyTender(raw.tender_title, raw.description);
    
    // Discard "Other" category items if confidence is extremely low (prevents irrelevant noise)
    if (category === 'Other' && confidence < 15 && industry !== 'All') continue;

    raw.category = category;

    // 4. Industry filter
    if (!isIcpRelevant(raw, [], industry)) continue;

    // 5. Budget threshold
    if (budget_threshold > 0 && raw.budget_usd !== null && raw.budget_usd < budget_threshold) continue;

    // 6. Deduplication
    if (isDuplicate(raw)) continue;

    // 7. Save to Dataset
    await dataset.pushData({
      ...raw,
      category,
      budget: raw.budget_usd ? formatBudget(raw.budget_usd) : raw.budget_raw || null,
      classification_confidence: confidence,
      scraped_at: new Date().toISOString(),
    });
    
    savedCount++;
  }

  log.info(`✅ Run Complete. Saved ${savedCount} relevant tenders.`);
});
