const fs = require('fs');
const path = require('path');

function makeNode(id, name, type, typeVersion, position, parameters, extra = {}) {
  return {
    id,
    name,
    type,
    typeVersion,
    position,
    parameters,
    ...extra,
  };
}

function googleSheetsResourceLocator(cachedSheetName) {
  return {
    documentId: {
      __rl: true,
      mode: 'list',
      value: '',
    },
    sheetName: {
      __rl: true,
      mode: 'list',
      value: '',
      cachedResultName: cachedSheetName,
    },
  };
}

function googleSheetsAppendColumns() {
  return {
    mappingMode: 'autoMapInputData',
    value: {},
    matchingColumns: [],
    schema: [],
    attemptToConvertTypes: false,
    convertFieldsToString: false,
  };
}

function attachResponseCode(sourceNodeName) {
  return `
const sourceItems = $('${sourceNodeName}').all();
const responseItems = $input.all();
const count = Math.max(sourceItems.length, responseItems.length);
const output = [];

for (let index = 0; index < count; index++) {
  const source = sourceItems[index]?.json || {};
  const response = responseItems[index]?.json || {};
  output.push({
    json: Object.assign({}, source, response),
  });
}

return output;
`.trim();
}

const sharedGetBodyFunction = `
function getBody(json) {
  if (typeof json === 'string') return json;
  if (!json || typeof json !== 'object') return '';
  if (typeof json.responseBody === 'string') return json.responseBody;
  if (typeof json.data === 'string') return json.data;
  if (typeof json.body === 'string') return json.body;
  if (typeof json.response === 'string') return json.response;
  if (json.data && typeof json.data.body === 'string') return json.data.body;
  if (json.response && typeof json.response.body === 'string') return json.response.body;
  if (json.response && typeof json.response.data === 'string') return json.response.data;
  return '';
}
`.trim();

const combineAllFragmentsCode = `
const listingFragments = $('Extract Raw Lead Fragments').all();
const websiteFragments = $input.all().filter((item) => !(item.json && item.json._websiteBranchEmpty));
const combined = listingFragments.concat(websiteFragments);
return combined.length ? combined : listingFragments;
`.trim();

const normalizeRequestRowsCode = `
const inputItems = $input.all();

function pickValue(row, candidates) {
  for (const key of candidates) {
    if (row[key] !== undefined && row[key] !== null && String(row[key]).trim() !== '') {
      return String(row[key]).trim();
    }
  }
  return '';
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

const output = [];

for (let index = 0; index < inputItems.length; index++) {
  const row = inputItems[index].json || {};
  const category = pickValue(row, ['Category', 'category', 'CATEGORY']);
  const city = pickValue(row, ['City', 'city', 'CITY']);
  const leadCountRaw = pickValue(row, ['Lead Count', 'LeadCount', 'lead_count', 'leadCount']);
  const leadCount = Number.parseInt(leadCountRaw, 10);

  if (!category || !city || !Number.isFinite(leadCount) || leadCount <= 0) {
    continue;
  }

  const requestKey = slugify(category) + '__' + slugify(city) + '__' + String(index + 2);

  output.push({
    json: {
      requestKey,
      category,
      city,
      leadCount,
      inputRowNumber: index + 2,
      requestedAt: new Date().toISOString(),
    },
  });
}

return output;
`.trim();

const buildSearchJobsCode = `
const requests = $input.all().map((item) => item.json);

const sourceDefinitions = [
  { sourceLabel: 'bing-general', queryBuilder: (r) => '"' + r.category + '" "' + r.city + '" India' },
  { sourceLabel: 'bing-official', queryBuilder: (r) => '"' + r.category + '" "' + r.city + '" official website' },
  { sourceLabel: 'justdial', queryBuilder: (r) => '"' + r.category + '" "' + r.city + '" site:justdial.com' },
  { sourceLabel: 'sulekha', queryBuilder: (r) => '"' + r.category + '" "' + r.city + '" site:sulekha.com' },
  { sourceLabel: 'indiamart', queryBuilder: (r) => '"' + r.category + '" "' + r.city + '" site:indiamart.com' },
  { sourceLabel: 'webindia123', queryBuilder: (r) => '"' + r.category + '" "' + r.city + '" site:webindia123.com' },
];

const output = [];

for (const request of requests) {
  const maxResultsPerQuery = Math.min(Math.max(request.leadCount, 10), 20);

  for (const source of sourceDefinitions) {
    const query = source.queryBuilder(request);
    const searchUrl = 'https://www.bing.com/search?setlang=en-IN&count='
      + String(maxResultsPerQuery)
      + '&q='
      + encodeURIComponent(query);

    output.push({
      json: {
        ...request,
        sourceLabel: source.sourceLabel,
        searchQuery: query,
        searchUrl,
        maxResultsPerQuery,
      },
    });
  }
}

return output;
`.trim();

