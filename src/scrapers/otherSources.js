import axios from 'axios';
import { parseDate, parseBudget, cleanText, sleep } from '../utils/helpers.js';

export async function scrapeUNGM({ keywords = [], maxResults = 30 } = {}) {
  const results = [];
  // FIX: Use the primary Notice list instead of the broken Search endpoint
  for (const keyword of keywords) {
    try {
      const url = `https://www.ungm.org/Public/Notice?Keywords=${encodeURIComponent(keyword)}`;
      const res = await axios.get(url, { timeout: 20000 });
      // ... (existing HTML parsing logic)
    } catch (err) { console.warn(`[UNGM] failed: ${err.message}`); }
  }
  return results;
}

export async function scrapeEBRD({ keywords = [], maxResults = 30 } = {}) {
  const results = [];
  for (const keyword of keywords) {
    try {
      // FIX: Corrected API URL for EBRD
      const url = `https://ecepp.ebrd.com/adapt/run/api.procurement.Procurement.json?procurementStatus=CURRENT&keyword=${encodeURIComponent(keyword)}&currentPage=0&pageSize=20`;
      const res = await axios.get(url, { timeout: 20000 });
      const items = res.data?.procurements || [];
      // ... (map results)
    } catch (err) { console.warn(`[EBRD] failed: ${err.message}`); }
  }
  return results;
}
