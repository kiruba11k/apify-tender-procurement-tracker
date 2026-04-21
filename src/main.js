/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║        TENDER & PROCUREMENT TRACKER — Apify Actor                   ║
 * ║  Multi-source • AI-classified • ICP-filtered • Global coverage       ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 *
 * Sources:
 *   SAM.gov (US Federal)    · TED Europa (EU)       · GEM India
 *   Find-a-Tender (UK)      · UNGM (UN)             · World Bank
 *   MERX Canada             · AusTendering          · Devex
 *
 * Architecture:
 *   Parallel scraping → Classification → ICP filtering →
 *   Budget filtering → Deduplication → Sorted output
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

// ── Source registry ─────────────────────────────────────────────────────────

const SOURCE_MAP = {
  sam_gov:           { fn: scrapeSamGov,       region: 'US',        label: 'SAM.gov (US Federal)' },
  ted_europa:        { fn: scrapeTedEuropa,     region: 'EU',        label: 'TED Europa (EU)' },
  gem_india:         { fn: scrapeGemIndia,      region: 'India',     label: 'GEM India' },
  find_a_tender_uk:  { fn: scrapeFindATender,   region: 'UK',        label: 'Find-a-Tender (UK)' },
  ungm:              { fn: scrapeUNGM,          region: 'Global',    label: 'UNGM (UN)' },
  worldbank:         { fn: scrapeWorldBank,     region: 'Global',    label: 'World Bank' },
  merx_canada:       { fn: scrapeMerxCanada,    region: 'Canada',    label: 'MERX Canada' },
  austendering:      { fn: scrapeAusTendering,  region: 'Australia', label: 'AusTendering' },
  devex:             { fn: scrapeDevex,         region: 'Global',    label: 'Devex' },
};

