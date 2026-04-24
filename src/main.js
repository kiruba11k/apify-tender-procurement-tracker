import { Actor, log } from 'apify';
import pLimit from 'p-limit';
import dayjs from 'dayjs';
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
    scrapeADB, // This must match the export in otherSources.js
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

await Actor.main(async () => {
    const input = await Actor.getInput();
    const {
        keywords = [],
        company_names = [],
        industry = 'All',
        regions = ['Global'],
        max_results = 100,
        proxy_config = { useApifyProxy: true }
    } = input || {};

    log.info('🚀 Starting Scraper...');

    let proxyUrl = null;
    if (proxy_config?.useApifyProxy) {
        const proxy = await Actor.createProxyConfiguration(proxy_config);
        proxyUrl = await proxy.newUrl();
    }

    const activeSources = Object.keys(SOURCE_MAP);
    const limiter = pLimit(2);
    const allRaw = [];

    const tasks = activeSources.map(sourceKey =>
        limiter(async () => {
            const src = SOURCE_MAP[sourceKey];
            try {
                const items = await src.fn({ keywords, maxResults: max_results, proxyUrl });
                allRaw.push(...items);
            } catch (err) {
                log.error(`[${src.label}] Failed: ${err.message}`);
            }
        })
    );

    await Promise.all(tasks);

    resetDedup();
    const dataset = await Actor.openDataset();

    for (const raw of allRaw) {
        // Strict Company Filter
        if (company_names.length > 0) {
            const orgLower = (raw.organization_name || '').toLowerCase();
            if (!company_names.some(cn => orgLower.includes(cn.toLowerCase()))) continue;
        }

        const { category, confidence } = classifyTender(raw.tender_title, raw.description);
        raw.category = category;

        await dataset.pushData({
            ...raw,
            classification_confidence: confidence,
            scraped_at: new Date().toISOString()
        });
    }

    log.info('✅ Run Complete.');
});
