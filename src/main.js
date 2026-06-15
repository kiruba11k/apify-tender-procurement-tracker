import { Actor, log } from 'apify';
import pLimit from 'p-limit';
import { classifyTender, isIcpRelevant, splitKeywords } from './classifiers/categoryClassifier.js';
import { isExpired, isRecentlyClosed, isDuplicate, resetDedup, formatBudget } from './utils/helpers.js';
import { scrapeSamGov } from './scrapers/samGov.js';
import { scrapeTedEuropa } from './scrapers/tedEuropa.js';
import { scrapeGemIndia } from './scrapers/gemIndia.js';
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
    sam_gov: { fn: scrapeSamGov, label: 'SAM.gov' },
    ted_europa: { fn: scrapeTedEuropa, label: 'TED Europa' },
    gem_india: { fn: scrapeGemIndia, label: 'GEM India' },
    find_a_tender_uk: { fn: scrapeFindATender, label: 'Find-a-Tender (UK)' },
    contracts_finder: { fn: scrapeContractsFinder, label: 'Contracts Finder (UK)' },
    ungm: { fn: scrapeUNGM, label: 'UNGM (UN)' },
    worldbank: { fn: scrapeWorldBank, label: 'World Bank' },
    ebrd: { fn: scrapeEBRD, label: 'EBRD' },
    adb: { fn: scrapeADB, label: 'ADB (Asian Dev. Bank)' },
    merx_canada: { fn: scrapeMerxCanada, label: 'MERX Canada' },
    austendering: { fn: scrapeAusTendering, label: 'AusTendering' },
};

// Which sources are relevant for each requested region
const REGION_SOURCES = {
    US: ['sam_gov'],
    EU: ['ted_europa'],
    UK: ['find_a_tender_uk', 'contracts_finder'],
    India: ['gem_india'],
    Canada: ['merx_canada'],
    Australia: ['austendering'],
    // EBRD and ADB endpoints currently return 404/403 on every request
    // (dead/blocked) — excluded to avoid wasted calls; kept implemented
    // in otherSources.js in case the endpoints come back online.
    Global: ['ungm', 'worldbank'],
};

function resolveActiveSources(regions = []) {
    if (!regions.length || regions.includes('Global')) {
        return Object.keys(SOURCE_MAP).filter((key) => key !== 'ebrd' && key !== 'adb');
    }
    const active = new Set();
    for (const region of regions) {
        for (const key of (REGION_SOURCES[region] || [])) active.add(key);
    }
    // Always include the Global/multilateral sources for broader coverage
    for (const key of REGION_SOURCES.Global) active.add(key);
    return [...active];
}