// ── Main ─────────────────────────────────────────────────────────────────────

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
    sources = ['sam_gov', 'ted_europa', 'gem_india', 'find_a_tender_uk', 'ungm', 'worldbank'],
    proxy_config = { useApifyProxy: true },
  } = input || {};

  log.info('╔══════════════════════════════════════════════╗');
  log.info('║   Tender & Procurement Tracker — Starting    ║');
  log.info('╚══════════════════════════════════════════════╝');
  log.info(`Keywords: ${keywords.join(', ') || '(none — broad search)'}`);
  log.info(`Regions: ${regions.join(', ')}`);
  log.info(`Sources: ${sources.join(', ')}`);
  log.info(`Budget threshold: $${budget_threshold.toLocaleString()}`);

  // Resolve proxy
  let proxyUrl = null;
  try {
    if (proxy_config?.useApifyProxy) {
      const proxyConfig = await Actor.createProxyConfiguration(proxy_config);
      proxyUrl = await proxyConfig.newUrl();
    }
  } catch {
    log.warning('Proxy init failed, running without proxy');
  }

  // Determine active sources by region filter
  const activeSources = sources.filter(s => {
    const src = SOURCE_MAP[s];
    if (!src) return false;
    if (regions.includes('Global')) return true;
    return regions.includes(src.region) || src.region === 'Global';
  });

  log.info(`Active sources after region filter: ${activeSources.join(', ')}`);

  // ── Parallel scraping with concurrency limit ───────────────────────────────
  const limiter = pLimit(3); // max 3 concurrent scrapers
  const perSourceLimit = Math.ceil(max_results / activeSources.length) + 20; // buffer

  const scrapeArgs = { keywords, maxResults: perSourceLimit, proxyUrl };
  const allRaw = [];

  const tasks = activeSources.map(sourceKey =>
    limiter(async () => {
      const src = SOURCE_MAP[sourceKey];
      log.info(`[${src.label}] Starting scrape...`);
      try {
        const items = await src.fn(scrapeArgs);
        log.info(`[${src.label}] ✓ ${items.length} items fetched`);
        allRaw.push(...items);
      } catch (err) {
        log.error(`[${src.label}] ✗ Fatal error: ${err.message}`);
      }
    })
  );

  await Promise.all(tasks);
  log.info(`\nTotal raw items collected: ${allRaw.length}`);

  // ── Post-processing pipeline ───────────────────────────────────────────────
  resetDedup();
  const dataset = await Actor.openDataset();
  let savedCount = 0;
  const stats = { total_raw: allRaw.length, expired_removed: 0, budget_filtered: 0, icp_filtered: 0, duplicates_removed: 0, saved: 0 };

  // Sort: open first, then by announcement date desc
  const sorted = allRaw.sort((a, b) => {
    if (a.tender_status === 'Open' && b.tender_status !== 'Open') return -1;
    if (b.tender_status === 'Open' && a.tender_status !== 'Open') return 1;
    const da = dayjs(a.announcement_date || '2000-01-01');
    const db = dayjs(b.announcement_date || '2000-01-01');
    return db.valueOf() - da.valueOf();
  });

  for (const raw of sorted) {
    if (savedCount >= max_results) break;

    // ── 1. Expired filter ──
    if (!include_closed && isExpired(raw.deadline)) {
      // Allow recently-closed (within 7 days) if status is Open
      if (!isRecentlyClosed(raw.deadline, 7)) {
        stats.expired_removed++;
        continue;
      }
      raw.tender_status = 'Closed';
    }

    // ── 2. Company name filter ──
    if (company_names.length > 0) {
      const orgLower = (raw.organization_name || '').toLowerCase();
      const match = company_names.some(cn => orgLower.includes(cn.toLowerCase()));
      if (!match) continue;
    }

    // ── 3. Classify category ──
    const { category, confidence } = classifyTender(raw.tender_title, raw.description);
    raw.category = category;

    // ── 4. ICP relevance filter ──
    if (!isIcpRelevant(raw, keywords, industry)) {
      stats.icp_filtered++;
      continue;
    }

    // ── 5. Budget threshold filter ──
    if (budget_threshold > 0 && raw.budget_usd !== null && raw.budget_usd < budget_threshold) {
      stats.budget_filtered++;
      continue;
    }

    // ── 6. Deduplication ──
    if (isDuplicate(raw)) {
      stats.duplicates_removed++;
      continue;
    }

    // ── 7. Build clean output record ──
    const record = {
      organization_name: raw.organization_name || 'Unknown',
      tender_title: raw.tender_title || 'Untitled',
      tender_status: raw.tender_status || 'Open',
      category: raw.category,
      budget: raw.budget_usd ? formatBudget(raw.budget_usd) : raw.budget_raw || null,
      budget_usd: raw.budget_usd || null,
      deadline: raw.deadline || null,
      announcement_date: raw.announcement_date || null,
      source_link: raw.source_link,
      source: raw.source,
      region: raw.region,
      // Enrichment fields
      country: raw.country || raw.buyer_state || null,
      naics_code: raw.naics_code || null,
      cpv_codes: raw.cpv_codes || null,
      bid_number: raw.bid_number || null,
      classification_confidence: confidence,
      scraped_at: new Date().toISOString(),
    };

    await dataset.pushData(record);
    savedCount++;
    stats.saved++;

    // Live progress log every 25 items
    if (savedCount % 25 === 0) {
      log.info(`Progress: ${savedCount}/${max_results} saved`);
    }
  }

  // ── Key-value store: run summary ───────────────────────────────────────────
  const kvStore = await Actor.openKeyValueStore();
  const summary = {
    run_date: new Date().toISOString(),
    input: { keywords, industry, regions, budget_threshold, sources: activeSources },
    stats,
    sources_used: activeSources.map(s => SOURCE_MAP[s].label),
  };
  await kvStore.setValue('RUN_SUMMARY', summary);

  // ── Final log ──────────────────────────────────────────────────────────────
  log.info('\n╔══════════════════════════════════════════════╗');
  log.info('║              RUN COMPLETE                    ║');
  log.info('╚══════════════════════════════════════════════╝');
  log.info(`Raw collected  : ${stats.total_raw}`);
  log.info(`Expired removed: ${stats.expired_removed}`);
  log.info(`Budget filtered: ${stats.budget_filtered}`);
  log.info(`ICP filtered   : ${stats.icp_filtered}`);
  log.info(`Duplicates     : ${stats.duplicates_removed}`);
  log.info(`✅ Saved to dataset: ${stats.saved}`);
});
