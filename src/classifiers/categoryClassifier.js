/**
 * Tender Category Classifier
 * Rule-based + keyword-weighted classification engine
 * Maps tender titles/descriptions to procurement categories
 */

const CATEGORY_RULES = {
  'ERP': {
    keywords: ['erp', 'enterprise resource', 'sap', 'oracle financials', 'microsoft dynamics', 'netsuite', 'odoo', 'sage', 'epicor', 'infor'],
    weight: 1.0,
  },
  'Cloud Services': {
    keywords: ['cloud', 'aws', 'azure', 'google cloud', 'gcp', 'saas', 'paas', 'iaas', 'hosting', 'migration to cloud', 'cloud transformation'],
    weight: 1.0,
  },
  'Cybersecurity': {
    keywords: ['cybersecurity', 'cyber security', 'siem', 'soc', 'firewall', 'penetration testing', 'vapt', 'vulnerability', 'identity management', 'iam', 'zero trust', 'endpoint protection', 'antivirus'],
    weight: 1.0,
  },
  'IT Consulting': {
    keywords: ['it consulting', 'technology consulting', 'digital transformation', 'it advisory', 'systems integrator', 'managed services', 'msp'],
    weight: 0.9,
  },
  'Software Development': {
    keywords: ['software development', 'custom software', 'application development', 'mobile app', 'web development', 'devops', 'agile', 'scrum', 'api development', 'microservices'],
    weight: 1.0,
  },
  'Data & Analytics': {
    keywords: ['data analytics', 'business intelligence', 'bi', 'data warehouse', 'big data', 'tableau', 'power bi', 'machine learning', 'ai', 'artificial intelligence', 'data science', 'etl'],
    weight: 1.0,
  },
  'Networking & Infrastructure': {
    keywords: ['networking', 'network infrastructure', 'wan', 'lan', 'sd-wan', 'router', 'switches', 'data center', 'servers', 'storage', 'hardware procurement'],
    weight: 0.9,
  },
  'Healthcare IT': {
    keywords: ['emr', 'ehr', 'hospital information', 'his', 'telemedicine', 'health informatics', 'medical software', 'patient management', 'clinical'],
    weight: 1.0,
  },
  'HR & Payroll': {
    keywords: ['hrms', 'hris', 'human resource', 'payroll', 'workforce management', 'talent management', 'recruitment platform'],
    weight: 0.9,
  },
  'CRM': {
    keywords: ['crm', 'customer relationship', 'salesforce', 'hubspot', 'customer data platform', 'sales automation'],
    weight: 1.0,
  },
  'GIS & Mapping': {
    keywords: ['gis', 'geographic information', 'geospatial', 'mapping', 'esri', 'arcgis', 'remote sensing'],
    weight: 0.9,
  },
  'Professional Services': {
    keywords: ['consulting', 'advisory', 'professional services', 'management consulting', 'audit', 'assessment', 'feasibility study'],
    weight: 0.7,
  },
  'Construction & Engineering': {
    keywords: ['construction', 'civil engineering', 'infrastructure', 'roads', 'bridges', 'building', 'renovation'],
    weight: 0.8,
  },
  'Logistics & Supply Chain': {
    keywords: ['logistics', 'supply chain', 'warehouse', 'transportation', 'fleet management', 'tracking system'],
    weight: 0.8,
  },
  'Education Technology': {
    keywords: ['e-learning', 'lms', 'learning management', 'edtech', 'educational software', 'virtual classroom'],
    weight: 0.9,
  },
};

// Stopwords to ignore during keyword splitting
const STOPWORDS = new Set([
  'the', 'and', 'for', 'from', 'with', 'this', 'that', 'are', 'was',
  'has', 'have', 'its', 'not', 'all', 'but', 'can', 'our', 'their',
  'will', 'into', 'than', 'more', 'also', 'any', 'been', 'may',
  'bid', 'tender', 'tenders', 'rfp', 'rfi', 'rfq', 'procurement',
  'contract', 'services', 'service', 'supply', 'provision', 'request',
]);