const parseSearchResultsCode = `
const itemsIn = $input.all();

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x2F;/gi, '/')
    .replace(/&#([0-9]+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function stripTags(value) {
  return decodeHtmlEntities(value)
    .replace(/<script[\\s\\S]*?<\\/script>/gi, ' ')
    .replace(/<style[\\s\\S]*?<\\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\\s+/g, ' ')
    .trim();
}

function extractTag(block, tag) {
  const match = block.match(new RegExp('<' + tag + '>([\\\\s\\\\S]*?)<\\\\/' + tag + '>', 'i'));
  return match ? stripTags(match[1]) : '';
}

${sharedGetBodyFunction}

function cleanupUrl(raw) {
  const value = decodeHtmlEntities(raw || '').trim();
  if (!value) return '';

  try {
    const parsed = new URL(value);
    const redirectTarget = parsed.searchParams.get('r') || parsed.searchParams.get('u');
    if (parsed.hostname.includes('bing.com') && redirectTarget) {
      return decodeURIComponent(redirectTarget);
    }
    return parsed.toString();
  } catch (error) {
    return value;
  }
}

function domainOf(raw) {
  try {
    return new URL(raw).hostname.replace(/^www\\./i, '').toLowerCase();
  } catch (error) {
    return '';
  }
}

function normaliseOrgHint(title, description) {
  const base = title || description || '';
  return base
    .replace(/\\s*[|:-]\\s*(justdial|sulekha|indiamart|webindia123|asklaila).*$/i, '')
    .replace(/\\s{2,}/g, ' ')
    .trim();
}

function extractHtmlResults(body) {
  const results = [];
  const seenLinks = new Set();

  function pushResult(title, description, link) {
    const cleaned = cleanupUrl(link);
    if (!cleaned || seenLinks.has(cleaned)) return;
    seenLinks.add(cleaned);
    results.push({
      title: stripTags(title || ''),
      description: stripTags(description || ''),
      link: cleaned,
    });
  }

  const algoBlocks = body.match(/<li\\b[^>]*class=["'][^"']*b_algo[^"']*["'][\\s\\S]*?<\\/li>/gi) || [];
  for (const block of algoBlocks) {
    const titleMatch = block.match(/<h2[^>]*>[\\s\\S]*?<a[^>]+href=["']([^"']+)["'][^>]*>([\\s\\S]*?)<\\/a>[\\s\\S]*?<\\/h2>/i)
      || block.match(/<a[^>]+class=["'][^"']*tilk[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>([\\s\\S]*?)<\\/a>/i);
    if (!titleMatch) continue;
    pushResult(titleMatch[2], pickDescription(block), titleMatch[1]);
  }

  if (results.length === 0) {
    const fallbackAnchors = body.match(/<a[^>]+href=["'](https?:\\/\\/[^"']+)["'][^>]*>[\\s\\S]*?<\\/a>/gi) || [];
    for (const anchor of fallbackAnchors.slice(0, 50)) {
      const match = anchor.match(/href=["'](https?:\\/\\/[^"']+)["']/i);
      if (!match) continue;
      const link = match[1];
      const domain = domainOf(link);
      if (!domain || domain.includes('bing.com') || domain.includes('microsoft.com')) continue;
      const textMatch = anchor.match(/>([^<]{4,120})<\\/a>/i);
      pushResult(textMatch ? textMatch[1] : domain, '', link);
    }
  }

  return results;
}

function pickDescription(block) {
  const match = block.match(/<p[^>]*>([\\s\\S]*?)<\\/p>/i)
    || block.match(/<div[^>]*class=["'][^"']*b_caption[^"']*["'][\\s\\S]*?<p[^>]*>([\\s\\S]*?)<\\/p>/i);
  return match ? stripTags(match[1]) : '';
}

const output = [];

for (const item of itemsIn) {
  const job = item.json || {};
  const body = getBody(job);

  if (!body) {
    continue;
  }

  let parsedResults = [];

  if (body.indexOf('<item') !== -1) {
    const blocks = body.match(/<item\\b[\\s\\S]*?<\\/item>/gi) || [];
    parsedResults = blocks.map((block) => ({
      title: extractTag(block, 'title'),
      description: extractTag(block, 'description'),
      link: cleanupUrl(extractTag(block, 'link')),
    }));
  } else if (/<html[\\s>]/i.test(body) || /b_algo|b_results|b_search/i.test(body)) {
    parsedResults = extractHtmlResults(body);
  }

  for (const result of parsedResults.slice(0, job.maxResultsPerQuery || 15)) {
    const title = result.title;
    const description = result.description;
    const link = result.link;
    const domain = domainOf(link);

    if (!link || !domain) {
      continue;
    }

    output.push({
      json: {
        requestKey: job.requestKey,
        category: job.category,
        city: job.city,
        leadCount: job.leadCount,
        inputRowNumber: job.inputRowNumber,
        requestedAt: job.requestedAt,
        sourceLabel: job.sourceLabel,
        searchQuery: job.searchQuery,
        listingUrl: link,
        listingDomain: domain,
        orgHint: normaliseOrgHint(title, description),
        snippet: description,
      },
    });
  }
}

return output;
`.trim();

const consolidateCandidatesCode = `
const itemsIn = $input.all().map((item) => item.json);

const skipHosts = new Set([
  'bing.com',
  'www.bing.com',
  'facebook.com',
  'www.facebook.com',
  'm.facebook.com',
  'instagram.com',
  'www.instagram.com',
  'linkedin.com',
  'www.linkedin.com',
  'youtube.com',
  'www.youtube.com',
  'x.com',
  'www.x.com',
  'twitter.com',
  'www.twitter.com',
  'whatsapp.com',
  'www.whatsapp.com',
]);

const sourceWeight = {
  'bing-official': 60,
  'bing-general': 50,
  'justdial': 45,
  'sulekha': 40,
  'indiamart': 35,
  'webindia123': 30,
};

function canonicaliseUrl(raw) {
  try {
    const url = new URL(raw);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|msclkid)/i.test(key)) {
        url.searchParams.delete(key);
      }
    }
    return url.toString();
  } catch (error) {
    return '';
  }
}

function hostOf(raw) {
  try {
    return new URL(raw).hostname.replace(/^www\\./i, '').toLowerCase();
  } catch (error) {
    return '';
  }
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const grouped = new Map();
const perRequest = new Map();

for (const item of itemsIn) {
  const canonicalUrl = canonicaliseUrl(item.listingUrl);
  const host = hostOf(canonicalUrl);

  if (!canonicalUrl || !host || skipHosts.has(host)) {
    continue;
  }

  if (/\\.(pdf|jpg|jpeg|png|gif|webp)$/i.test(canonicalUrl)) {
    continue;
  }

  const score = sourceWeight[item.sourceLabel] || 10;
  const groupKey = item.requestKey + '|' + canonicalUrl;
  const previous = grouped.get(groupKey);

  if (!previous || score > previous.priority) {
    grouped.set(groupKey, {
      ...item,
      listingUrl: canonicalUrl,
      listingDomain: host,
      priority: score,
    });
  }
}

for (const candidate of grouped.values()) {
  const requestLimit = Math.min(Math.max((candidate.leadCount || 0) * 6, 30), 120);
  if (!perRequest.has(candidate.requestKey)) {
    perRequest.set(candidate.requestKey, []);
  }
  perRequest.get(candidate.requestKey).push(candidate);
}

const output = [];

for (const [requestKey, candidates] of perRequest.entries()) {
  candidates
    .sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return slugify(a.orgHint).localeCompare(slugify(b.orgHint));
    })
    .slice(0, Math.min(candidates.length, candidates[0].leadCount * 6 || 30, 120))
    .forEach((candidate) => {
      output.push({ json: candidate });
    });
}

return output;
`.trim();

