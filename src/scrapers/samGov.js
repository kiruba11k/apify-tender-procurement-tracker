/**
 * SAM.gov Scraper — US Federal Procurement
 * Uses the official SAM.gov Opportunities API (free, no auth for basic search)
 * Docs: https://open.gsa.gov/api/opportunities-api/
 */

import axios from 'axios';
import { parseDate, parseBudget, cleanText, sleep } from '../utils/helpers.js';

const BASE_URL = 'https://api.sam.gov/opportunities/v2/search';
// Public API key for SAM.gov (free tier, no login required)
const PUBLIC_API_KEY = 'DEMO_KEY'; // Users can replace with their own free key from api.data.gov

export async function scrapeSamGov({ keywords = [], maxResults = 50, proxyUrl = null } = {}) {
  const results = [];

  for (const keyword of (keywords.length ? keywords : ['software', 'technology', 'consulting'])) {
    if (results.length >= maxResults) break;

    try {
      const params = {
        api_key: PUBLIC_API_KEY,
        q: keyword,
        limit: Math.min(25, maxResults - results.length),
        offset: 0,
        postedFrom: getDateDaysAgo(90), // last 90 days
        postedTo: getTodayDate(),
        status: 'active',
        // Filter for relevant notice types
        ntype: 'o,k,r,s,g', // Solicitation, Combined, RFP, Special, Award
      };

      const response = await axios.get(BASE_URL, {
        params,
        timeout: 15000,
        headers: {
          'Accept': 'application/json',
        },
        proxy: proxyUrl ? parseProxyUrl(proxyUrl) : false,
      });

      const opportunities = response.data?.opportunitiesData || [];

      for (const opp of opportunities) {
        const budget = parseBudget(opp.baseType === 'Award' ? opp.award?.amount : null);

        results.push({
          organization_name: cleanText(opp.organizationType || opp.departmentName || opp.subtierName || 'US Federal Agency'),
          tender_title: cleanText(opp.title || ''),
          tender_status: opp.active === 'Yes' ? 'Open' : 'Closed',
          description: cleanText(opp.description || ''),
          category: null, // will be classified later
          budget_usd: budget,
          budget_raw: opp.award?.amount ? String(opp.award.amount) : null,
          deadline: parseDate(opp.responseDeadLine),
          announcement_date: parseDate(opp.postedDate),
          source_link: opp.uiLink || `https://sam.gov/opp/${opp.noticeId}/view`,
          source: 'SAM.gov',
          region: 'US',
          naics_code: opp.naicsCode || null,
          place_of_performance: opp.placeOfPerformance?.state?.name || 'US',
        });
      }

      await sleep(500);
    } catch (err) {
      console.warn(`[SAM.gov] Error for keyword "${keyword}": ${err.message}`);
      // Try fallback HTML scraping if API fails
      const fallback = await samGovHtmlFallback(keyword, maxResults - results.length);
      results.push(...fallback);
    }
  }

  return results;
}

// Fallback: scrape SAM.gov search results page directly
async function samGovHtmlFallback(keyword, limit = 20) {
  try {
    const { load } = await import('cheerio');
    const url = `https://sam.gov/search/?index=opp&page=1&pageSize=${limit}&sort=-modifiedDate&sfm%5Bkeyword%5D=${encodeURIComponent(keyword)}&sfm%5BsimpleSearch%5D%5BkeywordRadio%5D=ALL`;

    const response = await axios.get(url, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
    });

    // SAM.gov is Angular SPA — extract from embedded JSON state
    const html = response.data;
    const jsonMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*({.+?});/s);
    if (!jsonMatch) return [];

    const state = JSON.parse(jsonMatch[1]);
    const opps = state?.opportunities?.opportunitiesData || [];
    return opps.slice(0, limit).map(o => ({
      organization_name: cleanText(o.departmentName || 'US Federal Agency'),
      tender_title: cleanText(o.title || ''),
      tender_status: 'Open',
      description: cleanText(o.description || ''),
      category: null,
      budget_usd: null,
      budget_raw: null,
      deadline: parseDate(o.responseDeadLine),
      announcement_date: parseDate(o.postedDate),
      source_link: `https://sam.gov/opp/${o.noticeId}/view`,
      source: 'SAM.gov',
      region: 'US',
    }));
  } catch {
    return [];
  }
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

function parseProxyUrl(url) {
  try {
    const u = new URL(url);
    return { host: u.hostname, port: parseInt(u.port), auth: u.username ? { username: u.username, password: u.password } : undefined };
  } catch { return false; }
}
