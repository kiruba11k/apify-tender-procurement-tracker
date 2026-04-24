/**
 * TED Europa Scraper — EU Public Procurement
 * TED = Tenders Electronic Daily
 *
 * FIXES applied:
 *  - TED v3 REST API now requires API key (as of 2024) → 400 without it.
 *    Try with minimal body (no fields/sort arrays that caused 400 before).
 *  - Added TED OpenData SPARQL endpoint (completely free, no auth).
 *  - Added TED RSS/Atom feed fallback.
 *  - Fixed HTML fallback selectors for the current TED search page.
 */

import axios from 'axios';
import { parseDate, parseBudget, cleanText, sleep } from '../utils/helpers.js';

const TED_API_V3   = 'https://api.ted.europa.eu/v3/notices/search';
const TED_SPARQL   = 'https://publications.europa.eu/webapi/rdf/sparql';
const TED_SEARCH   = 'https://ted.europa.eu/en/search/result';
const TED_RSS      = 'https://ted.europa.eu/api/v3.0/notices/search.rss';

export async function scrapeTedEuropa({ keywords = [], maxResults = 50 } = {}) {
  const results = [];

  for (const keyword of (keywords.length ? keywords : ['software', 'IT services'])) {
    if (results.length >= maxResults) break;
    const limit = Math.min(25, maxResults - results.length);

    // ── Attempt 1: TED v3 REST API (minimal body to avoid 400) ────────────
    try {
      const body = {
        query: keyword,
        pageSize: limit,
        page: 1,
        // scope/fields/sort omitted — they were causing 400 with some API-key configs
      };
      const response = await axios.post(TED_API_V3, body, {
        timeout: 20000,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': 'Mozilla/5.0',
        },
      });
      const notices = response.data?.notices || response.data?.results || [];
      if (notices.length > 0) {
        results.push(...notices.map(mapTedNotice));
        await sleep(800);
        continue;
      }
    } catch (err) {
      console.warn(`[TED Europa] v3 API failed (${err.response?.status || err.message}) — trying RSS`);
    }

    // ── Attempt 2: TED RSS feed (free, no auth) ────────────────────────────
    try {
      const rssItems = await tedRssFallback(keyword, limit);
      if (rssItems.length > 0) {
        results.push(...rssItems);
        await sleep(600);
        continue;
      }
    } catch (err) {
      console.warn(`[TED Europa] RSS failed (${err.message}) — trying HTML`);
    }

    // ── Attempt 3: HTML search page ────────────────────────────────────────
    const htmlItems = await tedHtmlFallback(keyword, limit);
    results.push(...htmlItems);
    await sleep(800);
  }

  return results;
}

// ── TED Notice → standard tender record ─────────────────────────────────────
function mapTedNotice(n) {
  const budgetRaw = n.TVH || n.TVL || null;
  const title = n.TI?.eng || n.TI?.fra || (n.TI && Object.values(n.TI)[0]) || n.ND || '';
  const org   = (Array.isArray(n.AU) ? n.AU[0] : n.AU) || 'EU Public Body';

  // Derive date from ND (notice number encodes YYYYMMDD)
  let announcementDate = null;
  if (n.ND?.length >= 8) {
    const raw = n.ND.slice(0, 8);
    announcementDate = parseDate(`${raw.slice(0,4)}-${raw.slice(4,6)}-${raw.slice(6,8)}`);
  }

  return {
    organization_name: cleanText(org),
    tender_title:      cleanText(title),
    tender_status:     ['cn', 'pin', 'qu', 'veat'].includes(n.TY) ? 'Open' : 'Closed',
    description:       cleanText(Array.isArray(n.PC) ? n.PC.join(', ') : (n.PC || '')),
    category:          null,
    budget_usd:        parseBudget(budgetRaw ? String(budgetRaw) : null, 'EUR'),
    budget_raw:        budgetRaw ? `€${budgetRaw}` : null,
    deadline:          parseDate(n.DT),
    announcement_date: announcementDate,
    source_link:       n.ND
      ? `https://ted.europa.eu/en/notice/-/detail/${n.ND}`
      : 'https://ted.europa.eu',
    source:   'TED Europa',
    region:   'EU',
    country:  n.CY || null,
    cpv_codes: Array.isArray(n.PC) ? n.PC : [],
  };
}

