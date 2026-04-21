/**
 * Multi-source scraper bundle:
 *  - UK Find-a-Tender (FAT) — official UK procurement post-Brexit
 *  - UNGM — United Nations Global Marketplace
 *  - World Bank Procurement Notices
 *  - IADB — Inter-American Development Bank
 *  - AusTendering — Australian government
 */

import axios from 'axios';
import { parseDate, parseBudget, cleanText, sleep } from '../utils/helpers.js';

// ════════════════════════════════════════════════════
// UK FIND-A-TENDER
// API: https://www.find-tender.service.gov.uk/api/
// ════════════════════════════════════════════════════
export async function scrapeFindATender({ keywords = [], maxResults = 30 } = {}) {
  const results = [];

  for (const keyword of (keywords.length ? keywords : ['technology', 'software'])) {
    if (results.length >= maxResults) break;
    try {
      // Official UK FTS (Find a Tender Service) API — free, no auth
      const url = `https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages?hasKeyword=${encodeURIComponent(keyword)}&stages=tender&limit=${Math.min(25, maxResults - results.length)}`;

      const response = await axios.get(url, {
        timeout: 15000,
        headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
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
      await sleep(600);
    } catch (err) {
      console.warn(`[Find-a-Tender] Error: ${err.message}`);
      const fallback = await fatHtmlFallback(keyword, maxResults - results.length);
      results.push(...fallback);
    }
  }
  return results;
}

async function fatHtmlFallback(keyword, limit = 15) {
  try {
    const { load } = await import('cheerio');
    const url = `https://www.find-tender.service.gov.uk/Search/Results?&Keywords=${encodeURIComponent(keyword)}`;
    const res = await axios.get(url, { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    const $ = load(res.data);
    const items = [];
    $('.search-result, article.search-result-entry').each((i, el) => {
      if (items.length >= limit) return false;
      const $el = $(el);
      const title = cleanText($el.find('h2, .title, a').first().text());
      const org = cleanText($el.find('.authority, .buyer').first().text());
      const deadline = parseDate($el.find('.deadline, time[datetime]').first().attr('datetime') || $el.find('.deadline').first().text());
      const link = $el.find('a').first().attr('href');
      if (title) items.push({
        organization_name: org || 'UK Public Body',
        tender_title: title, tender_status: 'Open', description: '', category: null,
        budget_usd: null, budget_raw: null, deadline, announcement_date: null,
        source_link: link ? (link.startsWith('http') ? link : `https://www.find-tender.service.gov.uk${link}`) : 'https://www.find-tender.service.gov.uk',
        source: 'Find-a-Tender UK', region: 'UK',
      });
    });
    return items;
  } catch { return []; }
}

// ════════════════════════════════════════════════════
// UNGM — United Nations Global Marketplace
// API: https://www.ungm.org/Public/Notice
// ════════════════════════════════════════════════════
export async function scrapeUNGM({ keywords = [], maxResults = 30 } = {}) {
  const results = [];

  for (const keyword of (keywords.length ? keywords : ['IT services', 'software'])) {
    if (results.length >= maxResults) break;
    try {
      const url = 'https://www.ungm.org/Public/Notice/SearchPublicNotices';
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

      const notices = response.data?.Notices || response.data?.notices || response.data || [];
      const noticeArray = Array.isArray(notices) ? notices : [];

      for (const n of noticeArray.slice(0, maxResults - results.length)) {
        results.push({
          organization_name: cleanText(n.AgencyName || n.Organization || 'UN Agency'),
          tender_title: cleanText(n.Title || n.title || ''),
          tender_status: n.IsClosed ? 'Closed' : 'Open',
          description: cleanText(n.Description || ''),
          category: null,
          budget_usd: null,
          budget_raw: null,
          deadline: parseDate(n.Deadline || n.deadline),
          announcement_date: parseDate(n.PublishedOn || n.publishedDate),
          source_link: n.NoticeId ? `https://www.ungm.org/Public/Notice/${n.NoticeId}` : 'https://www.ungm.org/Public/Notice',
          source: 'UNGM',
          region: 'Global',
        });
      }
      await sleep(700);
    } catch (err) {
      console.warn(`[UNGM] Error: ${err.message}`);
    }
  }
  return results;
}

// ════════════════════════════════════════════════════
// WORLD BANK — Open Procurement
// API: https://search.worldbank.org/api/v2/procurement
// ════════════════════════════════════════════════════
export async function scrapeWorldBank({ keywords = [], maxResults = 30 } = {}) {
  const results = [];

  for (const keyword of (keywords.length ? keywords : ['technology', 'consulting'])) {
    if (results.length >= maxResults) break;
    try {
      const url = `https://search.worldbank.org/api/v2/procurement?apilanguage=EN&format=json&qterm=${encodeURIComponent(keyword)}&os=0&rows=${Math.min(20, maxResults - results.length)}&fl=bid_description,procurement_group,contact_org_name,deadline_dt,project_name,url,notice_type,disclosure_date,project_ctry_name,totalamt`;

      const response = await axios.get(url, {
        timeout: 15000,
        headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
      });

      const docs = response.data?.procurement?.docs || [];
      for (const d of docs) {
        results.push({
          organization_name: cleanText(d.contact_org_name || d.procurement_group || 'World Bank Project'),
          tender_title: cleanText(d.bid_description || d.project_name || ''),
          tender_status: 'Open',
          description: cleanText(d.notice_type || ''),
          category: null,
          budget_usd: parseBudget(d.totalamt ? String(d.totalamt) : null, 'USD'),
          budget_raw: d.totalamt ? `$${d.totalamt}` : null,
          deadline: parseDate(d.deadline_dt),
          announcement_date: parseDate(d.disclosure_date),
          source_link: d.url || 'https://projects.worldbank.org/en/projects-operations/procurement',
          source: 'World Bank',
          region: 'Global',
          country: d.project_ctry_name || null,
        });
      }
      await sleep(600);
    } catch (err) {
      console.warn(`[World Bank] Error: ${err.message}`);
    }
  }
  return results;
}

// ════════════════════════════════════════════════════
// MERX Canada — https://www.merx.com (public notices)
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
        const title = cleanText($el.find('td:nth-child(2) a, .bid-title').first().text());
        const org = cleanText($el.find('td:nth-child(3), .org').first().text());
        const deadline = parseDate($el.find('td:nth-child(5), .deadline').first().text());
        const link = $el.find('a').first().attr('href');
        if (title) results.push({
          organization_name: org || 'Canadian Government',
          tender_title: title, tender_status: 'Open', description: '', category: null,
          budget_usd: null, budget_raw: null, deadline, announcement_date: null,
          source_link: link ? (link.startsWith('http') ? link : `https://www.merx.com${link}`) : 'https://www.merx.com',
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
// API: https://www.tenders.gov.au/Search/AtelSearch
// ════════════════════════════════════════════════════
export async function scrapeAusTendering({ keywords = [], maxResults = 25 } = {}) {
  const results = [];
  for (const keyword of (keywords.length ? keywords : ['IT', 'technology'])) {
    if (results.length >= maxResults) break;
    try {
      const url = `https://www.tenders.gov.au/Atm/ShowJson?Keywords=${encodeURIComponent(keyword)}&Status=Current&Page=1&Size=${Math.min(20, maxResults - results.length)}`;
      const response = await axios.get(url, {
        timeout: 15000,
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
      });
      const tenders = response.data?.ATMs || response.data?.results || [];
      for (const t of tenders) {
        results.push({
          organization_name: cleanText(t.AgencyName || t.agency || 'Australian Government'),
          tender_title: cleanText(t.Description || t.title || ''),
          tender_status: 'Open',
          description: cleanText(t.Category || ''),
          category: null,
          budget_usd: parseBudget(t.ContractValue || t.value, 'AUD'),
          budget_raw: t.ContractValue ? `AUD ${t.ContractValue}` : null,
          deadline: parseDate(t.CloseDate || t.deadline),
          announcement_date: parseDate(t.PublishedDate || t.published),
          source_link: t.ATMID ? `https://www.tenders.gov.au/Atm/Show/${t.ATMID}` : 'https://www.tenders.gov.au',
          source: 'AusTendering',
          region: 'Australia',
        });
      }
      await sleep(700);
    } catch (err) {
      console.warn(`[AusTendering] Error: ${err.message}`);
    }
  }
  return results;
}

// ════════════════════════════════════════════════════
// Devex — International Development Tenders
// (freemium, scrape public listings)
// ════════════════════════════════════════════════════
export async function scrapeDevex({ keywords = [], maxResults = 20 } = {}) {
  const results = [];
  try {
    const { load } = await import('cheerio');
    for (const keyword of (keywords.length ? keywords : ['technology', 'consulting'])) {
      if (results.length >= maxResults) break;
      const url = `https://www.devex.com/jobs/search?type=tender&keywords=${encodeURIComponent(keyword)}`;
      const response = await axios.get(url, {
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120',
          'Accept': 'text/html,application/xhtml+xml',
        },
      });
      const $ = load(response.data);
      $('.tender-card, .job-listing, article[data-job-id]').each((i, el) => {
        if (results.length >= maxResults) return false;
        const $el = $(el);
        const title = cleanText($el.find('h2, h3, .job-title').first().text());
        const org = cleanText($el.find('.company, .organization, .employer').first().text());
        const deadline = parseDate($el.find('.deadline, time').first().attr('datetime') || $el.find('.deadline').text());
        const link = $el.find('a').first().attr('href');
        if (title) results.push({
          organization_name: org || 'International Organization',
          tender_title: title, tender_status: 'Open', description: '', category: null,
          budget_usd: null, budget_raw: null, deadline, announcement_date: null,
          source_link: link ? (link.startsWith('http') ? link : `https://www.devex.com${link}`) : 'https://www.devex.com',
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
