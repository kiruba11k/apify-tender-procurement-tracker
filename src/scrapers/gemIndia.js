/**
 * GEM India Scraper — Government e-Marketplace
 * India's central procurement platform for government buyers
 * Source: https://bidplus.gem.gov.in/all-bids
 *
 * FIXES applied:
 *  - ECONNREFUSED on Apify proxy IPs (GEM India blocks many proxy ranges)
 *  - Added direct (no-proxy) attempt first for GEM — Indian servers respond
 *    better to direct requests than Apify residential proxies
 *  - Increased timeouts; added explicit retry loop
 *  - Added eProcure India (CPPP) as secondary source for India procurement
 */

import axios from 'axios';
import { parseDate, parseBudget, cleanText, sleep, randomDelay } from '../utils/helpers.js';

const GEM_BID_API  = 'https://bidplus.gem.gov.in/gemSearchBid';
const GEM_BID_LIST = 'https://bidplus.gem.gov.in/all-bids';

// CPPP = Central Public Procurement Portal (India) — alternative to GEM
const CPPP_SEARCH  = 'https://eprocure.gov.in/cppp/';

export async function scrapeGemIndia({ keywords = [], maxResults = 50, proxyUrl = null } = {}) {
  const results = [];

  for (const keyword of (keywords.length ? keywords : ['software', 'IT', 'consulting'])) {
    if (results.length >= maxResults) break;
    const limit = Math.min(25, maxResults - results.length);

    // Try GEM API — direct first (GEM blocks many proxy ranges), then proxy
    let gemFetched = false;
    const axiosConfigs = [
      // Direct (no proxy) — most reliable for GEM India
      {
        timeout: 25000,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Requested-With': 'XMLHttpRequest',
          Referer: 'https://bidplus.gem.gov.in/all-bids',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          Accept: 'application/json, text/javascript, */*; q=0.01',
          'Accept-Language': 'en-IN,en;q=0.9',
          Origin: 'https://bidplus.gem.gov.in',
        },
      },
    ];

    // Optionally add proxy config
    if (proxyUrl) {
      try {
        const { HttpsProxyAgent } = await import('https-proxy-agent');
        axiosConfigs.push({
          ...axiosConfigs[0],
          httpsAgent: new HttpsProxyAgent(proxyUrl),
          proxy: false,
        });
      } catch { /* https-proxy-agent not available */ }
    }

    for (const config of axiosConfigs) {
      try {
        const response = await axios.post(
          GEM_BID_API,
          new URLSearchParams({
            searchedBidNumber:   '',
            bid_life_cycle:      'Active',
            searchedBidCategory: '',
            searchedMinistries:  '',
            bidEndDate:          '',
            bidStartDate:        '',
            currentPage:         '1',
            searchedBidName:     keyword,
          }),
          config
        );

        const data = response.data;
        const bids = data?.data || data?.bids || [];

        if (bids.length > 0) {
          results.push(...bids.slice(0, limit).map(mapGemBid));
          gemFetched = true;
          break;
        }
      } catch (err) {
        console.warn(`[GEM India] API attempt failed for "${keyword}": ${err.code || err.message}`);
      }
    }

    // HTML fallback for GEM
    if (!gemFetched) {
      try {
        const fallback = await fetchGemHtml(keyword, limit);
        if (fallback.length > 0) {
          results.push(...fallback);
          gemFetched = true;
        }
      } catch { /* continue to CPPP */ }
    }

    // Secondary source: eProcure India (CPPP) — if GEM is unreachable
    if (!gemFetched) {
      try {
        const cpppItems = await fetchCpppIndia(keyword, limit);
        results.push(...cpppItems);
      } catch (err) {
        console.warn(`[CPPP India] Also failed for "${keyword}": ${err.message}`);
      }
    }

    await randomDelay(1000, 2000);
  }

  return results;
}

function mapGemBid(bid) {
  return {
    organization_name: cleanText(bid.ministry || bid.buyerOrganization || bid.department || 'Government of India'),
    tender_title:      cleanText(bid.bidName || bid.title || bid.itemName || ''),
    tender_status:     bid.bidLifeCycle === 'Active' || bid.bidStatus === 'Active' ? 'Open' : 'Closed',
    description:       cleanText(bid.category || bid.itemDescription || ''),
    category:          null,
    budget_usd:        parseBudget(bid.estimatedAmt || bid.bidValue, 'INR'),
    budget_raw:        bid.estimatedAmt ? `₹${bid.estimatedAmt}` : null,
    deadline:          parseDate(bid.bidEndDate || bid.submissionEndDate),
    announcement_date: parseDate(bid.bidStartDate || bid.publishDate),
    source_link:       `https://bidplus.gem.gov.in/bidlisting/${bid.bidNumber || bid.id}`,
    source:            'GEM India',
    region:            'India',
    buyer_state:       bid.buyerState || null,
    bid_number:        bid.bidNumber || null,
  };
}

