/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║        TENDER & PROCUREMENT TRACKER — Apify Actor                   ║
 * ║  Multi-source • AI-classified • ICP-filtered • Global coverage       ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 *
 * Sources auto-selected by region. Users do NOT configure sources.
 *
 * KEY FIX: Keywords are sent to each source's own search API.
 * We do NOT re-filter by keyword after scraping — that incorrectly
 * discards results the source already matched. Only `industry` is used
 * for post-scrape filtering.
 */

import { Actor, log } from 'apify';
import pLimit from 'p-limit';
import dayjs from 'dayjs';
import { classifyTender, isIcpRelevant } from './classifiers/categoryClassifier.js';
import { isExpired, isRecentlyClosed, isDuplicate, resetDedup, formatBudget } from './utils/helpers.js';
import { scrapeSamGov } from './scrapers/samGov.js';
import { scrapeTedEuropa } from './scrapers/tedEuropa.js';
import { scrapeGemIndia } from './scrapers/gemIndia.js';
import {
  scrapeFindATender,
  scrapeUNGM,
  scrapeWorldBank,
  scrapeMerxCanada,
  scrapeAusTendering,
  scrapeDevex,
} from './scrapers/otherSources.js';

// ── Source registry ──────────────────────────────────────────────────────────
const SOURCE_MAP = {
  sam_gov:          { fn: scrapeSamGov,       region: 'US',        label: 'SAM.gov (US Federal)' },
  ted_europa:       { fn: scrapeTedEuropa,    region: 'EU',        label: 'TED Europa (EU)' },
  gem_india:        { fn: scrapeGemIndia,     region: 'India',     label: 'GEM India' },
  find_a_tender_uk: { fn: scrapeFindATender,  region: 'UK',        label: 'Find-a-Tender (UK)' },
  ungm:             { fn: scrapeUNGM,         region: 'Global',    label: 'UNGM (UN)' },
  worldbank:        { fn: scrapeWorldBank,    region: 'Global',    label: 'World Bank' },
  merx_canada:      { fn: scrapeMerxCanada,   region: 'Canada',    label: 'MERX Canada' },
  austendering:     { fn: scrapeAusTendering, region: 'Australia', label: 'AusTendering' },
  devex:            { fn: scrapeDevex,        region: 'Global',    label: 'Devex' },
};

// Global sources run with every region combination
const ALWAYS_ON = new Set(['ungm', 'worldbank', 'devex']);

