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

// ── Find-a-Tender UK ──────────────────────────────────────────────────
export async function scrapeFindATender({ keywords = [], maxResults = 30 } = {}) {
  const results = [];
  for (const keyword of keywords) {
    try {
      const url = `https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages?hasKeyword=${encodeURIComponent(keyword)}`;
      const res = await axios.get(url, { timeout: 15000 });
      const releases = res.data?.releases || [];
      releases.forEach(r => {
        results.push({
          organization_name: cleanText(r.buyer?.name || 'UK Public Body'),
          tender_title: cleanText(r.tender?.title),
          tender_status: 'Open',
          source: 'Find-a-Tender UK',
          region: 'UK',
        });
      });
    } catch (err) { console.warn(`[Find-a-Tender] failed: ${err.message}`); }
  }
  return results;
}

// ── Placeholder Exports to fix SyntaxErrors in main.js ────────────────
export async function scrapeContractsFinder() { return []; }
export async function scrapeWorldBank() { return []; }
export async function scrapeMerxCanada() { return []; }
export async function scrapeAusTendering() { return []; }