async function fetchGemHtml(keyword, limit = 20) {
  const { load } = await import('cheerio');
  const url = `${GEM_BID_LIST}?search_bid=${encodeURIComponent(keyword)}&bid_life_cycle=Active`;

  const response = await axios.get(url, {
    timeout: 20000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-IN,en;q=0.9',
    },
  });

  const $ = load(response.data);
  const items = [];

  $('.bid-list-item, .bids-listing tr:not(:first-child), .bid-row').each((i, el) => {
    if (items.length >= limit) return false;
    const $el = $(el);
    const title     = cleanText($el.find('.bid-name, td:nth-child(2), .title').first().text());
    const org       = cleanText($el.find('.ministry, td:nth-child(3), .org').first().text());
    const deadline  = parseDate($el.find('.end-date, td:nth-child(5)').first().text());
    const link      = $el.find('a').first().attr('href');
    const budgetRaw = cleanText($el.find('.estimated-amount, td:nth-child(6)').first().text());

    if (title) items.push({
      organization_name: org || 'Government of India',
      tender_title:      title,
      tender_status:     'Open',
      description:       '',
      category:          null,
      budget_usd:        parseBudget(budgetRaw, 'INR'),
      budget_raw:        budgetRaw || null,
      deadline,
      announcement_date: null,
      source_link: link
        ? (link.startsWith('http') ? link : `https://bidplus.gem.gov.in${link}`)
        : GEM_BID_LIST,
      source: 'GEM India', region: 'India',
    });
  });

  return items;
}

// ── eProcure India / CPPP — secondary India source ──────────────────────────
async function fetchCpppIndia(keyword, limit = 15) {
  try {
    const { load } = await import('cheerio');
    // CPPP tender search (publicly accessible)
    const url = `https://eprocure.gov.in/cppp/tendersapi?type=IT&searchtype=keyword&searchtext=${encodeURIComponent(keyword)}&pageNo=1&rowsPerPage=${limit}`;

    const response = await axios.get(url, {
      timeout: 20000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        Accept: 'application/json, text/html, */*',
      },
    });

    // JSON response
    if (response.headers['content-type']?.includes('json')) {
      const tenders = response.data?.tenderDetails || response.data?.tenders || response.data || [];
      if (Array.isArray(tenders)) {
        return tenders.slice(0, limit).map(t => ({
          organization_name: cleanText(t.organisationName || t.orgName || 'Government of India'),
          tender_title:      cleanText(t.tenderTitle || t.title || ''),
          tender_status:     'Open',
          description:       cleanText(t.tenderCategory || t.category || ''),
          category:          null,
          budget_usd:        parseBudget(t.tenderValue || t.estimatedAmt, 'INR'),
          budget_raw:        t.tenderValue ? `₹${t.tenderValue}` : null,
          deadline:          parseDate(t.bidSubmissionEndDate || t.closingDate),
          announcement_date: parseDate(t.publishedDate || t.startDate),
          source_link:       t.tenderRefNo
            ? `https://eprocure.gov.in/cppp/tendersapi?tenderId=${t.tenderRefNo}`
            : CPPP_SEARCH,
          source:  'eProcure India',
          region:  'India',
          country: t.stateName || null,
        }));
      }
    }

    // HTML fallback for CPPP
    const $ = load(response.data);
    const items = [];
    $('table tbody tr').each((i, el) => {
      if (items.length >= limit) return false;
      const $el = $(el);
      const title = cleanText($el.find('td:nth-child(3)').text());
      const org   = cleanText($el.find('td:nth-child(2)').text());
      const link  = $el.find('a').first().attr('href');
      if (title) items.push({
        organization_name: org || 'Government of India',
        tender_title:      title,
        tender_status:     'Open',
        description:       '',
        category:          null,
        budget_usd:        null,
        budget_raw:        null,
        deadline:          null,
        announcement_date: null,
        source_link: link ? (link.startsWith('http') ? link : `https://eprocure.gov.in${link}`) : CPPP_SEARCH,
        source:  'eProcure India',
        region:  'India',
      });
    });
    return items;
  } catch (err) {
    console.warn(`[CPPP India] Fetch failed: ${err.message}`);
    return [];
  }
}
