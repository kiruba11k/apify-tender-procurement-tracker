/**
 * Multi-source scraper bundle — FIXED & EXPANDED
 *
 * Sources:
 *  - UK Find-a-Tender  (OCDS API + HTML fallback)
 *  - UK Contracts Finder (NEW — replaces Devex)
 *  - UNGM — United Nations Global Marketplace (HTML)
 *  - World Bank Procurement (corrected API)
 *  - MERX Canada
 *  - AusTendering (Australian government)
 *  - EBRD — European Bank for Reconstruction & Development (NEW — JSON API)
 *  - ADB — Asian Development Bank (NEW — HTML)
 *
 * FIXES:
 *  - Find-a-Tender: OCDS param changed from `q` → `hasKeyword`; HTML org selector fixed
 *  - UNGM: replaced broken JSON API with HTML scraping + correct page URL
 *  - World Bank: endpoint changed to procurement.worldbank.org + HTML fallback
 *  - Devex (403/paywalled): replaced with UK Contracts Finder
 *  - EBRD: new JSON API (no auth required)
 *  - ADB: new HTML scraper
 */

import axios from 'axios';
import { parseDate, parseBudget, cleanText, sleep } from '../utils/helpers.js';

// ════════════════════════════════════════════════════
// UK FIND-A-TENDER (FTS / OCDS API)
//
// FIX: param is `hasKeyword` (not `q`) — the old param caused 400.
//      HTML fallback org selector fixed (was always "UK Public Body").
// ════════════════════════════════════════════════════
export async function scrapeFindATender({ keywords = [], maxResults = 30 } = {}) {
  const results = [];

  for (const keyword of (keywords.length ? keywords : ['technology', 'software'])) {
    if (results.length >= maxResults) break;
    const limit = Math.min(25, maxResults - results.length);

    // OCDS Release Packages endpoint — correct param is `hasKeyword`
    try {
      const url = `https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages?hasKeyword=${encodeURIComponent(keyword)}&limit=${limit}`;
      const response = await axios.get(url, {
        timeout: 15000,
        headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
      });

      const releases = response.data?.releases || [];
      for (const r of releases) {
        const tender = r.tender || {};
        const buyer  = r.buyer  || {};
        const budget = tender.value?.amount;
        results.push({
          organization_name: cleanText(buyer.name || r.parties?.[0]?.name || 'UK Public Body'),
          tender_title:      cleanText(tender.title || r.id || ''),
          tender_status:     tender.status === 'active' ? 'Open' : 'Closed',
          description:       cleanText(tender.description || ''),
          category:          null,
          budget_usd:        parseBudget(budget ? String(budget) : null, tender.value?.currency || 'GBP'),
          budget_raw:        budget ? `${tender.value?.currency || 'GBP'} ${budget}` : null,
          deadline:          parseDate(tender.tenderPeriod?.endDate),
          announcement_date: parseDate(r.date || tender.tenderPeriod?.startDate),
          source_link:       `https://www.find-tender.service.gov.uk/Notice/${r.id?.replace(/\//g, '')}`,
          source:            'Find-a-Tender UK',
          region:            'UK',
          cpv_codes:         tender.items?.map(i => i.classification?.id).filter(Boolean) || [],
        });
      }
      if (releases.length > 0) { await sleep(600); continue; }
    } catch (err) {
      console.warn(`[Find-a-Tender] OCDS API error (${err.response?.status || err.message})`);
    }

    // HTML fallback
    const fallback = await fatHtmlFallback(keyword, limit);
    results.push(...fallback);
    await sleep(600);
  }
  return results;
}