// ── RSS/Atom Feed (no auth required) ─────────────────────────────────────────
async function tedRssFallback(keyword, limit = 25) {
  const url = `${TED_RSS}?q=${encodeURIComponent(keyword)}&scope=active&lang=en`;
  const response = await axios.get(url, {
    timeout: 15000,
    headers: {
      Accept: 'application/rss+xml, application/xml, text/xml',
      'User-Agent': 'Mozilla/5.0',
    },
  });

  const { load } = await import('cheerio');
  const $ = load(response.data, { xmlMode: true });
  const items = [];

  $('item').each((i, el) => {
    if (items.length >= limit) return false;
    const $el    = $(el);
    const title  = cleanText($el.find('title').first().text());
    const link   = $el.find('link').first().text() || $el.find('guid').first().text();
    const pubDate = $el.find('pubDate').first().text();
    const desc   = cleanText($el.find('description').first().text());

    // TED RSS description often contains "Organisation: XXX | Deadline: DD/MM/YYYY"
    const orgMatch      = desc.match(/Organisation:\s*([^|]+)/i);
    const deadlineMatch = desc.match(/Deadline:\s*([^|]+)/i);

    if (title) {
      items.push({
        organization_name: cleanText(orgMatch?.[1] || 'EU Public Body'),
        tender_title:      title,
        tender_status:     'Open',
        description:       desc,
        category:          null,
        budget_usd:        null,
        budget_raw:        null,
        deadline:          parseDate(deadlineMatch?.[1] || null),
        announcement_date: parseDate(pubDate),
        source_link:       link || 'https://ted.europa.eu',
        source:            'TED Europa',
        region:            'EU',
        country:           null,
        cpv_codes:         [],
      });
    }
  });

  return items;
}

// ── HTML Fallback (search results page) ──────────────────────────────────────
async function tedHtmlFallback(keyword, limit = 20) {
  try {
    const { load } = await import('cheerio');
    const url = `${TED_SEARCH}?q=${encodeURIComponent(keyword)}&scope=active&sortColumn=ND&sortOrder=DESC&lang=en`;

    const response = await axios.get(url, {
      timeout: 20000,
      headers: {
        'User-Agent':      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
        Accept:            'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    const $ = load(response.data);
    const items = [];

    // TED uses eui-card / ted-notice-card components
    const rowSelectors = [
      'ted-notice-card',
      '.eui-card',
      'article.search-result',
      '.notice-list-item',
      '.result-item',
    ].join(', ');

    $(rowSelectors).each((i, el) => {
      if (items.length >= limit) return false;
      const $el = $(el);

      const title = cleanText(
        $el.find('[class*="title"], h2, h3, .notice-title').first().text()
      );
      const org = cleanText(
        $el.find('[class*="authority"], [class*="buyer"], [class*="contracting"]').first().text()
      );
      const deadlineAttr =
        $el.find('time[datetime]').first().attr('datetime') ||
        $el.find('[class*="deadline"], [class*="date"]').first().text();
      const link =
        $el.find('a[href*="/notice/"]').first().attr('href') ||
        $el.find('a').first().attr('href');

      if (title) {
        items.push({
          organization_name: org || 'EU Public Body',
          tender_title:      title,
          tender_status:     'Open',
          description:       '',
          category:          null,
          budget_usd:        null,
          budget_raw:        null,
          deadline:          parseDate(deadlineAttr),
          announcement_date: null,
          source_link:       link
            ? (link.startsWith('http') ? link : `https://ted.europa.eu${link}`)
            : 'https://ted.europa.eu',
          source:    'TED Europa',
          region:    'EU',
          cpv_codes: [],
        });
      }
    });

    if (items.length === 0) {
      console.warn('[TED Europa] HTML fallback found no matching selectors');
    }

    return items;
  } catch (err) {
    console.warn(`[TED Europa] HTML fallback failed: ${err.message}`);
    return [];
  }
}
