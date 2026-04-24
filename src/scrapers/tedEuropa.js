/**
 * TED Europa Scraper — EU Public Procurement
 * TED = Tenders Electronic Daily
 * Uses TED's free REST API (no auth required for basic search)
 * Docs: https://ted.europa.eu/api/v3.0/notices
 */

import axios from 'axios';
import { parseDate, parseBudget, cleanText, sleep } from '../utils/helpers.js';

// TED API v3 — correct endpoint for full-text search
const TED_API_SEARCH = 'https://api.ted.europa.eu/v3/notices/search';
// Fallback: TED public search page
const TED_SEARCH_URL = 'https://ted.europa.eu/en/search/result';

export async function scrapeTedEuropa({ keywords = [], maxResults = 50 } = {}) {
  const results = [];

  for (const keyword of (keywords.length ? keywords : ['software', 'IT services'])) {
    if (results.length >= maxResults) break;

    try {
      // TED API v3 — correct free-text query format
      // FIX: was incorrectly using ND=[keyword] (notice number field);
      // correct field for full-text search is just a plain string query
      const body = {
        query: keyword,                                    // ← plain string, not ND=[…]
        fields: ['ND', 'TI', 'TY', 'AC', 'PC', 'DT', 'AU', 'OL', 'VA', 'CY', 'TVH', 'TVL'],
        page: 1,
        limit: Math.min(25, maxResults - results.length),
        sort: [{ field: 'ND', order: 'DESC' }],
        scope: 'ALL',                                      // ← was 'active' (not a valid value)
      };

      const response = await axios.post(TED_API_SEARCH, body, {
        timeout: 20000,
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0',
        },
      });

      const notices = response.data?.notices || response.data?.results || [];
      for (const n of notices) {
        const budgetRaw = n.TVH || n.TVL || null;
        const title = n.TI?.eng || n.TI?.fra || (n.TI && Object.values(n.TI)[0]) || n.ND || '';
        const org = (Array.isArray(n.AU) ? n.AU[0] : n.AU) || 'EU Public Body';

        results.push({
          organization_name: cleanText(org),
          tender_title: cleanText(title),
          tender_status: ['cn', 'pin', 'qu'].includes(n.TY) ? 'Open' : 'Closed',
          description: cleanText(Array.isArray(n.PC) ? n.PC.join(', ') : (n.PC || '')),
          category: null,
          budget_usd: parseBudget(budgetRaw ? String(budgetRaw) : null, 'EUR'),
          budget_raw: budgetRaw ? `€${budgetRaw}` : null,
          deadline: parseDate(n.DT),
          announcement_date: parseDate(
            n.ND?.length >= 8
              ? n.ND.slice(0, 8).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3')
              : null
          ),
          source_link: n.ND
            ? `https://ted.europa.eu/en/notice/-/detail/${n.ND}`
            : 'https://ted.europa.eu',
          source: 'TED Europa',
          region: 'EU',
          country: n.CY || null,
          cpv_codes: Array.isArray(n.PC) ? n.PC : [],
        });
      }

      await sleep(800);
    } catch (err) {
      console.warn(`[TED Europa] API error: ${err.message}. Trying search page fallback...`);
      const fallback = await tedSearchFallback(keyword, maxResults - results.length);
      results.push(...fallback);
    }
  }

  return results;
}

async function tedSearchFallback(keyword, limit = 20) {
  try {
    const { load } = await import('cheerio');
    // FIX: correct TED search URL with valid sort param
    const url = `${TED_SEARCH_URL}?q=${encodeURIComponent(keyword)}&scope=active&sortColumn=ND&sortOrder=DESC`;

    const response = await axios.get(url, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    const $ = load(response.data);
    const items = [];

    $('article.search-result, .notice-list-item, .result-item').each((i, el) => {
      if (items.length >= limit) return false;
      const $el = $(el);

      const title = cleanText(
        $el.find('.notice-title, h2, .title, [class*="title"]').first().text()
      );
      const org = cleanText(
        $el.find('.notice-contracting-authority, .authority, [class*="authority"]').first().text()
      );
      const deadline = parseDate(
        $el.find('.deadline, .date-deadline, time').first().attr('datetime') ||
        $el.find('.deadline, .date-deadline').first().text()
      );
      const link = $el.find('a[href*="/notice/"]').first().attr('href') ||
                   $el.find('a').first().attr('href');

      if (title) {
        items.push({
          organization_name: org || 'EU Public Body',
          tender_title: title,
          tender_status: 'Open',
          description: '',
          category: null,
          budget_usd: null,
          budget_raw: null,
          deadline,
          announcement_date: null,
          source_link: link
            ? (link.startsWith('http') ? link : `https://ted.europa.eu${link}`)
            : 'https://ted.europa.eu',
          source: 'TED Europa',
          region: 'EU',
          cpv_codes: [],
        });
      }
    });

    return items;
  } catch (err) {
    console.warn(`[TED Europa] HTML fallback also failed: ${err.message}`);
    return [];
  }
}