function buildFailureCaptureCode(stageName, urlField) {
  return `
const itemsIn = $input.all();

function getStatus(json) {
  if (json && typeof json.statusCode === 'number') return json.statusCode;
  if (json && json.response && typeof json.response.statusCode === 'number') return json.response.statusCode;
  return '';
}

${sharedGetBodyFunction}

const output = [];

for (const item of itemsIn) {
  const json = item.json || {};
  const status = getStatus(json);
  const body = getBody(json);
  const errorMessage = json.error && json.error.message ? String(json.error.message) : '';
  const shouldLog = errorMessage || (status && (status < 200 || status >= 300)) || !body;

  if (!shouldLog) {
    continue;
  }

  output.push({
    json: {
      Timestamp: new Date().toISOString(),
      Stage: '${stageName}',
      Category: json.category || '',
      City: json.city || '',
      Source: json.sourceLabel || '',
      URL: json.${urlField} || '',
      Status: status || '',
      Message: errorMessage || (!body ? 'Empty response body' : 'Non-2xx response'),
    },
  });
}

return output;
  `.trim();
}

const extractRawLeadFragmentsCode = `
const itemsIn = $input.all();

const directoryHosts = [
  'justdial.com',
  'sulekha.com',
  'indiamart.com',
  'webindia123.com',
  'asklaila.com',
  'yellowpages.webindia123.com',
];

const socialHosts = [
  'facebook.com',
  'instagram.com',
  'linkedin.com',
  'youtube.com',
  'x.com',
  'twitter.com',
  'wa.me',
  'whatsapp.com',
];

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>/g, '$1')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x2F;/gi, '/')
    .replace(/&#([0-9]+);/g, (_, code) => String.fromCharCode(Number(code)));
}

${sharedGetBodyFunction}

function stripHtml(value) {
  return decodeHtmlEntities(value)
    .replace(/<script[\\s\\S]*?<\\/script>/gi, ' ')
    .replace(/<style[\\s\\S]*?<\\/style>/gi, ' ')
    .replace(/<noscript[\\s\\S]*?<\\/noscript>/gi, ' ')
    .replace(/<svg[\\s\\S]*?<\\/svg>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\\s+/g, ' ')
    .trim();
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function hostOf(raw) {
  try {
    return new URL(raw).hostname.replace(/^www\\./i, '').toLowerCase();
  } catch (error) {
    return '';
  }
}

function originOf(raw) {
  try {
    const url = new URL(raw);
    return url.origin;
  } catch (error) {
    return '';
  }
}

function looksLikeDirectoryHost(host) {
  return directoryHosts.some((candidate) => host === candidate || host.endsWith('.' + candidate));
}

function looksLikeSocialHost(host) {
  return socialHosts.some((candidate) => host === candidate || host.endsWith('.' + candidate));
}

function pickFirstMatch(patterns, html) {
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match && match[1]) {
      return decodeHtmlEntities(match[1]).replace(/\\s+/g, ' ').trim();
    }
  }
  return '';
}

function extractEmails(blob) {
  const matches = blob.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}/gi) || [];
  return [...new Set(matches.map((entry) => entry.toLowerCase()))];
}

function extractPhones(blob) {
  const matches = blob.match(/(?:\\+?91[\\s()-]*)?(?:0[\\s()-]*)?(?:\\d[\\s()-]*){10,12}/g) || [];
  return [...new Set(matches.map((entry) => entry.trim()))];
}

function extractCandidateUrls(html) {
  const results = [];
  const regexes = [
    /href=["'](https?:\\/\\/[^"'<>\\s]+)["']/gi,
    /(https?:\\/\\/[^"'<>\\s]+)/gi,
  ];

  for (const regex of regexes) {
    let match;
    while ((match = regex.exec(html)) !== null) {
      results.push(match[1]);
    }
  }

  return [...new Set(results)];
}

function chooseWebsite(listingUrl, html) {
  const listingHost = hostOf(listingUrl);

  if (listingHost && !looksLikeDirectoryHost(listingHost) && !looksLikeSocialHost(listingHost)) {
    return originOf(listingUrl);
  }

  const urls = extractCandidateUrls(html);
  for (const rawUrl of urls) {
    const host = hostOf(rawUrl);
    if (!host) continue;
    if (host === listingHost) continue;
    if (looksLikeDirectoryHost(host) || looksLikeSocialHost(host)) continue;
    if (host.includes('bing.com')) continue;
    return originOf(rawUrl);
  }

  return '';
}

function cleanName(value) {
  return String(value || '')
    .replace(/\\s*[|:-]\\s*(justdial|sulekha|indiamart|webindia123|asklaila).*$/i, '')
    .replace(/\\s{2,}/g, ' ')
    .trim();
}

function chooseOrganizationName(html, text, hint) {
  const metaTitle = pickFirstMatch([
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']title["'][^>]+content=["']([^"']+)["']/i,
  ], html);
  const h1 = pickFirstMatch([/<h1[^>]*>([\\s\\S]*?)<\\/h1>/i], html);
  const title = pickFirstMatch([/<title[^>]*>([\\s\\S]*?)<\\/title>/i], html);
  const fallback = hint || text.slice(0, 80);
  return cleanName(metaTitle || h1 || title || fallback);
}

function extractAddress(text, city) {
  const compactCity = String(city || '').trim();
  const lines = text
    .split(/(?<=[.!?])\\s+|\\s{2,}|\\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const hasCity = compactCity && line.toLowerCase().includes(compactCity.toLowerCase());
    const hasPin = /\\b\\d{6}\\b/.test(line);
    const longEnough = line.length >= 18;
    if (longEnough && (hasCity || hasPin || /address/i.test(line))) {
      return line.slice(0, 240);
    }
  }

  return '';
}

const output = [];

for (const item of itemsIn) {
  const json = item.json || {};
  const html = getBody(json);

  if (!html) {
    continue;
  }

  const text = stripHtml(html);
  const organizationName = chooseOrganizationName(html, text, json.orgHint || '');
  const phones = extractPhones(text + ' ' + html);
  const emails = extractEmails(text + ' ' + html);
  const website = chooseWebsite(json.listingUrl || '', html);
  const address = extractAddress(text, json.city || '');
  const websiteHost = hostOf(website);
  const listingHost = hostOf(json.listingUrl || '');
  const organizationKey = (json.requestKey || '')
    + '|'
    + (websiteHost || listingHost || slugify(organizationName))
    + '|'
    + slugify(organizationName || json.orgHint || '');

  output.push({
    json: {
      requestKey: json.requestKey,
      category: json.category,
      city: json.city,
      leadCount: json.leadCount,
      inputRowNumber: json.inputRowNumber,
      requestedAt: json.requestedAt,
      organizationKey,
      organizationName,
      orgHint: json.orgHint || '',
      sourceLabel: json.sourceLabel,
      sourceUrl: json.listingUrl || '',
      listingDomain: listingHost,
      phones,
      emails,
      websites: website ? [website] : [],
      addressCandidates: address ? [address] : [],
      evidenceCount: 1,
      pageRole: 'listing',
    },
  });
}

return output;
`.trim();