const REGION_SOURCE_MAP = {
  US:        ['sam_gov'],
  EU:        ['ted_europa'],
  UK:        ['find_a_tender_uk'],
  India:     ['gem_india'],
  Canada:    ['merx_canada'],
  Australia: ['austendering'],
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

  log.info('╔══════════════════════════════════════════════╗');
  log.info('║   Tender & Procurement Tracker — Starting    ║');
  log.info('╚══════════════════════════════════════════════╝');
  log.info(`Keywords : ${keywords.join(', ') || '(none)'}`);
  log.info(`Industry : ${industry}`);
  log.info(`Regions  : ${regions.join(', ')}`);
  log.info(`Budget ≥ : $${budget_threshold.toLocaleString()}`);
  log.info(`Closed?  : ${include_closed}`);

  // Resolve proxy
  let proxyUrl = null;
  try {
    if (proxy_config?.useApifyProxy) {
      const proxyConfig = await Actor.createProxyConfiguration(proxy_config);
      proxyUrl = await proxyConfig.newUrl();
      log.info('Proxy    : configured');
    }
  } catch {
    log.warning('Proxy init failed — running without proxy');
  }

  const activeSources = resolveActiveSources(regions);
  log.info(`Sources  : ${activeSources.map(s => SOURCE_MAP[s].label).join(', ')}\n`);

  // ── Parallel scraping ─────────────────────────────────────────────────────
  const limiter = pLimit(3);
  const perSourceLimit = Math.ceil(max_results / activeSources.length) + 20;
  const scrapeArgs = { keywords, maxResults: perSourceLimit, proxyUrl };
  const allRaw = [];

  const tasks = activeSources.map(sourceKey =>
    limiter(async () => {
      const src = SOURCE_MAP[sourceKey];
      log.info(`[${src.label}] Starting...`);
      try {
        const items = await src.fn(scrapeArgs);
        log.info(`[${src.label}] ✓ ${items.length} items`);
        allRaw.push(...items);
      } catch (err) {
        log.error(`[${src.label}] ✗ ${err.message}`);
      }
    })
  );

  await Promise.all(tasks);
  log.info(`\nRaw total: ${allRaw.length}`);

  // ── Post-processing ────────────────────────────────────────────────────────
  resetDedup();
  const dataset = await Actor.openDataset();
  let savedCount = 0;
  const stats = {
    total_raw: allRaw.length,
    expired_removed: 0,
    budget_filtered: 0,
    industry_filtered: 0,
    duplicates_removed: 0,
    saved: 0,
  };

  // Open first, newest first
  const sorted = allRaw.sort((a, b) => {
    if (a.tender_status === 'Open' && b.tender_status !== 'Open') return -1;
    if (b.tender_status === 'Open' && a.tender_status !== 'Open') return 1;
    return dayjs(b.announcement_date || '2000-01-01').valueOf()
         - dayjs(a.announcement_date || '2000-01-01').valueOf();
  });

  for (const raw of sorted) {
    if (savedCount >= max_results) break;

    // 1. Expired filter
    if (!include_closed && isExpired(raw.deadline)) {
      if (!isRecentlyClosed(raw.deadline, 7)) {
        stats.expired_removed++;
        continue;
      }
      raw.tender_status = 'Closed';
    }

    // 2. Company name filter
    if (company_names.length > 0) {
      const orgLower = (raw.organization_name || '').toLowerCase();
      if (!company_names.some(cn => orgLower.includes(cn.toLowerCase()))) continue;
    }

    // 3. Classify category (required before industry filter)
    const { category, confidence } = classifyTender(raw.tender_title, raw.description);
    raw.category = category;

    // 4. Industry filter ONLY — no keyword re-filtering.
    //    Each scraper already searched by keyword. Re-filtering here
    //    incorrectly drops results whose visible text doesn't restate
    //    the search terms (e.g. an ERP tender titled "Business Systems
    //    Implementation" wouldn't contain the word "ERP").
    if (!isIcpRelevant(raw, [], industry)) {
      stats.industry_filtered++;
      continue;
    }

    // 5. Budget threshold
    if (budget_threshold > 0 && raw.budget_usd !== null && raw.budget_usd < budget_threshold) {
      stats.budget_filtered++;
      continue;
    }

    // 6. Deduplication
    if (isDuplicate(raw)) {
      stats.duplicates_removed++;
      continue;
    }

    // 7. Save
    const record = {
      organization_name:         raw.organization_name || 'Unknown',
      tender_title:              raw.tender_title || 'Untitled',
      tender_status:             raw.tender_status || 'Open',
      category:                  raw.category,
      budget:                    raw.budget_usd ? formatBudget(raw.budget_usd) : raw.budget_raw || null,
      budget_usd:                raw.budget_usd || null,
      deadline:                  raw.deadline || null,
      announcement_date:         raw.announcement_date || null,
      source_link:               raw.source_link,
      source:                    raw.source,
      region:                    raw.region,
      country:                   raw.country || raw.buyer_state || null,
      naics_code:                raw.naics_code || null,
      cpv_codes:                 raw.cpv_codes || null,
      bid_number:                raw.bid_number || null,
      classification_confidence: confidence,
      scraped_at:                new Date().toISOString(),
    };

    await dataset.pushData(record);
    savedCount++;
    stats.saved++;

    if (savedCount % 25 === 0) log.info(`Progress: ${savedCount}/${max_results}`);
  }

  // Run summary
  const kvStore = await Actor.openKeyValueStore();
  await kvStore.setValue('RUN_SUMMARY', {
    run_date: new Date().toISOString(),
    input: { keywords, industry, regions, budget_threshold },
    stats,
    sources_used: activeSources.map(s => SOURCE_MAP[s].label),
  });

  log.info('\n╔══════════════════════════════════════════════╗');
  log.info('║              RUN COMPLETE                    ║');
  log.info('╚══════════════════════════════════════════════╝');
  log.info(`Raw collected    : ${stats.total_raw}`);
  log.info(`Expired removed  : ${stats.expired_removed}`);
  log.info(`Budget filtered  : ${stats.budget_filtered}`);
  log.info(`Industry filtered: ${stats.industry_filtered}`);
  log.info(`Duplicates       : ${stats.duplicates_removed}`);
  log.info(`✅ Saved         : ${stats.saved}`);
});
