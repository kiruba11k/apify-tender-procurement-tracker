/**
 * TED Europa Scraper — EU Public Procurement
 * TED = Tenders Electronic Daily
 * Uses TED's free REST API (no auth required for basic search)
 * Docs: https://ted.europa.eu/api/v3.0/notices
 */

import axios from 'axios';
import { parseDate, parseBudget, cleanText, sleep } from '../utils/helpers.js';

const TED_API = 'https://api.ted.europa.eu/v3/notices/search';
const TED_SEARCH_URL = 'https://ted.europa.eu/en/search/result';

export async function scrapeTedEuropa({ keywords = [], maxResults = 50 } = {}) {
  const results = [];

  for (const keyword of (keywords.length ? keywords : ['software', 'IT services'])) {
    if (results.length >= maxResults) break;
    try {
      // TED API v3 — free, no key required
      const body = {
        query: `ND=[${keyword}] OR TI=[${keyword}]`,
        fields: ['ND', 'TI', 'TY', 'AC', 'PC', 'DT', 'AU', 'OL', 'VA', 'CY', 'TVH', 'TVL'],
        page: 1,
        limit: Math.min(25, maxResults - results.length),
        sort: [{ field: 'ND', order: 'DESC' }],
        scope: 'active',
      };

      const response = await axios.post(TED_API, body, {
        timeout: 20000,
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      });

      const notices = response.data?.notices || [];
      for (const n of notices) {
        const budgetRaw = n.TVH || n.TVL || null;
        results.push({
          organization_name: cleanText(n.AU?.[0] || n.ND?.split('-')?.[2] || 'EU Public Body'),
          tender_title: cleanText(n.TI?.eng || n.TI?.fra || Object.values(n.TI || {})[0] || ''),
          tender_status: n.TY === 'cn' ? 'Open' : n.TY === 'can' ? 'Closed' : 'Open',
          description: cleanText(n.PC?.join(', ') || ''),
          category: null,
          budget_usd: parseBudget(budgetRaw, 'EUR'),
          budget_raw: budgetRaw ? `€${budgetRaw}` : null,
          deadline: parseDate(n.DT),
          announcement_date: parseDate(n.ND?.slice(0, 8).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3')),
          source_link: `https://ted.europa.eu/en/notice/-/detail/${n.ND}`,
          source: 'TED Europa',
          region: 'EU',
          country: n.CY || null,
          cpv_codes: n.PC || [],
        });
      }
      await sleep(800);
    } catch (err) {
      console.warn(`[TED Europa] API error: ${err.message}. Trying search page...`);
      const fallback = await tedSearchFallback(keyword, maxResults - results.length);
      results.push(...fallback);
    }
  }

  return results;
}

async function tedSearchFallback(keyword, limit = 20) {
  try {
    const { load } = await import('cheerio');
    const url = `${TED_SEARCH_URL}?q=${encodeURIComponent(keyword)}&scope=active&sortBy=ND&sortOrder=DESC`;
    const response = await axios.get(url, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
        'Accept': 'text/html',
      },
    });

    const $ = load(response.data);
    const items = [];

    $('article.search-result, .notice-list-item').each((i, el) => {
      if (items.length >= limit) return false;
      const $el = $(el);
      const title = cleanText($el.find('.notice-title, h2, .title').first().text());
      const org = cleanText($el.find('.notice-contracting-authority, .authority').first().text());
      const deadline = parseDate($el.find('.deadline, .date-deadline').first().text());
      const link = $el.find('a').first().attr('href');

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
          source_link: link ? (link.startsWith('http') ? link : `https://ted.europa.eu${link}`) : 'https://ted.europa.eu',
          source: 'TED Europa',
          region: 'EU',
        });
      }
    });

    return items;
  } catch {
    return [];
  }
}