/**
 * Split a multi-word keyword phrase into individual meaningful search terms.
 * e.g. "Cardiff Metropolitan University ERP Tenders" → ['cardiff', 'metropolitan', 'university', 'erp']
 */
export function splitKeywords(keywords = []) {
  const terms = new Set();
  for (const kw of keywords) {
    const words = kw.toLowerCase().split(/[\s,;|/\\+&]+/);
    for (const word of words) {
      const clean = word.replace(/[^a-z0-9]/g, '');
      if (clean.length >= 3 && !STOPWORDS.has(clean)) {
        terms.add(clean);
      }
    }
    // Also keep the original phrase if it's short (≤4 words) — may be an acronym/product name
    const wordCount = kw.trim().split(/\s+/).length;
    if (wordCount <= 4) terms.add(kw.toLowerCase().trim());
  }
  return [...terms];
}

/**
 * Classify a tender based on title + description text.
 * Returns best-match category and confidence score.
 */
export function classifyTender(title = '', description = '') {
  const text = `${title} ${description}`.toLowerCase();
  const scores = {};

  for (const [category, rule] of Object.entries(CATEGORY_RULES)) {
    let score = 0;
    for (const kw of rule.keywords) {
      if (text.includes(kw)) {
        score += (kw.length / 5) * rule.weight;
      }
    }
    if (score > 0) scores[category] = score;
  }

  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);

  if (sorted.length === 0) return { category: 'Other', confidence: 0, allMatches: [] };

  const topScore = sorted[0][1];
  const maxPossible = 20;
  const confidence = Math.min(100, Math.round((topScore / maxPossible) * 100));

  return {
    category: sorted[0][0],
    confidence,
    allMatches: sorted.slice(0, 3).map(([cat, sc]) => ({ cat, score: sc })),
  };
}

/**
 * Check if a tender is ICP-relevant given user keywords + industry.
 *
 * FIX: Keywords are split into individual significant terms before matching,
 * so a phrase like "Cardiff Metropolitan University ERP Tenders" correctly
 * matches tenders containing any of: "cardiff", "metropolitan", "university", "erp".
 */
export function isIcpRelevant(tender, keywords = [], industry = 'All') {
  // No filters at all → everything passes
  if (!keywords.length && industry === 'All') return true;

  const text = `${tender.tender_title} ${tender.description || ''} ${tender.organization_name}`.toLowerCase();

  let kwMatch = true;
  if (keywords.length > 0) {
    // Split each keyword phrase into individual meaningful terms
    const terms = splitKeywords(keywords);

    if (terms.length > 0) {
      // Pass if ANY term matches (OR logic across all extracted terms)
      kwMatch = terms.some(term => text.includes(term));
    }
  }

  const industryMap = {
    'Technology': ['ERP', 'Cloud Services', 'Cybersecurity', 'IT Consulting', 'Software Development', 'Data & Analytics', 'Networking & Infrastructure', 'CRM', 'Education Technology'],
    'Healthcare': ['Healthcare IT'],
    'Finance': ['ERP', 'CRM', 'Data & Analytics'],
    'Education': ['Education Technology', 'IT Consulting'],
    'Government': ['GIS & Mapping', 'Networking & Infrastructure', 'Software Development', 'Professional Services'],
    'Construction': ['Construction & Engineering', 'GIS & Mapping'],
    'Energy': ['GIS & Mapping', 'Professional Services'],
    'Defense': ['Cybersecurity', 'Networking & Infrastructure'],
    'Logistics': ['Logistics & Supply Chain', 'ERP'],
  };

  const allowedCategories = industryMap[industry] || null;
  const industryMatch = !allowedCategories || industry === 'All' || allowedCategories.includes(tender.category);

  return kwMatch && industryMatch;
}
