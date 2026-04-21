/**
 * GEM India Scraper — Government e-Marketplace
 * India's central procurement platform for government buyers
 * Source: https://bidplus.gem.gov.in/all-bids
 * Approach: REST API + HTML fallback with rotating user agents
 */

import axios from 'axios';
import { parseDate, parseBudget, cleanText, sleep, randomDelay } from '../utils/helpers.js';

const GEM_BID_API = 'https://bidplus.gem.gov.in/gemSearchBid';
const GEM_BID_LIST = 'https://bidplus.gem.gov.in/all-bids';

export async function scrapeGemIndia({ keywords = [], maxResults = 50 } = {}) {
  const results = [];

  // GEM has a public JSON API used by their frontend
  for (const keyword of (keywords.length ? keywords : ['software', 'IT', 'consulting'])) {
    if (results.length >= maxResults) break;
    try {
      const apiResults = await fetchGemApi(keyword, maxResults - results.length);
      results.push(...apiResults);
      await randomDelay(800, 1500);
    } catch (err) {
      console.warn(`[GEM India] Error for "${keyword}": ${err.message}`);
      const fallback = await fetchGemHtml(keyword, maxResults - results.length);
      results.push(...fallback);
    }
  }

  return results;
}

async function fetchGemApi(keyword, limit = 25) {
  const response = await axios.post(
    GEM_BID_API,
    new URLSearchParams({
      searchedBidNumber: '',
      bid_life_cycle: 'Active',
      searchedBidCategory: '',
      searchedMinistries: '',
      bidEndDate: '',
      bidStartDate: '',
      currentPage: '1',
      searchedBidName: keyword,
    }),
    {
      timeout: 15000,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': 'https://bidplus.gem.gov.in/all-bids',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
      },
    }
  );

  const data = response.data;
  const bids = data?.data || data?.bids || [];

  return bids.slice(0, limit).map(bid => ({
    organization_name: cleanText(bid.ministry || bid.buyerOrganization || bid.department || 'Government of India'),
    tender_title: cleanText(bid.bidName || bid.title || bid.itemName || ''),
    tender_status: bid.bidLifeCycle === 'Active' || bid.bidStatus === 'Active' ? 'Open' : 'Closed',
    description: cleanText(bid.category || bid.itemDescription || ''),
    category: null,
    budget_usd: parseBudget(bid.estimatedAmt || bid.bidValue, 'INR'),
    budget_raw: bid.estimatedAmt ? `₹${bid.estimatedAmt}` : null,
    deadline: parseDate(bid.bidEndDate || bid.submissionEndDate),
    announcement_date: parseDate(bid.bidStartDate || bid.publishDate),
    source_link: `https://bidplus.gem.gov.in/bidlisting/${bid.bidNumber || bid.id}`,
    source: 'GEM India',
    region: 'India',
    buyer_state: bid.buyerState || null,
    bid_number: bid.bidNumber || null,
  }));
}

async function fetchGemHtml(keyword, limit = 20) {
  try {
    const { load } = await import('cheerio');
    const url = `${GEM_BID_LIST}?search_bid=${encodeURIComponent(keyword)}&bid_life_cycle=Active`;

    const response = await axios.get(url, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-IN,en;q=0.9',
      },
    });

    const $ = load(response.data);
    const items = [];

    $('.bid-list-item, .bids-listing tr:not(:first-child), .bid-row').each((i, el) => {
      if (items.length >= limit) return false;
      const $el = $(el);
      const title = cleanText($el.find('.bid-name, td:nth-child(2), .title').first().text());
      const org = cleanText($el.find('.ministry, td:nth-child(3), .org').first().text());
      const deadline = parseDate($el.find('.end-date, td:nth-child(5)').first().text());
      const link = $el.find('a').first().attr('href');
      const budgetRaw = cleanText($el.find('.estimated-amount, td:nth-child(6)').first().text());

      if (title) {
        items.push({
          organization_name: org || 'Government of India',
          tender_title: title,
          tender_status: 'Open',
          description: '',
          category: null,
          budget_usd: parseBudget(budgetRaw, 'INR'),
          budget_raw: budgetRaw || null,
          deadline,
          announcement_date: null,
          source_link: link ? (link.startsWith('http') ? link : `https://bidplus.gem.gov.in${link}`) : GEM_BID_LIST,
          source: 'GEM India',
          region: 'India',
        });
      }
    });

    return items;
  } catch {
    return [];
  }
}
