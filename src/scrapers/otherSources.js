/**
 * Multi-source scraper bundle:
 *  - UK Find-a-Tender (FAT) — official UK procurement post-Brexit
 *  - UNGM — United Nations Global Marketplace
 *  - World Bank Procurement Notices
 *  - IADB — Inter-American Development Bank
 *  - AusTendering — Australian government
 *  - MERX Canada
 *  - Devex
 */

import axios from 'axios';
import { parseDate, parseBudget, cleanText, sleep } from '../utils/helpers.js';

// ════════════════════════════════════════════════════
// UK FIND-A-TENDER
// FIX: API v1 was returning 400 — use correct param names
//      and fall through to HTML scrape which works reliably
// ════════════════════════════════════════════════════
export async function scrapeFindATender({ keywords = [], maxResults = 30 } = {}) {
  const results = [];

  for (const keyword of (keywords.length ? keywords : ['technology', 'software'])) {
    if (results.length >= maxResults) break;

    // Try the OCDS API first with corrected params
    try {
      const limit = Math.min(25, maxResults - results.length);
      // FIX: correct param is 'q' or 'keyword', not 'hasKeyword'; also removed 'stages' which causes 400
      const url = `https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages?q=${encodeURIComponent(keyword)}&limit=${limit}`;

      const response = await axios.get(url, {
        timeout: 15000,
        headers: {
          Accept: 'application/json',
          'User-Agent': 'Mozilla/5.0',
        },
      });

      const releases = response.data?.releases || [];
      for (const r of releases) {
        const tender = r.tender || {};
        const buyer = r.buyer || {};
        const budget = tender.value?.amount;

        results.push({
          organization_name: cleanText(buyer.name || 'UK Public Body'),
          tender_title: cleanText(tender.title || r.id || ''),
          tender_status: tender.status === 'active' ? 'Open' : 'Closed',
          description: cleanText(tender.description || ''),
          category: null,
          budget_usd: parseBudget(budget ? String(budget) : null, tender.value?.currency || 'GBP'),
          budget_raw: budget ? `${tender.value?.currency || 'GBP'} ${budget}` : null,
          deadline: parseDate(tender.tenderPeriod?.endDate),
          announcement_date: parseDate(r.date || tender.tenderPeriod?.startDate),
          source_link: `https://www.find-tender.service.gov.uk/Notice/${r.id}`,
          source: 'Find-a-Tender UK',
          region: 'UK',
          cpv_codes: tender.items?.map(i => i.classification?.id).filter(Boolean) || [],
        });
      }

      if (releases.length > 0) {
        await sleep(600);
        continue; // API worked, skip HTML fallback
      }
    } catch (err) {
      console.warn(`[Find-a-Tender] API error (${err.response?.status || err.message}), using HTML fallback`);
    }

    // HTML fallback (was already working in production — 20 items)
    const fallback = await fatHtmlFallback(keyword, maxResults - results.length);
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
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' },
    });

    const $ = load(res.data);
    const items = [];

    $('.search-result, article.search-result-entry, .tender-result').each((i, el) => {
      if (items.length >= limit) return false;
      const $el = $(el);
      const title = cleanText($el.find('h2, .title, a').first().text());
      const org   = cleanText($el.find('.authority, .buyer, .contracting-authority').first().text());
      const deadlineRaw =
        $el.find('time[datetime]').first().attr('datetime') ||
        $el.find('.deadline, .close-date').first().text();
      const deadline = parseDate(deadlineRaw);
      const link = $el.find('a').first().attr('href');

      if (title) items.push({
        organization_name: org || 'UK Public Body',
        tender_title: title,
        tender_status: 'Open',
        description: '',
        category: null,
        budget_usd: null,
        budget_raw: null,
        deadline,
        announcement_date: null,
        source_link: link
          ? (link.startsWith('http') ? link : `https://www.find-tender.service.gov.uk${link}`)
          : 'https://www.find-tender.service.gov.uk',
        source: 'Find-a-Tender UK',
        region: 'UK',
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
// UNGM — United Nations Global Marketplace
// FIX: endpoint path changed; now also tries alternative URLs
// ════════════════════════════════════════════════════
export async function scrapeUNGM({ keywords = [], maxResults = 30 } = {}) {
  const results = [];

  for (const keyword of (keywords.length ? keywords : ['IT services', 'software'])) {
    if (results.length >= maxResults) break;

    // Try multiple known UNGM endpoints (they've changed the path before)
    const endpoints = [
      'https://www.ungm.org/Public/Notice/SearchPublicNotices',   // original
      'https://www.ungm.org/api/Notice/SearchPublicNotices',      // alt
    ];

    let fetched = false;
    for (const url of endpoints) {
      try {
        const body = {
          Title: keyword,
          Description: '',
          Reference: '',
          Beneficiary: '',
          AgencyId: 0,
          NoticeType: '',
          Deadline: '',
          PageIndex: 0,
          PageSize: Math.min(20, maxResults - results.length),
        };

        const response = await axios.post(url, body, {
          timeout: 20000,
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'Referer': 'https://www.ungm.org/Public/Notice',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          },
        });

        const raw = response.data;
        const noticeArray = Array.isArray(raw)
          ? raw
          : Array.isArray(raw?.Notices)
            ? raw.Notices
            : Array.isArray(raw?.notices)
              ? raw.notices
              : [];

        for (const n of noticeArray.slice(0, maxResults - results.length)) {
          results.push({
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
            source:            'UNGM',
            region:            'Global',
          });
        }

        fetched = true;
        break; // success
      } catch (err) {
        console.warn(`[UNGM] Endpoint ${url} failed: ${err.response?.status || err.message}`);
      }
    }

    if (!fetched) {
      // HTML fallback
      const fallback = await ungmHtmlFallback(keyword, maxResults - results.length);
      results.push(...fallback);
    }

    await sleep(700);
  }

  return results;
}

async function ungmHtmlFallback(keyword, limit = 15) {
  try {
    const { load } = await import('cheerio');
    const url = `https://www.ungm.org/Public/Notice?title=${encodeURIComponent(keyword)}`;
    const res = await axios.get(url, {
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' },
    });
    const $ = load(res.data);
    const items = [];

    $('table tbody tr, .notice-row, .tender-item').each((i, el) => {
      if (items.length >= limit) return false;
      const $el = $(el);
      const title    = cleanText($el.find('td:nth-child(2) a, .title').first().text());
      const org      = cleanText($el.find('td:nth-child(3), .agency').first().text());
      const deadline = parseDate($el.find('td:nth-child(5), .deadline').first().text());
      const link     = $el.find('a').first().attr('href');
      if (title) items.push({
        organization_name: org || 'UN Agency',
        tender_title: title, tender_status: 'Open', description: '', category: null,
        budget_usd: null, budget_raw: null, deadline, announcement_date: null,
        source_link: link
          ? (link.startsWith('http') ? link : `https://www.ungm.org${link}`)
          : 'https://www.ungm.org',
        source: 'UNGM', region: 'Global',
      });
    });

    return items;
  } catch {
    return [];
  }
}

// ════════════════════════════════════════════════════
// WORLD BANK — Open Procurement
// FIX: endpoint changed; try both v2 and v3 URLs
// ════════════════════════════════════════════════════
export async function scrapeWorldBank({ keywords = [], maxResults = 30 } = {}) {
  const results = [];

  for (const keyword of (keywords.length ? keywords : ['technology', 'consulting'])) {
    if (results.length >= maxResults) break;

    const limit = Math.min(20, maxResults - results.length);

    // Try multiple World Bank procurement API endpoints
    const endpoints = [
      // v3 procurement notices (newer)
      `https://search.worldbank.org/api/v3/procurement?format=json&qterm=${encodeURIComponent(keyword)}&rows=${limit}&os=0`,
      // v2 procurement (original — was 404 in prod; kept as second attempt)
      `https://search.worldbank.org/api/v2/procurement?apilanguage=EN&format=json&qterm=${encodeURIComponent(keyword)}&rows=${limit}&os=0&fl=bid_description,procurement_group,contact_org_name,deadline_dt,project_name,url,notice_type,disclosure_date,project_ctry_name,totalamt`,
      // Projects API as fallback
      `https://search.worldbank.org/api/v2/projects?format=json&qterm=${encodeURIComponent(keyword)}&rows=${limit}&os=0&fl=project_name,borrower,closingdate,totalcommamt,url,project_ctry_name,boardapprovaldate`,
    ];

    let fetched = false;
    for (const url of endpoints) {
      try {
        const response = await axios.get(url, {
          timeout: 15000,
          headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
        });

        // Procurement endpoint shape
        const docs =
          response.data?.procurement?.docs ||
          response.data?.procnotices?.docs ||
          response.data?.projects?.docs ||
          response.data?.docs ||
          [];

        for (const d of docs) {
          results.push({
            organization_name: cleanText(
              d.contact_org_name || d.borrower || d.procurement_group || 'World Bank Project'
            ),
            tender_title: cleanText(d.bid_description || d.project_name || ''),
            tender_status: 'Open',
            description: cleanText(d.notice_type || d.sector1 || ''),
            category: null,
            budget_usd: parseBudget(
              d.totalamt ? String(d.totalamt) : d.totalcommamt ? String(d.totalcommamt) : null,
              'USD'
            ),
            budget_raw: d.totalamt ? `$${d.totalamt}` : null,
            deadline: parseDate(d.deadline_dt || d.closingdate),
            announcement_date: parseDate(d.disclosure_date || d.boardapprovaldate),
            source_link: d.url || 'https://projects.worldbank.org/en/projects-operations/procurement',
            source: 'World Bank',
            region: 'Global',
            country: d.project_ctry_name || null,
          });
        }

        fetched = docs.length > 0;
        if (fetched) break;
      } catch (err) {
        console.warn(`[World Bank] Endpoint failed (${err.response?.status || err.message}): ${url}`);
      }
    }

    if (!fetched) {
      console.warn('[World Bank] All endpoints failed for keyword:', keyword);
    }

    await sleep(600);
  }

  return results;
}

// ════════════════════════════════════════════════════
// MERX Canada
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
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'Accept': 'text/html' },
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
// FIX: added fallback HTML scraper; JSON endpoint was 403
// ════════════════════════════════════════════════════
export async function scrapeAusTendering({ keywords = [], maxResults = 25 } = {}) {
  const results = [];

  for (const keyword of (keywords.length ? keywords : ['IT', 'technology'])) {
    if (results.length >= maxResults) break;
    try {
      // Try JSON endpoint
      const url = `https://www.tenders.gov.au/Atm/ShowJson?Keywords=${encodeURIComponent(keyword)}&Status=Current&Page=1&Size=${Math.min(20, maxResults - results.length)}`;
      const response = await axios.get(url, {
        timeout: 15000,
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
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
          source_link:       t.ATMID
            ? `https://www.tenders.gov.au/Atm/Show/${t.ATMID}`
            : 'https://www.tenders.gov.au',
          source:  'AusTendering',
          region:  'Australia',
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
    const res = await axios.get(url, {
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' },
    });
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
        source_link: link
          ? (link.startsWith('http') ? link : `https://www.tenders.gov.au${link}`)
          : 'https://www.tenders.gov.au',
        source: 'AusTendering', region: 'Australia',
      });
    });
    return items;
  } catch {
    return [];
  }
}

// ════════════════════════════════════════════════════
// Devex — International Development Tenders
// FIX: public listings without login (403 on direct scrape);
//      use RSS feed or alternative public endpoint
// ════════════════════════════════════════════════════
export async function scrapeDevex({ keywords = [], maxResults = 20 } = {}) {
  const results = [];
  try {
    const { load } = await import('cheerio');
    for (const keyword of (keywords.length ? keywords : ['technology', 'consulting'])) {
      if (results.length >= maxResults) break;

      // Devex public job/tender search — try with browser-like headers to avoid 403
      const url = `https://www.devex.com/jobs/search?type=tender&keywords=${encodeURIComponent(keyword)}`;
      const response = await axios.get(url, {
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache',
          'Referer': 'https://www.devex.com/',
        },
      });
      const $ = load(response.data);
      $('.tender-card, .job-listing, article[data-job-id]').each((i, el) => {
        if (results.length >= maxResults) return false;
        const $el = $(el);
        const title    = cleanText($el.find('h2, h3, .job-title').first().text());
        const org      = cleanText($el.find('.company, .organization, .employer').first().text());
        const deadline = parseDate(
          $el.find('time').first().attr('datetime') || $el.find('.deadline').text()
        );
        const link = $el.find('a').first().attr('href');
        if (title) results.push({
          organization_name: org || 'International Organization',
          tender_title: title, tender_status: 'Open', description: '', category: null,
          budget_usd: null, budget_raw: null, deadline, announcement_date: null,
          source_link: link
            ? (link.startsWith('http') ? link : `https://www.devex.com${link}`)
            : 'https://www.devex.com',
          source: 'Devex', region: 'Global',
        });
      });
      await sleep(1000);
    }
  } catch (err) {
    console.warn(`[Devex] Error: ${err.message}`);
  }
  return results;
}