const buildWebsiteEnrichmentJobsCode = `
const itemsIn = $input.all().map((item) => item.json);

function hostOf(raw) {
  try {
    return new URL(raw).hostname.replace(/^www\\./i, '').toLowerCase();
  } catch (error) {
    return '';
  }
}

const output = [];

for (const lead of itemsIn) {
  const website = Array.isArray(lead.websites) && lead.websites.length ? lead.websites[0] : '';
  if (!website) {
    continue;
  }

  let base;
  try {
    base = new URL(website);
  } catch (error) {
    continue;
  }

  const listingHost = hostOf(lead.sourceUrl || '');
  const websiteHost = hostOf(website);
  const shouldFetchContactPages = listingHost !== websiteHost || lead.listingDomain !== websiteHost;
  const paths = shouldFetchContactPages ? ['/', '/contact', '/contact-us', '/about-us'] : ['/contact', '/contact-us'];
  const seen = new Set();

  for (const pagePath of paths.slice(0, 3)) {
    const url = new URL(pagePath, base.origin).toString();
    if (seen.has(url)) continue;
    seen.add(url);

    output.push({
      json: {
        ...lead,
        fetchUrl: url,
        websiteOrigin: base.origin,
        websiteHost,
      },
    });
  }
}

if (output.length === 0) {
  return [{ json: { _noWebsiteJobs: true } }];
}

return output;
`.trim();

const extractWebsiteFragmentsCode = `
const itemsIn = $input.all();

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>/g, '$1')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x2F;/gi, '/')
    .replace(/&#([0-9]+);/g, (_, code) => String.fromCharCode(Number(code)));
}

${sharedGetBodyFunction}

function stripHtml(value) {
  return decodeHtmlEntities(value)
    .replace(/<script[\\s\\S]*?<\\/script>/gi, ' ')
    .replace(/<style[\\s\\S]*?<\\/style>/gi, ' ')
    .replace(/<noscript[\\s\\S]*?<\\/noscript>/gi, ' ')
    .replace(/<svg[\\s\\S]*?<\\/svg>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\\s+/g, ' ')
    .trim();
}

function pickFirstMatch(patterns, html) {
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match && match[1]) {
      return decodeHtmlEntities(match[1]).replace(/\\s+/g, ' ').trim();
    }
  }
  return '';
}

function extractEmails(blob) {
  const matches = blob.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}/gi) || [];
  return [...new Set(matches.map((entry) => entry.toLowerCase()))];
}

function extractPhones(blob) {
  const matches = blob.match(/(?:\\+?91[\\s()-]*)?(?:0[\\s()-]*)?(?:\\d[\\s()-]*){10,12}/g) || [];
  return [...new Set(matches.map((entry) => entry.trim()))];
}

function extractAddress(text, city) {
  const compactCity = String(city || '').trim();
  const lines = text
    .split(/(?<=[.!?])\\s+|\\s{2,}|\\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const hasCity = compactCity && line.toLowerCase().includes(compactCity.toLowerCase());
    const hasPin = /\\b\\d{6}\\b/.test(line);
    const longEnough = line.length >= 18;
    if (longEnough && (hasCity || hasPin || /address/i.test(line))) {
      return line.slice(0, 240);
    }
  }

  return '';
}

const output = [];

for (const item of itemsIn) {
  const json = item.json || {};
  const html = getBody(json);
  if (!html) continue;

  const text = stripHtml(html);
  const organizationName = pickFirstMatch([
    /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
    /<h1[^>]*>([\\s\\S]*?)<\\/h1>/i,
    /<title[^>]*>([\\s\\S]*?)<\\/title>/i,
  ], html) || json.organizationName || '';

  output.push({
    json: {
      requestKey: json.requestKey,
      category: json.category,
      city: json.city,
      leadCount: json.leadCount,
      inputRowNumber: json.inputRowNumber,
      requestedAt: json.requestedAt,
      organizationKey: json.organizationKey,
      organizationName,
      orgHint: json.orgHint || '',
      sourceLabel: 'official-site',
      sourceUrl: json.fetchUrl || '',
      listingDomain: json.websiteHost || '',
      phones: extractPhones(text + ' ' + html),
      emails: extractEmails(text + ' ' + html),
      websites: json.websiteOrigin ? [json.websiteOrigin] : [],
      addressCandidates: (() => {
        const address = extractAddress(text, json.city || '');
        return address ? [address] : [];
      })(),
      evidenceCount: 1,
      pageRole: 'official-site',
    },
  });
}

return output;
`.trim();

