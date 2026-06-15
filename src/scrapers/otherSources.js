import axios from 'axios';
import { parseDate, parseBudget, cleanText, sleep } from '../utils/helpers.js';

// ── UNGM — United Nations Global Marketplace ──────────────────────────
export async function scrapeUNGM({ keywords = [], maxResults = 30 } = {}) {
  const results = [];
  const { load } = await import('cheerio');
  for (const keyword of keywords) {
    if (results.length >= maxResults) break;
    try {
      const url = `https://www.ungm.org/Public/Notice?Keywords=${encodeURIComponent(keyword)}`;
      const res = await axios.get(url, { timeout: 20000, headers: { 'User-Agent': 'Mozilla/5.0' } });
      const $ = load(res.data);

      $('table tbody tr').each((i, el) => {
        const $el = $(el);
        const title = cleanText($el.find('td:nth-child(2) a').text());
        if (title && results.length < maxResults) {
          results.push({
            organization_name: cleanText($el.find('td:nth-child(3)').text()) || 'UN Agency',
            tender_title: title,
            tender_status: 'Open',
            description: '',
            deadline: parseDate($el.find('td:nth-child(4)').text()),
            source_link: `https://www.ungm.org${$el.find('a').attr('href')}`,
            source: 'UNGM',
            region: 'Global',
          });
        }
      });
    } catch (err) { console.warn(`[UNGM] failed: ${err.message}`); }
  }
  return results;
}

// ── EBRD — European Bank for Reconstruction & Development ─────────────
export async function scrapeEBRD({ keywords = [], maxResults = 30 } = {}) {
  const results = [];
  for (const keyword of keywords) {
    if (results.length >= maxResults) break;
    try {
      const url = `https://ecepp.ebrd.com/adapt/run/api.procurement.Procurement.json?procurementStatus=CURRENT&keyword=${encodeURIComponent(keyword)}&currentPage=0&pageSize=20`;
      const res = await axios.get(url, { timeout: 20000 });
      const items = res.data?.procurements || [];
      items.forEach(p => {
        if (results.length < maxResults) {
          results.push({
            organization_name: cleanText(p.clientName || 'EBRD'),
            tender_title: cleanText(p.title),
            tender_status: 'Open',
            description: cleanText(p.sectorName),
            deadline: parseDate(p.submissionDeadline),
            source_link: `https://ecepp.ebrd.com/adapt/run/module.notice.detail.html?noticeId=${p.id}`,
            source: 'EBRD',
            region: 'Global',
          });
        }
      });
    } catch (err) { console.warn(`[EBRD] failed: ${err.message}`); }
  }
  return results;
}

// ── ADB — Asian Development Bank ──────────────────────────────────────
export async function scrapeADB({ keywords = [], maxResults = 25 } = {}) {
  const results = [];
  const { load } = await import('cheerio');
  for (const keyword of keywords) {
    if (results.length >= maxResults) break;
    try {
      const url = `https://www.adb.org/projects/tenders?q=${encodeURIComponent(keyword)}`;
      const res = await axios.get(url, { timeout: 20000, headers: { 'User-Agent': 'Mozilla/5.0' } });
      const $ = load(res.data);
      $('.views-row').each((i, el) => {
        const title = cleanText($(el).find('a').text());
        if (title && results.length < maxResults) {
          results.push({
            organization_name: 'ADB',
            tender_title: title,
            tender_status: 'Open',
            source_link: `https://www.adb.org${$(el).find('a').attr('href')}`,
            source: 'ADB',
            region: 'Asia-Pacific',
          });
        }
      });
    } catch (err) { console.warn(`[ADB] failed: ${err.message}`); }
  }
  return results;
}

// ── Shared: map an OCDS release (UK Find-a-Tender / Contracts Finder) ─
function mapOcdsRelease(r, source, region) {
  const tender = r.tender || {};
  const value = tender.value || {};
  const endDate = tender.tenderPeriod?.endDate;
  return {
    organization_name: cleanText(r.buyer?.name || r.parties?.[0]?.name || 'UK Public Body'),
    tender_title: cleanText(tender.title || ''),
    tender_status: endDate && new Date(endDate) < new Date() ? 'Closed' : 'Open',
    description: cleanText(tender.description || ''),
    category: null,
    budget_usd: value.amount ? parseBudget(String(value.amount), value.currency || 'GBP') : null,
    budget_raw: value.amount ? `${value.currency || 'GBP'} ${value.amount}` : null,
    deadline: parseDate(endDate),
    announcement_date: parseDate(r.date),
    source_link: tender.documents?.[0]?.url || `https://www.find-tender.service.gov.uk/Notice/${r.ocid || ''}`,
    source,
    region,
  };
}

// ── Find-a-Tender UK ──────────────────────────────────────────────────
export async function scrapeFindATender({ keywords = [], maxResults = 30 } = {}) {
  const results = [];
  for (const keyword of (keywords.length ? keywords : ['software', 'IT services'])) {
    if (results.length >= maxResults) break;
    try {
      const url = `https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages?hasKeyword=${encodeURIComponent(keyword)}`;
      const res = await axios.get(url, { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } });
      const releases = res.data?.releases || [];
      for (const r of releases) {
        if (results.length >= maxResults) break;
        if (!r.tender?.title) continue;
        results.push(mapOcdsRelease(r, 'Find-a-Tender UK', 'UK'));
      }
    } catch (err) { console.warn(`[Find-a-Tender] failed for "${keyword}": ${err.message}`); }
    await sleep(500);
  }
  return results;
}

