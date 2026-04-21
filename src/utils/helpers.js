/**
 * Shared utilities: date parsing, budget parsing, dedup, normalization
 */

import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';
import utc from 'dayjs/plugin/utc.js';
dayjs.extend(customParseFormat);
dayjs.extend(utc);

// ── Date Utilities ──────────────────────────────────────────────────────────

const DATE_FORMATS = [
  'YYYY-MM-DD', 'MM/DD/YYYY', 'DD/MM/YYYY', 'DD-MM-YYYY',
  'MMM DD, YYYY', 'MMMM DD, YYYY', 'DD MMM YYYY', 'DD MMMM YYYY',
  'YYYY-MM-DDTHH:mm:ss', 'YYYY-MM-DDTHH:mm:ssZ', 'ddd, DD MMM YYYY',
];

export function parseDate(raw) {
  if (!raw) return null;
  const cleaned = String(raw).trim().replace(/\s+/g, ' ');
  for (const fmt of DATE_FORMATS) {
    const d = dayjs(cleaned, fmt, true);
    if (d.isValid()) return d.format('YYYY-MM-DD');
  }
  // Fallback: let dayjs try naturally
  const d = dayjs(cleaned);
  return d.isValid() ? d.format('YYYY-MM-DD') : null;
}

export function isExpired(deadlineStr) {
  if (!deadlineStr) return false;
  return dayjs(deadlineStr).isBefore(dayjs(), 'day');
}

export function isRecentlyClosed(deadlineStr, withinDays = 7) {
  if (!deadlineStr) return false;
  const deadline = dayjs(deadlineStr);
  const cutoff = dayjs().subtract(withinDays, 'day');
  return deadline.isBefore(dayjs()) && deadline.isAfter(cutoff);
}

// ── Budget Utilities ────────────────────────────────────────────────────────

const CURRENCY_RATES_TO_USD = {
  USD: 1, EUR: 1.08, GBP: 1.27, INR: 0.012,
  CAD: 0.74, AUD: 0.65, JPY: 0.0067,
};

export function parseBudget(raw, currency = 'USD') {
  if (!raw) return null;
  const cleaned = String(raw)
    .replace(/[,\s]/g, '')
    .replace(/[€£₹$]/g, '')
    .replace(/\s*(million|m)\s*/i, '000000')
    .replace(/\s*(billion|b)\s*/i, '000000000')
    .replace(/\s*(thousand|k)\s*/i, '000')
    .trim();

  const num = parseFloat(cleaned);
  if (isNaN(num)) return null;

  // Detect currency from symbol
  let detectedCurrency = currency;
  if (raw.includes('€')) detectedCurrency = 'EUR';
  else if (raw.includes('£')) detectedCurrency = 'GBP';
  else if (raw.includes('₹')) detectedCurrency = 'INR';
  else if (raw.includes('$')) detectedCurrency = 'USD';

  const rate = CURRENCY_RATES_TO_USD[detectedCurrency] || 1;
  return Math.round(num * rate);
}

export function formatBudget(amountUsd) {
  if (!amountUsd) return null;
  if (amountUsd >= 1_000_000_000) return `$${(amountUsd / 1_000_000_000).toFixed(1)}B`;
  if (amountUsd >= 1_000_000) return `$${(amountUsd / 1_000_000).toFixed(1)}M`;
  if (amountUsd >= 1_000) return `$${(amountUsd / 1_000).toFixed(0)}K`;
  return `$${amountUsd}`;
}

// ── Deduplication ───────────────────────────────────────────────────────────

const seenIds = new Set();

export function isDuplicate(tender) {
  // Fingerprint: org + title (normalized)
  const fp = `${tender.organization_name}|${tender.tender_title}`
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

  if (seenIds.has(fp)) return true;
  seenIds.add(fp);
  return false;
}

export function resetDedup() {
  seenIds.clear();
}

// ── Text Normalization ──────────────────────────────────────────────────────

export function cleanText(raw) {
  if (!raw) return '';
  return String(raw)
    .replace(/\s+/g, ' ')
    .replace(/[\r\n\t]/g, ' ')
    .trim();
}

export function truncate(str, maxLen = 300) {
  if (!str) return '';
  return str.length > maxLen ? str.slice(0, maxLen) + '…' : str;
}

// ── HTTP Helpers ─────────────────────────────────────────────────────────────

export function buildHeaders(extraHeaders = {}) {
  return {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Cache-Control': 'no-cache',
    ...extraHeaders,
  };
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function randomDelay(minMs = 500, maxMs = 2000) {
  return sleep(Math.floor(Math.random() * (maxMs - minMs) + minMs));
}