const aggregateAndVerifyLeadsCode = `
const itemsIn = $input.all().map((item) => item.json);

const directoryHosts = [
  'justdial.com',
  'sulekha.com',
  'indiamart.com',
  'webindia123.com',
  'asklaila.com',
  'yellowpages.webindia123.com',
];

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function hostOf(raw) {
  try {
    return new URL(raw).hostname.replace(/^www\\./i, '').toLowerCase();
  } catch (error) {
    return '';
  }
}

function looksLikeDirectory(raw) {
  const host = hostOf(raw);
  return directoryHosts.some((candidate) => host === candidate || host.endsWith('.' + candidate));
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function normaliseName(value) {
  return String(value || '')
    .replace(/\\s*[|:-]\\s*(justdial|sulekha|indiamart|webindia123|asklaila).*$/i, '')
    .replace(/\\s{2,}/g, ' ')
    .trim();
}

function chooseBestName(names) {
  const cleaned = unique(names.map(normaliseName)).filter(Boolean);
  cleaned.sort((a, b) => b.length - a.length);
  return cleaned[0] || '';
}

function normalisePhone(raw) {
  const digits = String(raw || '').replace(/\\D+/g, '');
  let national = '';

  if (digits.length === 10) {
    national = digits;
  } else if (digits.length === 11 && digits.startsWith('0')) {
    national = digits.slice(1);
  } else if (digits.length === 12 && digits.startsWith('91')) {
    national = digits.slice(2);
  } else if (digits.length === 13 && digits.startsWith('910')) {
    national = digits.slice(3);
  } else {
    return '';
  }

  if (!/^\\d{10}$/.test(national)) return '';
  if (/^(\\d)\\1{9}$/.test(national)) return '';
  if (national === '0000000000') return '';

  return '+91' + national;
}

function validEmail(raw) {
  const email = String(raw || '').trim().toLowerCase();
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}$/i.test(email)) return '';
  if (/^(noreply|no-reply|donotreply|do-not-reply|test|sample|dummy|example)/i.test(email.split('@')[0])) return '';
  if (/(example\\.com|example\\.org|test\\.com|yourdomain\\.com)$/i.test(email)) return '';
  return email;
}

function chooseBestWebsite(websites) {
  const valid = unique(websites)
    .filter((url) => /^https?:\\/\\//i.test(url))
    .filter((url) => !looksLikeDirectory(url));

  valid.sort((a, b) => {
    const aScore = a.startsWith('https://') ? 1 : 0;
    const bScore = b.startsWith('https://') ? 1 : 0;
    if (bScore !== aScore) return bScore - aScore;
    return a.length - b.length;
  });

  return valid[0] || '';
}

function chooseBestAddress(addresses, city) {
  const valid = unique(addresses).filter(Boolean);
  valid.sort((a, b) => {
    const aScore = Number(a.toLowerCase().includes(String(city || '').toLowerCase())) + Number(/\\b\\d{6}\\b/.test(a));
    const bScore = Number(b.toLowerCase().includes(String(city || '').toLowerCase())) + Number(/\\b\\d{6}\\b/.test(b));
    if (bScore !== aScore) return bScore - aScore;
    return b.length - a.length;
  });
  return valid[0] || '';
}

function confidenceScore(phoneVerified, emailVerified, website) {
  if (phoneVerified && emailVerified && website) return 'HIGH';
  if (phoneVerified && website) return 'MEDIUM';
  if (phoneVerified || emailVerified) return 'LOW';
  return 'LOW';
}

function confidenceWeight(label) {
  if (label === 'HIGH') return 3;
  if (label === 'MEDIUM') return 2;
  if (label === 'LOW') return 1;
  return 0;
}

const grouped = new Map();

for (const fragment of itemsIn) {
  const key = fragment.organizationKey || (
    String(fragment.requestKey || '')
    + '|'
    + slugify(fragment.organizationName || fragment.orgHint || '')
  );

  if (!grouped.has(key)) {
    grouped.set(key, {
      requestKey: fragment.requestKey,
      category: fragment.category,
      city: fragment.city,
      leadCount: fragment.leadCount,
      names: [],
      phones: [],
      emails: [],
      websites: [],
      addresses: [],
      sources: [],
      sourceUrls: [],
      evidenceCount: 0,
    });
  }

  const bucket = grouped.get(key);
  bucket.names.push(fragment.organizationName || fragment.orgHint || '');
  bucket.phones.push(...(Array.isArray(fragment.phones) ? fragment.phones : []));
  bucket.emails.push(...(Array.isArray(fragment.emails) ? fragment.emails : []));
  bucket.websites.push(...(Array.isArray(fragment.websites) ? fragment.websites : []));
  bucket.addresses.push(...(Array.isArray(fragment.addressCandidates) ? fragment.addressCandidates : []));
  bucket.sources.push(fragment.sourceLabel || '');
  bucket.sourceUrls.push(fragment.sourceUrl || '');
  bucket.evidenceCount += Number(fragment.evidenceCount || 0);
}

const candidates = [];

for (const bucket of grouped.values()) {
  const organizationName = chooseBestName(bucket.names);
  const verifiedPhones = unique(bucket.phones.map(normalisePhone)).filter(Boolean);
  const verifiedEmails = unique(bucket.emails.map(validEmail)).filter(Boolean);
  const website = chooseBestWebsite(bucket.websites);
  const address = chooseBestAddress(bucket.addresses, bucket.city);
  const phoneNumber = verifiedPhones[0] || '';
  const email = verifiedEmails[0] || '';
  const phoneVerified = Boolean(phoneNumber);
  const emailVerified = Boolean(email);
  const confidence = confidenceScore(phoneVerified, emailVerified, website);

  candidates.push({
    json: {
      requestKey: bucket.requestKey,
      category: bucket.category,
      city: bucket.city,
      leadCount: bucket.leadCount,
      organizationName,
      phoneNumber,
      phoneVerified,
      email,
      emailVerified,
      website,
      address,
      confidenceScore: confidence,
      confidenceWeight: confidenceWeight(confidence),
      evidenceCount: bucket.evidenceCount,
      sourceCount: unique(bucket.sources).length,
      dedupeOrgKey: slugify(bucket.city) + '|' + slugify(organizationName || website || phoneNumber || email),
    },
  });
}

candidates.sort((a, b) => {
  const left = a.json;
  const right = b.json;
  if (right.confidenceWeight !== left.confidenceWeight) return right.confidenceWeight - left.confidenceWeight;
  if (right.evidenceCount !== left.evidenceCount) return right.evidenceCount - left.evidenceCount;
  if (right.sourceCount !== left.sourceCount) return right.sourceCount - left.sourceCount;
  return String(left.organizationName || '').localeCompare(String(right.organizationName || ''));
});

const seenPerRequest = new Map();
const output = [];

for (const item of candidates) {
  const lead = item.json;
  if (!seenPerRequest.has(lead.requestKey)) {
    seenPerRequest.set(lead.requestKey, {
      orgs: new Set(),
      phones: new Set(),
      emails: new Set(),
    });
  }

  const seen = seenPerRequest.get(lead.requestKey);
  if (seen.orgs.has(lead.dedupeOrgKey)) continue;
  if (lead.phoneNumber && seen.phones.has(lead.phoneNumber)) continue;
  if (lead.email && seen.emails.has(lead.email)) continue;

  seen.orgs.add(lead.dedupeOrgKey);
  if (lead.phoneNumber) seen.phones.add(lead.phoneNumber);
  if (lead.email) seen.emails.add(lead.email);
  output.push(item);
}

return output;
`.trim();