async function fatHtmlFallback(keyword, limit = 20) {
  try {
    const { load } = await import('cheerio');
    const url = `https://www.find-tender.service.gov.uk/Search/Results?Keywords=${encodeURIComponent(keyword)}`;
    const res = await axios.get(url, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Accept: 'text/html',
      },
    });

    const $ = load(res.data);
    const items = [];

    // Find-a-Tender uses GOV.UK design — results are in <article> or <li> rows
    // Each notice has a link, contracting authority, and closing date in a <dl>
    $('article, .search-result-entry, li.tender-result, div[class*="search-result"]').each((i, el) => {
      if (items.length >= limit) return false;
      const $el = $(el);

      const title = cleanText($el.find('h2 a, h3 a, .notice-title a, a[href*="/Notice/"]').first().text())
                 || cleanText($el.find('h2, h3').first().text());

      // Contracting authority is often in a <dd> after a "Contracting authority" <dt>
      const org = cleanText(
        $el.find('dd').filter((_, dd) => {
          const dt = $(dd).prev('dt');
          return /authority|buyer|organisation/i.test(dt.text());
        }).first().text()
      ) || cleanText($el.find('[class*="authority"], [class*="buyer"], .contracting-body').first().text());

      const deadlineRaw =
        $el.find('time[datetime]').first().attr('datetime') ||
        $el.find('dd').filter((_, dd) => /closing|deadline/i.test($(dd).prev('dt').text())).first().text() ||
        $el.find('[class*="deadline"], [class*="close"]').first().text();

      const link =
        $el.find('a[href*="/Notice/"]').first().attr('href') ||
        $el.find('a').first().attr('href');

      if (title) items.push({
        organization_name: org || 'UK Public Body',
        tender_title:      title,
        tender_status:     'Open',
        description:       '',
        category:          null,
        budget_usd:        null,
        budget_raw:        null,
        deadline:          parseDate(deadlineRaw),
        announcement_date: null,
        source_link: link
          ? (link.startsWith('http') ? link : `https://www.find-tender.service.gov.uk${link}`)
          : 'https://www.find-tender.service.gov.uk',
        source:    'Find-a-Tender UK',
        region:    'UK',
        cpv_codes: [],
      });
    });

    return items;
  } catch (err) {
    console.warn(`[Find-a-Tender] HTML fallback failed: ${err.message}`);
    return [];
  }
}

// ════════════════════════════════════════════════════
// UK CONTRACTS FINDER (NEW — replaces Devex)
// GOV.UK platform for contracts below OJEU thresholds
// API: no auth required — uses public JSON search
// ════════════════════════════════════════════════════
export async function scrapeContractsFinder({ keywords = [], maxResults = 30 } = {}) {
  const results = [];

  for (const keyword of (keywords.length ? keywords : ['technology', 'software'])) {
    if (results.length >= maxResults) break;

    // Contracts Finder Open Data API (no auth, OCDS-compatible)
    try {
      const url = `https://www.contractsfinder.service.gov.uk/Published/Notices/PublishedSearchResults?NoticeType=0&Page=1&Sort=5&SortDirection=1&PageSize=${Math.min(20, maxResults - results.length)}&Keywords=${encodeURIComponent(keyword)}&Status=published`;

      const response = await axios.get(url, {
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          Accept: 'text/html, application/xhtml+xml',
          'Accept-Language': 'en-GB,en;q=0.9',
        },
      });

      const { load } = await import('cheerio');
      const $ = load(response.data);

      $('article, .search-result, li[class*="result"]').each((_, el) => {
        if (results.length >= maxResults) return false;
        const $el = $(el);

        const title = cleanText($el.find('h2 a, .notice-title, a[href*="/Notice/"]').first().text())
                   || cleanText($el.find('h2, h3').first().text());
        const org = cleanText(
          $el.find('[class*="authority"], [class*="buyer"], [class*="organisation"]').first().text()
        );
        const budgetRaw = cleanText($el.find('[class*="value"], [class*="budget"]').first().text());
        const deadlineRaw =
          $el.find('time[datetime]').first().attr('datetime') ||
          $el.find('[class*="deadline"], [class*="date"]').first().text();
        const link =
          $el.find('a[href*="/Notice/"]').first().attr('href') ||
          $el.find('a').first().attr('href');

        if (title) results.push({
          organization_name: org || 'UK Public Body',
          tender_title:      title,
          tender_status:     'Open',
          description:       '',
          category:          null,
          budget_usd:        parseBudget(budgetRaw, 'GBP'),
          budget_raw:        budgetRaw || null,
          deadline:          parseDate(deadlineRaw),
          announcement_date: null,
          source_link: link
            ? (link.startsWith('http') ? link : `https://www.contractsfinder.service.gov.uk${link}`)
            : 'https://www.contractsfinder.service.gov.uk',
          source: 'Contracts Finder UK',
          region: 'UK',
          cpv_codes: [],
        });
      });
    } catch (err) {
      console.warn(`[Contracts Finder] Error for "${keyword}": ${err.message}`);
    }
    await sleep(700);
  }
  return results;
}