// ── Contracts Finder UK (OCDS search API) ──────────────────────────────
export async function scrapeContractsFinder({ keywords = [], maxResults = 30 } = {}) {
  const results = [];
  for (const keyword of (keywords.length ? keywords : ['software', 'IT services'])) {
    if (results.length >= maxResults) break;
    try {
      const url = `https://www.contractsfinder.service.gov.uk/Published/Notices/OCDS/Search?keyword=${encodeURIComponent(keyword)}&order=desc`;
      const res = await axios.get(url, { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
      const releases = res.data?.releases || [];
      for (const r of releases) {
        if (results.length >= maxResults) break;
        if (!r.tender?.title) continue;
        results.push(mapOcdsRelease(r, 'Contracts Finder UK', 'UK'));
      }
    } catch (err) { console.warn(`[Contracts Finder] failed for "${keyword}": ${err.message}`); }
    await sleep(500);
  }
  return results;
}

// ── World Bank Procurement Notices ─────────────────────────────────────
export async function scrapeWorldBank({ keywords = [], maxResults = 30 } = {}) {
  const results = [];
  for (const keyword of (keywords.length ? keywords : ['software', 'IT services', 'consulting'])) {
    if (results.length >= maxResults) break;
    try {
      const url = `https://search.worldbank.org/api/v2/procnotices?format=json&qterm=${encodeURIComponent(keyword)}&rows=20`;
      const res = await axios.get(url, { timeout: 20000, headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
      const docs = res.data?.procnotices?.docs || res.data?.documents || [];
      for (const d of (Array.isArray(docs) ? docs : Object.values(docs))) {
        if (results.length >= maxResults) break;
        const title = d.notice_title || d.bid_description || d.title;
        if (!title) continue;
        results.push({
          organization_name: cleanText(d.borrower || d.country_name || 'World Bank Borrower'),
          tender_title: cleanText(title),
          tender_status: 'Open',
          description: cleanText(d.project_name || ''),
          category: null,
          budget_usd: null,
          budget_raw: null,
          deadline: parseDate(d.submission_date || d.bid_closing_date),
          announcement_date: parseDate(d.publish_date || d.notice_date),
          source_link: d.url || d.pdfurl || 'https://projects.worldbank.org/en/projects-operations/procurement',
          source: 'World Bank',
          region: 'Global',
          country: d.country_name || null,
        });
      }
    } catch (err) { console.warn(`[World Bank] failed for "${keyword}": ${err.message}`); }
    await sleep(500);
  }
  return results;
}

// ── CanadaBuys (formerly MERX) — Government of Canada tenders ─────────
export async function scrapeMerxCanada({ keywords = [], maxResults = 30 } = {}) {
  const results = [];
  const { load } = await import('cheerio');
  for (const keyword of (keywords.length ? keywords : ['software', 'IT services', 'consulting'])) {
    if (results.length >= maxResults) break;
    try {
      const url = `https://canadabuys.canada.ca/en/tender-opportunities?f%5B0%5D=&search_api_fulltext=${encodeURIComponent(keyword)}`;
      const res = await axios.get(url, { timeout: 20000, headers: { 'User-Agent': 'Mozilla/5.0' } });
      const $ = load(res.data);
      $('.views-row, table tbody tr').each((i, el) => {
        if (results.length >= maxResults) return false;
        const $el = $(el);
        const title = cleanText($el.find('a').first().text());
        const link = $el.find('a').first().attr('href');
        const org = cleanText($el.find('[class*="organization"], td:nth-child(2)').first().text());
        const deadline = cleanText($el.find('[class*="closing"], [class*="date"], td:nth-child(4)').first().text());
        if (title) {
          results.push({
            organization_name: org || 'Government of Canada',
            tender_title: title,
            tender_status: 'Open',
            description: '',
            category: null,
            budget_usd: null,
            budget_raw: null,
            deadline: parseDate(deadline),
            announcement_date: null,
            source_link: link ? (link.startsWith('http') ? link : `https://canadabuys.canada.ca${link}`) : 'https://canadabuys.canada.ca/en/tender-opportunities',
            source: 'CanadaBuys',
            region: 'Canada',
          });
        }
      });
    } catch (err) { console.warn(`[CanadaBuys] failed for "${keyword}": ${err.message}`); }
    await sleep(500);
  }
  return results;
}

// ── AusTender — Australian Government procurement ──────────────────────
export async function scrapeAusTendering({ keywords = [], maxResults = 30 } = {}) {
  const results = [];
  const { load } = await import('cheerio');
  for (const keyword of (keywords.length ? keywords : ['software', 'IT services', 'consulting'])) {
    if (results.length >= maxResults) break;
    try {
      const url = `https://www.tenders.gov.au/atm?searchText=${encodeURIComponent(keyword)}`;
      const res = await axios.get(url, { timeout: 20000, headers: { 'User-Agent': 'Mozilla/5.0' } });
      const $ = load(res.data);
      $('table tbody tr, .search-result, .atm-result').each((i, el) => {
        if (results.length >= maxResults) return false;
        const $el = $(el);
        const title = cleanText($el.find('a').first().text());
        const link = $el.find('a').first().attr('href');
        const org = cleanText($el.find('[class*="agency"], td:nth-child(2)').first().text());
        const deadline = cleanText($el.find('[class*="closing"], [class*="date"], td:nth-child(4)').first().text());
        if (title) {
          results.push({
            organization_name: org || 'Australian Government',
            tender_title: title,
            tender_status: 'Open',
            description: '',
            category: null,
            budget_usd: null,
            budget_raw: null,
            deadline: parseDate(deadline),
            announcement_date: null,
            source_link: link ? (link.startsWith('http') ? link : `https://www.tenders.gov.au${link}`) : 'https://www.tenders.gov.au/atm',
            source: 'AusTender',
            region: 'Australia',
          });
        }
      });
    } catch (err) { console.warn(`[AusTender] failed for "${keyword}": ${err.message}`); }
    await sleep(500);
  }
  return results;
}
