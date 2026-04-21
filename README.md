# 🎯 Tender & Procurement Tracker

A production-grade Apify Actor that scrapes **9 global procurement portals** in parallel, auto-classifies tenders by category, filters by ICP relevance, removes expired/low-value entries, and outputs clean structured data.

---

## 🌐 Sources Covered

| Source | Region | Method | Notes |
|--------|--------|--------|-------|
| **SAM.gov** | 🇺🇸 US | REST API | Official US Federal API — free `DEMO_KEY` included |
| **TED Europa** | 🇪🇺 EU | REST API v3 | Official TED API — no auth required |
| **GEM India** | 🇮🇳 India | POST API + HTML | GEM BidPlus internal API |
| **Find-a-Tender** | 🇬🇧 UK | OCDS API | Official UK FTS open data |
| **UNGM** | 🌍 Global | REST API | UN Global Marketplace |
| **World Bank** | 🌍 Global | REST API | Open procurement search |
| **MERX Canada** | 🇨🇦 Canada | HTML scrape | Public notice listings |
| **AusTendering** | 🇦🇺 Australia | JSON API | Gov tender search |
| **Devex** | 🌍 Global | HTML scrape | Int'l development tenders |

---

## ⚙️ Input Parameters

```json
{
  "keywords": ["ERP", "cloud migration", "cybersecurity"],
  "company_names": [],
  "industry": "Technology",
  "regions": ["US", "EU", "India"],
  "budget_threshold": 50000,
  "max_results": 200,
  "include_closed": false,
  "sources": ["sam_gov", "ted_europa", "gem_india", "find_a_tender_uk", "ungm", "worldbank"]
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `keywords` | string[] | `[]` | Search terms sent to each portal |
| `company_names` | string[] | `[]` | Filter by specific buyer org names |
| `industry` | string | `All` | `Technology`, `Healthcare`, `Finance`, etc. |
| `regions` | string[] | `["US","EU","India"]` | Filter by geography |
| `budget_threshold` | integer | `10000` | Minimum USD value (0 = no filter) |
| `max_results` | integer | `200` | Cap on total output records |
| `include_closed` | boolean | `false` | Include recently-closed tenders |
| `sources` | string[] | 6 sources | Pick which portals to scrape |

---

## 📦 Output Schema

```json
{
  "organization_name": "US Department of Defense",
  "tender_title": "Cloud Migration Services for Legacy Systems",
  "tender_status": "Open",
  "category": "Cloud Services",
  "budget": "$2.5M",
  "budget_usd": 2500000,
  "deadline": "2025-03-15",
  "announcement_date": "2025-01-10",
  "source_link": "https://sam.gov/opp/abc123/view",
  "source": "SAM.gov",
  "region": "US",
  "country": null,
  "naics_code": "541512",
  "cpv_codes": null,
  "bid_number": "W912DR-25-R-0001",
  "classification_confidence": 85,
  "scraped_at": "2025-01-15T08:23:11.000Z"
}
```

---

## 🏷️ Categories Supported

`ERP` · `Cloud Services` · `Cybersecurity` · `IT Consulting` · `Software Development` · `Data & Analytics` · `Networking & Infrastructure` · `Healthcare IT` · `HR & Payroll` · `CRM` · `GIS & Mapping` · `Professional Services` · `Construction & Engineering` · `Logistics & Supply Chain` · `Education Technology` · `Other`

---

## 🔄 Processing Pipeline

```
Parallel Scraping (3 concurrent)
        ↓
  Expiry Filter (remove dead deadlines)
        ↓
  Company Name Filter (optional)
        ↓
  Category Classification (keyword-weighted rules)
        ↓
  ICP Relevance Filter (industry × category matrix)
        ↓
  Budget Threshold Filter (USD conversion)
        ↓
  Deduplication (org + title fingerprint)
        ↓
  Output (sorted: Open first, newest first)
```

---



## 💡 Tips

- **SAM.gov rate limits**: The `DEMO_KEY` allows 30 req/hour. Register free at [api.data.gov](https://api.data.gov/signup/) to get a personal key with 1000 req/hour — add it in `samGov.js`.
- **Set a schedule**: Run daily with `keywords: ["ERP", "cloud"]` and `regions: ["US", "EU"]` for a live lead feed.
- **Webhook integration**: Connect to Zapier/Make via Apify webhooks to push new tenders into your CRM automatically.
- **Budget note**: All budgets are normalized to USD using approximate FX rates (EUR 1.08, GBP 1.27, INR 0.012, CAD 0.74, AUD 0.65).