// ════════════════════════════════════════════════════
// UNGM — United Nations Global Marketplace
//
// FIX: /Public/Notice/SearchPublicNotices and /api/Notice/... both 404.
//      Now uses HTML scraping on the public notices listing page.
//      The UNGM search form POSTs to the same page — replicated below.
// ════════════════════════════════════════════════════
export async function scrapeUNGM({ keywords = [], maxResults = 30 } = {}) {
  const results = [];

  for (const keyword of (keywords.length ? keywords : ['IT services', 'software'])) {
    if (results.length >= maxResults) break;

    // Try form-based POST (UNGM search form submits to this endpoint)
    let fetched = false;
    const postEndpoints = [
      'https://www.ungm.org/Public/Notice/SearchPublicNotices',
      'https://www.ungm.org/Public/Notice',
    ];

    for (const endpoint of postEndpoints) {
      try {
        const body = {
          Title: keyword,
          Description: '',
          Reference: '',
          Beneficiary: '',
          AgencyId: 0,
          DeadlineFrom: '',
          DeadlineTo: '',
          NoticeType: 0,
          PageIndex: 0,
          PageSize: Math.min(20, maxResults - results.length),
        };

        const response = await axios.post(endpoint, body, {
          timeout: 20000,
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/html, */*',
            Referer: 'https://www.ungm.org/Public/Notice',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          },
        });

        // Accept both JSON array and HTML responses
        if (response.headers['content-type']?.includes('json')) {
          const raw = response.data;
          const noticeArray = Array.isArray(raw) ? raw
            : (raw?.Notices || raw?.notices || []);
          for (const n of noticeArray.slice(0, maxResults - results.length)) {
            results.push(mapUNGMNotice(n));
          }
          fetched = noticeArray.length > 0;
        }
        if (fetched) break;
      } catch (err) {
        console.warn(`[UNGM] POST ${endpoint} failed: ${err.response?.status || err.message}`);
      }
    }

    // HTML fallback — public notice listing
    if (!fetched) {
      const htmlItems = await ungmHtmlFallback(keyword, maxResults - results.length);
      results.push(...htmlItems);
    }

    await sleep(700);
  }
  return results;
}

function mapUNGMNotice(n) {
  return {
    organization_name: cleanText(n.AgencyName || n.Organization || 'UN Agency'),
    tender_title:      cleanText(n.Title || n.title || ''),
    tender_status:     n.IsClosed ? 'Closed' : 'Open',
    description:       cleanText(n.Description || ''),
    category:          null,
    budget_usd:        null,
    budget_raw:        null,
    deadline:          parseDate(n.Deadline || n.deadline),
    announcement_date: parseDate(n.PublishedOn || n.publishedDate),
    source_link:       n.NoticeId
      ? `https://www.ungm.org/Public/Notice/${n.NoticeId}`
      : 'https://www.ungm.org/Public/Notice',
    source: 'UNGM',
    region: 'Global',
  };
}

async function ungmHtmlFallback(keyword, limit = 15) {
  try {
    const { load } = await import('cheerio');
    // The UNGM search page — keyword is passed as query param
    const url = `https://www.ungm.org/Public/Notice?Keywords=${encodeURIComponent(keyword)}`;
    const res = await axios.get(url, {
      timeout: 20000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        Accept: 'text/html',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    const $ = load(res.data);
    const items = [];

    // UNGM renders results in table rows or card divs
    $('table tbody tr, .notice-item, .tender-row, div[class*="notice"]').each((i, el) => {
      if (items.length >= limit) return false;
      const $el = $(el);

      const title    = cleanText($el.find('td:nth-child(2) a, .notice-title, h3 a').first().text())
                    || cleanText($el.find('a').first().text());
      const org      = cleanText($el.find('td:nth-child(3), .agency-name').first().text());
      const deadline = parseDate(
        $el.find('td:nth-child(4), .deadline, time').first().attr('datetime') ||
        $el.find('td:nth-child(4), .deadline').first().text()
      );
      const link = $el.find('a').first().attr('href');

      if (title) items.push({
        organization_name: org || 'UN Agency',
        tender_title:      title,
        tender_status:     'Open',
        description:       '',
        category:          null,
        budget_usd:        null,
        budget_raw:        null,
        deadline,
        announcement_date: null,
        source_link: link
          ? (link.startsWith('http') ? link : `https://www.ungm.org${link}`)
          : 'https://www.ungm.org/Public/Notice',
        source: 'UNGM',
        region: 'Global',
      });
    });

    return items;
  } catch (err) {
    console.warn(`[UNGM] HTML fallback failed: ${err.message}`);
    return [];
  }
}

// ════════════════════════════════════════════════════
// WORLD BANK — Open Procurement
//
// FIX: search.worldbank.org/api/v3/procurement → 404
//       search.worldbank.org/api/v2/procurement → 404
//       search.worldbank.org/api/v2/projects    → 500 for long queries
//
// NEW APPROACH:
//  1. procurement.worldbank.org JSON API (current portal)
//  2. search.worldbank.org/api/v2/projects with short keywords (still works)
//  3. HTML scrape of World Bank projects search as final fallback
// ════════════════════════════════════════════════════
export async function scrapeWorldBank({ keywords = [], maxResults = 30 } = {}) {
  const results = [];

  for (const keyword of (keywords.length ? keywords : ['technology', 'consulting'])) {
    if (results.length >= maxResults) break;
    const limit = Math.min(20, maxResults - results.length);
    let fetched = false;

    // ── Attempt 1: Procurement portal API (new endpoint) ──────────────────
    const procEndpoints = [
      `https://procurement.worldbank.org/api/v3/opportunities?searchText=${encodeURIComponent(keyword)}&rows=${limit}&os=0&format=json`,
      `https://procurement.worldbank.org/api/notices?q=${encodeURIComponent(keyword)}&limit=${limit}&format=json`,
    ];

    for (const url of procEndpoints) {
      try {
        const response = await axios.get(url, {
          timeout: 15000,
          headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
        });
        const docs = response.data?.notices?.docs
          || response.data?.procurement?.docs
          || response.data?.results
          || response.data?.docs
          || [];
        if (docs.length > 0) {
          results.push(...docs.slice(0, limit).map(mapWorldBankDoc));
          fetched = true;
          break;
        }
      } catch (err) {
        console.warn(`[World Bank] ${url.slice(0, 60)}... failed: ${err.response?.status || err.message}`);
      }
    }

    // ── Attempt 2: Projects search API (works for short keywords) ─────────
    if (!fetched) {
      try {
        const url = `https://search.worldbank.org/api/v2/projects?format=json&qterm=${encodeURIComponent(keyword)}&rows=${limit}&os=0&fl=project_name,borrower,closingdate,totalcommamt,url,project_ctry_name,boardapprovaldate,sector1`;
        const response = await axios.get(url, {
          timeout: 15000,
          headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
        });
        const docs = response.data?.projects?.docs || response.data?.docs || [];
        if (docs.length > 0) {
          results.push(...docs.slice(0, limit).map(d => ({
            organization_name: cleanText(d.borrower || 'World Bank Project'),
            tender_title:      cleanText(d.project_name || ''),
            tender_status:     'Open',
            description:       cleanText(d.sector1 || ''),
            category:          null,
            budget_usd:        parseBudget(d.totalcommamt ? String(d.totalcommamt) : null, 'USD'),
            budget_raw:        d.totalcommamt ? `$${d.totalcommamt}` : null,
            deadline:          parseDate(d.closingdate),
            announcement_date: parseDate(d.boardapprovaldate),
            source_link:       d.url || 'https://projects.worldbank.org',
            source:            'World Bank',
            region:            'Global',
            country:           d.project_ctry_name || null,
          })));
          fetched = true;
        }
      } catch (err) {
        console.warn(`[World Bank] Projects API failed: ${err.response?.status || err.message}`);
      }
    }

    // ── Attempt 3: HTML fallback ───────────────────────────────────────────
    if (!fetched) {
      const htmlItems = await worldBankHtmlFallback(keyword, limit);
      results.push(...htmlItems);
    }

    await sleep(600);
  }
  return results;
}

function mapWorldBankDoc(d) {
  return {
    organization_name: cleanText(
      d.contact_org_name || d.borrower || d.procurement_group || 'World Bank Project'
    ),
    tender_title:      cleanText(d.bid_description || d.project_name || d.title || ''),
    tender_status:     'Open',
    description:       cleanText(d.notice_type || d.sector || ''),
    category:          null,
    budget_usd:        parseBudget(
      d.totalamt ? String(d.totalamt) : d.totalcommamt ? String(d.totalcommamt) : null, 'USD'
    ),
    budget_raw:        d.totalamt ? `$${d.totalamt}` : null,
    deadline:          parseDate(d.deadline_dt || d.closingdate),
    announcement_date: parseDate(d.disclosure_date || d.boardapprovaldate),
    source_link:       d.url || 'https://projects.worldbank.org/en/projects-operations/procurement',
    source:            'World Bank',
    region:            'Global',
    country:           d.project_ctry_name || null,
  };
}

async function worldBankHtmlFallback(keyword, limit = 15) {
  try {
    const { load } = await import('cheerio');
    const url = `https://projects.worldbank.org/en/projects-operations/procurement?qterm=${encodeURIComponent(keyword)}&type=1`;
    const res = await axios.get(url, {
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html' },
    });
    const $ = load(res.data);
    const items = [];
    $('table tbody tr, .project-row, .search-result').each((i, el) => {
      if (items.length >= limit) return false;
      const $el = $(el);
      const title = cleanText($el.find('td:nth-child(2) a, .project-title').first().text());
      const org   = cleanText($el.find('td:nth-child(3), .borrower').first().text());
      const link  = $el.find('a').first().attr('href');
      if (title) items.push({
        organization_name: org || 'World Bank Project',
        tender_title:      title,
        tender_status:     'Open',
        description:       '',
        category:          null,
        budget_usd:        null,
        budget_raw:        null,
        deadline:          null,
        announcement_date: null,
        source_link: link
          ? (link.startsWith('http') ? link : `https://projects.worldbank.org${link}`)
          : 'https://projects.worldbank.org',
        source:  'World Bank',
        region:  'Global',
        country: null,
      });
    });
    return items;
  } catch { return []; }
}

// ════════════════════════════════════════════════════
// MERX Canada (unchanged — was working)
// ════════════════════════════════════════════════════
export async function scrapeMerxCanada({ keywords = [], maxResults = 25 } = {}) {
  const results = [];
  try {
    const { load } = await import('cheerio');
    for (const keyword of (keywords.length ? keywords : ['IT', 'software'])) {
      if (results.length >= maxResults) break;
      const url = `https://www.merx.com/English/BUYER_Menu.cfm?WCE=Free&TMT=Free&hcode=&SearchScope=gov&SearchText=${encodeURIComponent(keyword)}&pageNum=1`;
      const response = await axios.get(url, {
        timeout: 15000,
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', Accept: 'text/html' },
      });
      const $ = load(response.data);
      $('.search-result-row, table tr:not(:first-child)').each((i, el) => {
        if (results.length >= maxResults) return false;
        const $el = $(el);
        const title    = cleanText($el.find('td:nth-child(2) a, .bid-title').first().text());
        const org      = cleanText($el.find('td:nth-child(3), .org').first().text());
        const deadline = parseDate($el.find('td:nth-child(5), .deadline').first().text());
        const link     = $el.find('a').first().attr('href');
        if (title) results.push({
          organization_name: org || 'Canadian Government',
          tender_title: title, tender_status: 'Open', description: '', category: null,
          budget_usd: null, budget_raw: null, deadline, announcement_date: null,
          source_link: link
            ? (link.startsWith('http') ? link : `https://www.merx.com${link}`)
            : 'https://www.merx.com',
          source: 'MERX Canada', region: 'Canada',
        });
      });
      await sleep(1000);
    }
  } catch (err) {
    console.warn(`[MERX Canada] Error: ${err.message}`);
  }
  return results;
}

// ════════════════════════════════════════════════════
// AusTendering — Australian Government Tenders
// FIX: JSON API 403 — HTML fallback improved
// ════════════════════════════════════════════════════
export async function scrapeAusTendering({ keywords = [], maxResults = 25 } = {}) {
  const results = [];
  for (const keyword of (keywords.length ? keywords : ['IT', 'technology'])) {
    if (results.length >= maxResults) break;
    try {
      const url = `https://www.tenders.gov.au/Atm/ShowJson?Keywords=${encodeURIComponent(keyword)}&Status=Current&Page=1&Size=${Math.min(20, maxResults - results.length)}`;
      const response = await axios.get(url, {
        timeout: 15000,
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
      });
      const tenders = response.data?.ATMs || response.data?.results || [];
      for (const t of tenders) {
        results.push({
          organization_name: cleanText(t.AgencyName || t.agency || 'Australian Government'),
          tender_title:      cleanText(t.Description || t.title || ''),
          tender_status:     'Open',
          description:       cleanText(t.Category || ''),
          category:          null,
          budget_usd:        parseBudget(t.ContractValue || t.value, 'AUD'),
          budget_raw:        t.ContractValue ? `AUD ${t.ContractValue}` : null,
          deadline:          parseDate(t.CloseDate || t.deadline),
          announcement_date: parseDate(t.PublishedDate || t.published),
          source_link:       t.ATMID ? `https://www.tenders.gov.au/Atm/Show/${t.ATMID}` : 'https://www.tenders.gov.au',
          source: 'AusTendering', region: 'Australia',
        });
      }
    } catch (err) {
      console.warn(`[AusTendering] JSON API error (${err.response?.status || err.message}), using HTML fallback`);
      const fallback = await ausTenderingHtmlFallback(keyword, maxResults - results.length);
      results.push(...fallback);
    }
    await sleep(700);
  }
  return results;
}

async function ausTenderingHtmlFallback(keyword, limit = 15) {
  try {
    const { load } = await import('cheerio');
    const url = `https://www.tenders.gov.au/Search?SearchType=Atm&Status=Current&Keyword=${encodeURIComponent(keyword)}`;
    const res = await axios.get(url, { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html' } });
    const $ = load(res.data);
    const items = [];
    $('table tbody tr, .result-row').each((i, el) => {
      if (items.length >= limit) return false;
      const $el = $(el);
      const title    = cleanText($el.find('td:nth-child(2) a, .title').first().text());
      const org      = cleanText($el.find('td:nth-child(3), .agency').first().text());
      const deadline = parseDate($el.find('td:nth-child(5), .close-date').first().text());
      const link     = $el.find('a').first().attr('href');
      if (title) items.push({
        organization_name: org || 'Australian Government',
        tender_title: title, tender_status: 'Open', description: '', category: null,
        budget_usd: null, budget_raw: null, deadline, announcement_date: null,
        source_link: link ? (link.startsWith('http') ? link : `https://www.tenders.gov.au${link}`) : 'https://www.tenders.gov.au',
        source: 'AusTendering', region: 'Australia',
      });
    });
    return items;
  } catch { return []; }
}

// ════════════════════════════════════════════════════
// EBRD — European Bank for Reconstruction and Development (NEW)
// Free JSON API at ecepp.ebrd.com — no auth required
// Covers infrastructure, IT, energy, finance projects across 40+ countries
// ════════════════════════════════════════════════════
export async function scrapeEBRD({ keywords = [], maxResults = 30 } = {}) {
  const results = [];

  for (const keyword of (keywords.length ? keywords : ['IT services', 'software', 'consulting'])) {
    if (results.length >= maxResults) break;
    const limit = Math.min(20, maxResults - results.length);

    try {
      // EBRD eProcurement portal — JSON API (publicly accessible)
      const url = `https://ecepp.ebrd.com/adapt/run/api.procurement.Procurement.json?procurementStatus=CURRENT&keyword=${encodeURIComponent(keyword)}&currentPage=0&pageSize=${limit}&sortBy=DEADLINE&sortOrder=ASC`;

      const response = await axios.get(url, {
        timeout: 20000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          Accept: 'application/json',
          Referer: 'https://ecepp.ebrd.com/adapt/run/module.notice.list.html',
        },
      });

      const procurements = response.data?.procurements
        || response.data?.results
        || response.data?.items
        || [];

      for (const p of procurements) {
        results.push({
          organization_name: cleanText(p.projectName || p.clientName || p.client || 'EBRD Project'),
          tender_title:      cleanText(p.title || p.procurementTitle || p.noticeTitle || ''),
          tender_status:     p.procurementStatus === 'CURRENT' ? 'Open' : 'Closed',
          description:       cleanText(p.sectorName || p.category || p.description || ''),
          category:          null,
          budget_usd:        parseBudget(p.contractValue || p.estimatedValue, 'EUR'),
          budget_raw:        p.contractValue ? `€${p.contractValue}` : null,
          deadline:          parseDate(p.submissionDeadline || p.deadline || p.closingDate),
          announcement_date: parseDate(p.publicationDate || p.issueDate),
          source_link:       p.id
            ? `https://ecepp.ebrd.com/adapt/run/module.notice.detail.html?noticeId=${p.id}`
            : 'https://ecepp.ebrd.com',
          source:  'EBRD',
          region:  'Global',
          country: p.countryName || p.country || null,
        });
      }
    } catch (err) {
      console.warn(`[EBRD] Error for "${keyword}": ${err.message}`);
      // HTML fallback
      const html = await ebrdHtmlFallback(keyword, limit);
      results.push(...html);
    }

    await sleep(700);
  }
  return results;
}

async function ebrdHtmlFallback(keyword, limit = 15) {
  try {
    const { load } = await import('cheerio');
    const url = `https://ecepp.ebrd.com/adapt/run/module.notice.list.html?procurementStatus=CURRENT&keyword=${encodeURIComponent(keyword)}`;
    const res = await axios.get(url, { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html' } });
    const $ = load(res.data);
    const items = [];
    $('tr[class*="row"], .notice-row, .procurement-row').each((i, el) => {
      if (items.length >= limit) return false;
      const $el = $(el);
      const title = cleanText($el.find('td:nth-child(2) a, .notice-title').first().text());
      const org   = cleanText($el.find('td:nth-child(3), .project-name').first().text());
      const link  = $el.find('a').first().attr('href');
      if (title) items.push({
        organization_name: org || 'EBRD Project',
        tender_title:      title,
        tender_status:     'Open',
        description:       '',
        category:          null,
        budget_usd:        null,
        budget_raw:        null,
        deadline:          null,
        announcement_date: null,
        source_link: link ? (link.startsWith('http') ? link : `https://ecepp.ebrd.com${link}`) : 'https://ecepp.ebrd.com',
        source:  'EBRD',
        region:  'Global',
        country: null,
      });
    });
    return items;
  } catch { return []; }
}

// ════════════════════════════════════════════════════
// ADB — Asian Development Bank (NEW)
// Covers procurement notices across Asia-Pacific
// Free HTML-based scraping (no public JSON API)
// ════════════════════════════════════════════════════
export async function scrapeADB({ keywords = [], maxResults = 25 } = {}) {
  const results = [];

  for (const keyword of (keywords.length ? keywords : ['IT', 'software', 'consulting'])) {
    if (results.length >= maxResults) break;

    try {
      const { load } = await import('cheerio');
      // ADB Procurement Notices search
      const url = `https://www.adb.org/projects/tenders?type=1&category=0&q=${encodeURIComponent(keyword)}&page=0`;

      const response = await axios.get(url, {
        timeout: 20000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });

      const $ = load(response.data);

      $('table tbody tr, .views-row, .tender-item, article[class*="tender"]').each((i, el) => {
        if (results.length >= maxResults) return false;
        const $el = $(el);

        const title = cleanText(
          $el.find('td:nth-child(2) a, .views-field-title a, h3 a, .tender-title').first().text()
        );
        const org = cleanText(
          $el.find('td:nth-child(3), .views-field-field-country, .borrower').first().text()
        );
        const deadline = parseDate(
          $el.find('td:nth-child(4), .views-field-field-closing-date, .deadline').first().text()
        );
        const budgetRaw = cleanText(
          $el.find('td:nth-child(5), .views-field-field-contract-amount').first().text()
        );
        const link =
          $el.find('a[href*="/projects/"]').first().attr('href') ||
          $el.find('a').first().attr('href');

        if (title) results.push({
          organization_name: org || 'ADB Project',
          tender_title:      title,
          tender_status:     'Open',
          description:       '',
          category:          null,
          budget_usd:        parseBudget(budgetRaw, 'USD'),
          budget_raw:        budgetRaw || null,
          deadline,
          announcement_date: null,
          source_link: link
            ? (link.startsWith('http') ? link : `https://www.adb.org${link}`)
            : 'https://www.adb.org/projects/tenders',
          source:  'ADB',
          region:  'Asia-Pacific',
          country: org || null,
        });
      });
    } catch (err) {
      console.warn(`[ADB] Error for "${keyword}": ${err.message}`);
    }

    await sleep(800);
  }
  return results;
}

// ════════════════════════════════════════════════════
// Devex — REMOVED (paywalled, 403 always)
// Replaced by scrapeContractsFinder above.
// Kept as stub to avoid import errors if referenced elsewhere.
// ════════════════════════════════════════════════════
export async function scrapeDevex() {
  console.warn('[Devex] Paywalled — use Contracts Finder or EBRD instead');
  return [];
}