const selectBestVerifiedLeadsCode = `
const itemsIn = $input.all().map((item) => item.json);

function confidenceWeight(label) {
  if (label === 'HIGH') return 3;
  if (label === 'MEDIUM') return 2;
  if (label === 'LOW') return 1;
  return 0;
}

const grouped = new Map();

for (const lead of itemsIn) {
  if (!lead.phoneVerified && !lead.emailVerified) {
    continue;
  }

  if (!grouped.has(lead.requestKey)) {
    grouped.set(lead.requestKey, []);
  }

  grouped.get(lead.requestKey).push(lead);
}

const output = [];

for (const leads of grouped.values()) {
  leads.sort((a, b) => {
    const weightDelta = confidenceWeight(b.confidenceScore) - confidenceWeight(a.confidenceScore);
    if (weightDelta !== 0) return weightDelta;
    if ((b.evidenceCount || 0) !== (a.evidenceCount || 0)) return (b.evidenceCount || 0) - (a.evidenceCount || 0);
    if ((b.sourceCount || 0) !== (a.sourceCount || 0)) return (b.sourceCount || 0) - (a.sourceCount || 0);
    return String(a.organizationName || '').localeCompare(String(b.organizationName || ''));
  });

  const limit = Number(leads[0].leadCount || 0);
  for (const lead of leads.slice(0, limit)) {
    output.push({
      json: {
        ...lead,
        timestamp: new Date().toISOString(),
      },
    });
  }
}

return output;
`.trim();

const prepareOutputRowsCode = `
return $input.all().map((item) => ({
  json: {
    'Organization Name': item.json.organizationName || '',
    'Category': item.json.category || '',
    'City': item.json.city || '',
    'Phone Number': item.json.phoneNumber || '',
    'Phone Verified': item.json.phoneVerified ? 'TRUE' : 'FALSE',
    'Email': item.json.email || '',
    'Email Verified': item.json.emailVerified ? 'TRUE' : 'FALSE',
    'Website': item.json.website || '',
    'Address': item.json.address || '',
    'Confidence Score': item.json.confidenceScore || 'LOW',
    'Timestamp': item.json.timestamp || new Date().toISOString(),
  },
}));
`.trim();