await Actor.main(async () => {
    const input = await Actor.getInput();
    const {
        keywords = [],
        company_names = [],
        industry = 'All',
        regions = ['Global'],
        budget_threshold = 0,
        max_results = 200,
        include_closed = false,
        proxy_config = { useApifyProxy: true },
    } = input || {};

    log.info('🚀 Starting Tender & Procurement Tracker...');

    let proxyUrl = null;
    if (proxy_config?.useApifyProxy) {
        try {
            const proxy = await Actor.createProxyConfiguration(proxy_config);
            proxyUrl = proxy ? await proxy.newUrl() : null;
        } catch (err) {
            log.warning(`Proxy configuration failed, continuing without proxy: ${err.message}`);
        }
    }

    const activeSources = resolveActiveSources(regions);
    log.info(`Active sources for regions [${regions.join(', ')}]: ${activeSources.join(', ')}`);

    const searchTerms = splitKeywords(keywords);
    const effectiveSearchTerms = searchTerms;

    const limiter = pLimit(3);
    const allRaw = [];
    const companyRaw = [];

    const tasks = activeSources.map((sourceKey) =>
        limiter(async () => {
            const src = SOURCE_MAP[sourceKey];
            try {
                // Each scraper applies maxResults as a per-keyword cap, so give it
                // enough headroom to try every search term (the final dataset is
                // still capped at max_results below).
                const perSourceCap = Math.max(max_results, max_results * effectiveSearchTerms.length, 25);
                const items = await src.fn({ keywords: effectiveSearchTerms.length ? effectiveSearchTerms : keywords, maxResults: perSourceCap, proxyUrl });
                log.info(`[${src.label}] Fetched ${items.length} raw tenders`);
                allRaw.push(...items);
            } catch (err) {
                log.error(`[${src.label}] Failed: ${err.message}`);
            }
        })
    );

    // Dedicated search per named company/university — searched on its own
    // (not combined with tech keywords), since portal search engines mostly
    // ignore multi-word queries and just return generic recent results.
    // This lets us find the buyer's *most recent* tender even if it predates
    // the keyword-driven results above.
    const companyTasks = [];
    for (const company of company_names) {
        for (const sourceKey of activeSources) {
            const src = SOURCE_MAP[sourceKey];
            companyTasks.push(
                limiter(async () => {
                    try {
                        const items = await src.fn({ keywords: [company], maxResults: 25, proxyUrl });
                        companyRaw.push(...items.map((it) => ({ ...it, _company: company })));
                    } catch (err) {
                        log.error(`[${src.label}] Company search for "${company}" failed: ${err.message}`);
                    }
                })
            );
        }
    }

    await Promise.all([...tasks, ...companyTasks]);

    resetDedup();
    const dataset = await Actor.openDataset();

    let pushed = 0;
    let droppedExpired = 0;
    let droppedIcp = 0;
    let droppedBudget = 0;
    let droppedDuplicate = 0;
    let droppedCompany = 0;

    const buildOutput = (raw, category, confidence) => ({
        organization_name: raw.organization_name,
        tender_title: raw.tender_title,
        tender_status: raw.tender_status === 'Closed' ? 'Closed' : 'Open',
        category,
        budget: raw.budget_usd != null ? formatBudget(raw.budget_usd) : (raw.budget_raw || null),
        budget_usd: raw.budget_usd ?? null,
        deadline: raw.deadline || null,
        announcement_date: raw.announcement_date || null,
        source_link: raw.source_link,
        source: raw.source,
        region: raw.region || null,
        description: raw.description || '',
        classification_confidence: confidence,
        scraped_at: new Date().toISOString(),
    });

    for (const raw of allRaw) {
        if (!raw || !raw.tender_title || !raw.organization_name) continue;

        // Rule: remove duplicate tenders (same org + title across sources)
        if (isDuplicate(raw)) {
            droppedDuplicate++;
            continue;
        }

        // Rule: remove expired tenders (unless caller wants recently-closed ones too)
        if (isExpired(raw.deadline)) {
            if (!(include_closed && isRecentlyClosed(raw.deadline))) {
                droppedExpired++;
                continue;
            }
            raw.tender_status = 'Closed';
        }

        // Filter: specific buyer/company names — match against organization
        // name AND title/description, since the named company/university is
        // often the beneficiary mentioned in the tender text rather than the
        // contracting authority listed as "buyer".
        if (company_names.length > 0) {
            const haystack = `${raw.organization_name || ''} ${raw.tender_title || ''} ${raw.description || ''}`.toLowerCase();
            if (!company_names.some((cn) => haystack.includes(cn.toLowerCase()))) {
                droppedCompany++;
                continue;
            }
        }

        // Classify category before ICP relevance check (industry → category mapping)
        const { category, confidence } = classifyTender(raw.tender_title, raw.description);
        raw.category = category;

        // Filter: ICP relevance (keywords + industry)
        if (!isIcpRelevant(raw, keywords, industry)) {
            droppedIcp++;
            continue;
        }

        // Rule: exclude low-value tenders below budget_threshold (only when budget is known)
        if (budget_threshold > 0 && raw.budget_usd != null && raw.budget_usd < budget_threshold) {
            droppedBudget++;
            continue;
        }

        await dataset.pushData(buildOutput(raw, category, confidence));
        pushed++;

        if (pushed >= max_results) break;
    }

    // For each named company/university, surface their single most recent
    // tender (by announcement date, falling back to deadline) regardless of
    // the strict expiry/ICP/budget filters above — "most recent tender from
    // this org" is the explicit ask, even if it has since closed.
    if (company_names.length > 0) {
        for (const company of company_names) {
            const companyLower = company.toLowerCase();
            const matches = companyRaw.filter((raw) => {
                if (!raw?.tender_title || !raw?.organization_name) return false;
                const haystack = `${raw.organization_name} ${raw.tender_title} ${raw.description || ''}`.toLowerCase();
                return haystack.includes(companyLower);
            });

            matches.sort((a, b) => {
                const aDate = a.announcement_date || a.deadline || '';
                const bDate = b.announcement_date || b.deadline || '';
                return bDate.localeCompare(aDate);
            });

            const best = matches.find((raw) => !isDuplicate({ ...raw, organization_name: `${raw.organization_name}` }));
            if (best) {
                if (isExpired(best.deadline)) best.tender_status = 'Closed';
                const { category, confidence } = classifyTender(best.tender_title, best.description);
                await dataset.pushData({ ...buildOutput(best, category, confidence), matched_company: company });
                pushed++;
            } else {
                log.info(`No tenders found for company/university: "${company}"`);
            }
        }
    }

    log.info(`✅ Run Complete. Pushed: ${pushed} | Dropped — expired: ${droppedExpired}, duplicate: ${droppedDuplicate}, ICP: ${droppedIcp}, budget: ${droppedBudget}, company: ${droppedCompany}`);
});
