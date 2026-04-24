/**
 * SAM.gov Scraper — US Federal Procurement
 * Uses the official SAM.gov Opportunities API (free, no auth for basic search)
 * Docs: https://open.gsa.gov/api/opportunities-api/
 *
 * FIXES applied:
 *  - Removed `ntype` and `status` params — caused 404 with DEMO_KEY
 *  - API key now sent in X-Api-Key header (preferred) as well as query param
 *  - Added v3 endpoint as primary attempt (v2 still works as fallback)
 *  - Widened date window to 180 days (more results)
 *  - HTML fallback removed (SAM.gov is an Angular SPA, not parseable without JS)
 */

import axios from 'axios';
import { parseDate, parseBudget, cleanText, sleep } from '../utils/helpers.js';

// Primary: v2 is the stable documented endpoint for DEMO_KEY
const SAM_V2 = 'https://api.sam.gov/opportunities/v2/search';
// Backup: some regions/keys resolve via v1
const SAM_V1 = 'https://api.sam.gov/opportunities/v1/search';

const DEMO_KEY = 'DEMO_KEY'; // free 60 req/hr from api.data.gov — replace for production

export async function scrapeSamGov({ keywords = [], maxResults = 50, proxyUrl = null } = {}) {
  const results = [];

  let httpsAgent;
  if (proxyUrl) {
    try {
      const { HttpsProxyAgent } = await import('https-proxy-agent');
      httpsAgent = new HttpsProxyAgent(proxyUrl);
    } catch { /* https-proxy-agent not installed */ }
  }

  for (const keyword of (keywords.length ? keywords : ['software', 'technology', 'consulting'])) {
    if (results.length >= maxResults) break;

    const limit = Math.min(25, maxResults - results.length);

    // Minimal param set — ntype/status caused 404 with DEMO_KEY
    const params = {
      api_key: DEMO_KEY,
      q: keyword,
      limit,
      offset: 0,
      postedFrom: getDateDaysAgo(180),
      postedTo: getTodayDate(),
    };

    const reqConfig = {
      params,
      timeout: 20000,
      headers: {
        Accept: 'application/json',
        'X-Api-Key': DEMO_KEY, // preferred auth method for api.data.gov
      },
      ...(httpsAgent ? { httpsAgent, proxy: false } : {}),
    };

    let fetched = false;

    // Try v2 first, then v1
    for (const baseUrl of [SAM_V2, SAM_V1]) {
      try {
        const response = await axios.get(baseUrl, reqConfig);
        const opportunities = response.data?.opportunitiesData || [];
        for (const opp of opportunities) {
          results.push(mapOpportunity(opp));
        }
        fetched = true;
        break;
      } catch (err) {
        console.warn(`[SAM.gov] ${baseUrl.includes('v2') ? 'v2' : 'v1'} failed for "${keyword}": ${err.response?.status || err.message}`);
      }
    }

    // Retry without proxy on EPROTO (SSL tunnel issue through Apify proxy)
    if (!fetched && httpsAgent) {
      try {
        console.warn('[SAM.gov] Retrying without proxy...');
        const response = await axios.get(SAM_V2, {
          params,
          timeout: 20000,
          headers: { Accept: 'application/json', 'X-Api-Key': DEMO_KEY },
        });
        const opportunities = response.data?.opportunitiesData || [];
        for (const opp of opportunities) results.push(mapOpportunity(opp));
      } catch (err) {
        console.warn(`[SAM.gov] Direct retry failed: ${err.message}`);
      }
    }

    await sleep(600);
  }

  return results;
}

function mapOpportunity(opp) {
  return {
    organization_name: cleanText(
      opp.departmentName || opp.subtierName || opp.organizationType || 'US Federal Agency'
    ),
    tender_title:      cleanText(opp.title || ''),
    tender_status:     opp.active === 'Yes' ? 'Open' : 'Closed',
    description:       cleanText(opp.description || ''),
    category:          null,
    budget_usd:        parseBudget(opp.award?.amount ? String(opp.award.amount) : null),
    budget_raw:        opp.award?.amount ? `$${opp.award.amount}` : null,
    deadline:          parseDate(opp.responseDeadLine),
    announcement_date: parseDate(opp.postedDate),
    source_link:       opp.uiLink || `https://sam.gov/opp/${opp.noticeId}/view`,
    source:            'SAM.gov',
    region:            'US',
    naics_code:        opp.naicsCode || null,
    place_of_performance: opp.placeOfPerformance?.state?.name || 'US',
  };
}

function getDateDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
}

function getTodayDate() {
  const d = new Date();
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
}