const workflow = {
  name: 'Indian Lead Generation and Verification',
  nodes: [
    makeNode(
      'manual-trigger',
      'Manual Trigger',
      'n8n-nodes-base.manualTrigger',
      1,
      [240, 540],
      {},
    ),
    makeNode(
      'read-lead-requests',
      'Read Lead Requests',
      'n8n-nodes-base.googleSheets',
      4.5,
      [460, 540],
      {
        operation: 'read',
        ...googleSheetsResourceLocator('Lead Requests'),
        options: {},
      },
    ),
    makeNode(
      'normalize-request-rows',
      'Normalize Request Rows',
      'n8n-nodes-base.code',
      2,
      [680, 540],
      {
        mode: 'runOnceForAllItems',
        jsCode: normalizeRequestRowsCode,
      },
    ),
    makeNode(
      'build-search-jobs',
      'Build Search Jobs',
      'n8n-nodes-base.code',
      2,
      [900, 540],
      {
        mode: 'runOnceForAllItems',
        jsCode: buildSearchJobsCode,
      },
    ),
    makeNode(
      'search-bing-rss',
      'Search Bing',
      'n8n-nodes-base.httpRequest',
      4.2,
      [1140, 540],
      {
        method: 'GET',
        url: '={{$json.searchUrl}}',
        sendHeaders: true,
        headerParameters: {
          parameters: [
            {
              name: 'User-Agent',
              value: 'Mozilla/5.0 (compatible; n8n Lead Workflow/1.0; +https://n8n.io)',
            },
            {
              name: 'Accept',
              value: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            },
          ],
        },
        options: {
          timeout: 30000,
          response: {
            response: {
              responseFormat: 'text',
              outputPropertyName: 'responseBody',
              fullResponse: true,
              neverError: true,
            },
          },
        },
      },
      { continueOnFail: true },
    ),
    makeNode(
      'attach-search-response',
      'Attach Search Response',
      'n8n-nodes-base.code',
      2,
      [1360, 540],
      {
        mode: 'runOnceForAllItems',
        jsCode: attachResponseCode('Build Search Jobs'),
      },
    ),
    makeNode(
      'capture-search-fetch-errors',
      'Capture Search Fetch Errors',
      'n8n-nodes-base.code',
      2,
      [1580, 320],
      {
        mode: 'runOnceForAllItems',
        jsCode: buildFailureCaptureCode('Search Fetch', 'searchUrl'),
      },
    ),
    makeNode(
      'append-search-logs',
      'Append Search Logs',
      'n8n-nodes-base.googleSheets',
      4.5,
      [1800, 320],
      {
        operation: 'append',
        ...googleSheetsResourceLocator('Workflow Logs'),
        columns: googleSheetsAppendColumns(),
        options: {},
      },
      { continueOnFail: true },
    ),
    makeNode(
      'parse-rss-search-results',
      'Parse Search Results',
      'n8n-nodes-base.code',
      2,
      [1580, 540],
      {
        mode: 'runOnceForAllItems',
        jsCode: parseSearchResultsCode,
      },
    ),
    makeNode(
      'consolidate-candidates',
      'Consolidate Candidates',
      'n8n-nodes-base.code',
      2,
      [1800, 540],
      {
        mode: 'runOnceForAllItems',
        jsCode: consolidateCandidatesCode,
      },
    ),
    makeNode(
      'fetch-candidate-pages',
      'Fetch Candidate Pages',
      'n8n-nodes-base.httpRequest',
      4.2,
      [2020, 540],
      {
        method: 'GET',
        url: '={{$json.listingUrl}}',
        sendHeaders: true,
        headerParameters: {
          parameters: [
            {
              name: 'User-Agent',
              value: 'Mozilla/5.0 (compatible; n8n Lead Workflow/1.0; +https://n8n.io)',
            },
            {
              name: 'Accept',
              value: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            },
          ],
        },
        options: {
          timeout: 30000,
          response: {
            response: {
              responseFormat: 'text',
              outputPropertyName: 'responseBody',
              fullResponse: true,
              neverError: true,
            },
          },
        },
      },
      { continueOnFail: true },
    ),
    makeNode(
      'attach-candidate-response',
      'Attach Candidate Response',
      'n8n-nodes-base.code',
      2,
      [2240, 540],
      {
        mode: 'runOnceForAllItems',
        jsCode: attachResponseCode('Consolidate Candidates'),
      },
    ),
    makeNode(
      'capture-candidate-fetch-errors',
      'Capture Candidate Fetch Errors',
      'n8n-nodes-base.code',
      2,
      [2460, 320],
      {
        mode: 'runOnceForAllItems',
        jsCode: buildFailureCaptureCode('Candidate Page Fetch', 'listingUrl'),
      },
    ),
    makeNode(
      'append-candidate-logs',
      'Append Candidate Logs',
      'n8n-nodes-base.googleSheets',
      4.5,
      [2680, 320],
      {
        operation: 'append',
        ...googleSheetsResourceLocator('Workflow Logs'),
        columns: googleSheetsAppendColumns(),
        options: {},
      },
      { continueOnFail: true },
    ),
    makeNode(
      'extract-raw-lead-fragments',
      'Extract Raw Lead Fragments',
      'n8n-nodes-base.code',
      2,
      [2460, 540],
      {
        mode: 'runOnceForAllItems',
        jsCode: extractRawLeadFragmentsCode,
      },
    ),
    makeNode(
      'build-website-enrichment-jobs',
      'Build Website Enrichment Jobs',
      'n8n-nodes-base.code',
      2,
      [2680, 540],
      {
        mode: 'runOnceForAllItems',
        jsCode: buildWebsiteEnrichmentJobsCode,
      },
    ),
    makeNode(
      'fetch-website-pages',
      'Fetch Website Pages',
      'n8n-nodes-base.httpRequest',
      4.2,
      [3120, 420],
      {
        method: 'GET',
        url: '={{$json.fetchUrl}}',
        sendHeaders: true,
        headerParameters: {
          parameters: [
            {
              name: 'User-Agent',
              value: 'Mozilla/5.0 (compatible; n8n Lead Workflow/1.0; +https://n8n.io)',
            },
            {
              name: 'Accept',
              value: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            },
          ],
        },
        options: {
          timeout: 30000,
          response: {
            response: {
              responseFormat: 'text',
              outputPropertyName: 'responseBody',
              fullResponse: true,
              neverError: true,
            },
          },
        },
      },
      { continueOnFail: true },
    ),
    makeNode(
      'if-has-website-jobs',
      'Has Website Jobs',
      'n8n-nodes-base.if',
      2.2,
      [2900, 540],
      {
        conditions: {
          options: {
            caseSensitive: true,
            leftValue: '',
            typeValidation: 'strict',
            version: 2,
          },
          conditions: [
            {
              id: 'has-fetch-url',
              leftValue: '={{ $json.fetchUrl }}',
              rightValue: '',
              operator: {
                type: 'string',
                operation: 'notEmpty',
              },
            },
          ],
          combinator: 'and',
        },
        options: {},
      },
    ),
    makeNode(
      'attach-site-response',
      'Attach Site Response',
      'n8n-nodes-base.code',
      2,
      [3120, 540],
      {
        mode: 'runOnceForAllItems',
        jsCode: attachResponseCode('Build Website Enrichment Jobs'),
      },
    ),
    makeNode(
      'capture-site-fetch-errors',
      'Capture Site Fetch Errors',
      'n8n-nodes-base.code',
      2,
      [3340, 320],
      {
        mode: 'runOnceForAllItems',
        jsCode: buildFailureCaptureCode('Official Site Fetch', 'fetchUrl'),
      },
    ),
    makeNode(
      'append-site-logs',
      'Append Site Logs',
      'n8n-nodes-base.googleSheets',
      4.5,
      [3560, 320],
      {
        operation: 'append',
        ...googleSheetsResourceLocator('Workflow Logs'),
        columns: googleSheetsAppendColumns(),
        options: {},
      },
      { continueOnFail: true },
    ),
    makeNode(
      'extract-website-fragments',
      'Extract Website Fragments',
      'n8n-nodes-base.code',
      2,
      [3340, 540],
      {
        mode: 'runOnceForAllItems',
        jsCode: extractWebsiteFragmentsCode,
      },
    ),
    makeNode(
      'combine-all-fragments',
      'Combine All Fragments',
      'n8n-nodes-base.code',
      2,
      [3560, 540],
      {
        mode: 'runOnceForAllItems',
        jsCode: combineAllFragmentsCode,
      },
    ),
    makeNode(
      'skip-website-enrichment',
      'Skip Website Enrichment',
      'n8n-nodes-base.code',
      2,
      [3120, 720],
      {
        mode: 'runOnceForAllItems',
        jsCode: 'return [{ json: { _websiteBranchEmpty: true } }];',
      },
    ),
    makeNode(
      'aggregate-and-verify-leads',
      'Aggregate And Verify Leads',
      'n8n-nodes-base.code',
      2,
      [3780, 540],
      {
        mode: 'runOnceForAllItems',
        jsCode: aggregateAndVerifyLeadsCode,
      },
    ),
    makeNode(
      'select-best-verified-leads',
      'Select Best Verified Leads',
      'n8n-nodes-base.code',
      2,
      [4000, 540],
      {
        mode: 'runOnceForAllItems',
        jsCode: selectBestVerifiedLeadsCode,
      },
    ),
    makeNode(
      'prepare-output-rows',
      'Prepare Output Rows',
      'n8n-nodes-base.code',
      2,
      [4220, 540],
      {
        mode: 'runOnceForAllItems',
        jsCode: prepareOutputRowsCode,
      },
    ),
    makeNode(
      'append-lead-rows',
      'Append Lead Rows',
      'n8n-nodes-base.googleSheets',
      4.5,
      [4440, 540],
      {
        operation: 'append',
        ...googleSheetsResourceLocator('Verified Leads'),
        columns: googleSheetsAppendColumns(),
        options: {},
      },
      { continueOnFail: true },
    ),
  ],
  connections: {
    'Manual Trigger': {
      main: [[{ node: 'Read Lead Requests', type: 'main', index: 0 }]],
    },
    'Read Lead Requests': {
      main: [[{ node: 'Normalize Request Rows', type: 'main', index: 0 }]],
    },
    'Normalize Request Rows': {
      main: [[{ node: 'Build Search Jobs', type: 'main', index: 0 }]],
    },
    'Build Search Jobs': {
      main: [[{ node: 'Search Bing', type: 'main', index: 0 }]],
    },
    'Search Bing': {
      main: [[{ node: 'Attach Search Response', type: 'main', index: 0 }]],
    },
    'Attach Search Response': {
      main: [
        [
          { node: 'Capture Search Fetch Errors', type: 'main', index: 0 },
          { node: 'Parse Search Results', type: 'main', index: 0 },
        ],
      ],
    },
    'Capture Search Fetch Errors': {
      main: [[{ node: 'Append Search Logs', type: 'main', index: 0 }]],
    },
    'Parse Search Results': {
      main: [[{ node: 'Consolidate Candidates', type: 'main', index: 0 }]],
    },
    'Consolidate Candidates': {
      main: [[{ node: 'Fetch Candidate Pages', type: 'main', index: 0 }]],
    },
    'Fetch Candidate Pages': {
      main: [[{ node: 'Attach Candidate Response', type: 'main', index: 0 }]],
    },
    'Attach Candidate Response': {
      main: [
        [
          { node: 'Capture Candidate Fetch Errors', type: 'main', index: 0 },
          { node: 'Extract Raw Lead Fragments', type: 'main', index: 0 },
        ],
      ],
    },
    'Capture Candidate Fetch Errors': {
      main: [[{ node: 'Append Candidate Logs', type: 'main', index: 0 }]],
    },
    'Extract Raw Lead Fragments': {
      main: [[{ node: 'Build Website Enrichment Jobs', type: 'main', index: 0 }]],
    },
    'Build Website Enrichment Jobs': {
      main: [[{ node: 'Has Website Jobs', type: 'main', index: 0 }]],
    },
    'Has Website Jobs': {
      main: [
        [{ node: 'Fetch Website Pages', type: 'main', index: 0 }],
        [{ node: 'Skip Website Enrichment', type: 'main', index: 0 }],
      ],
    },
    'Fetch Website Pages': {
      main: [[{ node: 'Attach Site Response', type: 'main', index: 0 }]],
    },
    'Attach Site Response': {
      main: [
        [
          { node: 'Capture Site Fetch Errors', type: 'main', index: 0 },
          { node: 'Extract Website Fragments', type: 'main', index: 0 },
        ],
      ],
    },
    'Capture Site Fetch Errors': {
      main: [[{ node: 'Append Site Logs', type: 'main', index: 0 }]],
    },
    'Extract Website Fragments': {
      main: [[{ node: 'Combine All Fragments', type: 'main', index: 0 }]],
    },
    'Skip Website Enrichment': {
      main: [[{ node: 'Combine All Fragments', type: 'main', index: 0 }]],
    },
    'Combine All Fragments': {
      main: [[{ node: 'Aggregate And Verify Leads', type: 'main', index: 0 }]],
    },
    'Aggregate And Verify Leads': {
      main: [[{ node: 'Select Best Verified Leads', type: 'main', index: 0 }]],
    },
    'Select Best Verified Leads': {
      main: [[{ node: 'Prepare Output Rows', type: 'main', index: 0 }]],
    },
    'Prepare Output Rows': {
      main: [[{ node: 'Append Lead Rows', type: 'main', index: 0 }]],
    },
  },
  active: false,
  settings: {
    executionOrder: 'v1',
    saveManualExecutions: true,
  },
  versionId: '1',
  meta: {
    templateCredsSetupCompleted: false,
  },
  pinData: {},
};

const outputPath = path.join(__dirname, 'n8n-lead-generation-workflow.json');
fs.writeFileSync(outputPath, JSON.stringify(workflow, null, 2) + '\n', 'utf8');
console.log('Wrote ' + outputPath);
