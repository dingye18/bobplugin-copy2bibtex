import * as Bob from '@bob-plug/core';
import { userAgent } from './util';

var CryptoJS = require("crypto-js");

interface QueryOption {
  cache?: string;
  timeout?: number;
  llmProvider?: string;
  apiKey?: string;
  baseURL?: string;
}

interface Identifier {
  type: 'doi' | 'arxiv';
  value: string;
}

// Per-stage timeouts: keep LLM long, fail fast on direct lookups.
const FAST_TIMEOUT = 5000;
const LLM_TIMEOUT_DEFAULT = 15000;

var resultCache = new Bob.CacheResult('translate-result');
var titleIdCache = new Bob.CacheResult('title-id');
var bibtexCache = new Bob.CacheResult('bibtex-by-id');

function extractIdentifier(text: string): Identifier | null {
  // Prefer DOI match first (includes arXiv's own DOI 10.48550/arXiv.*)
  const doiMatch = text.match(/10\.\d{4,9}\/\S+/);
  if (doiMatch) {
    return { type: 'doi', value: doiMatch[0].replace(/[.,;)\]"']+$/, '') };
  }

  // arXiv URL: arxiv.org/abs/2301.07041
  const arxivUrlMatch = text.match(/arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?)/i);
  if (arxivUrlMatch) {
    return { type: 'arxiv', value: arxivUrlMatch[1] };
  }

  // arXiv prefixed: arXiv:2301.07041
  const arxivPrefixMatch = text.match(/arXiv:\s*(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?)/i);
  if (arxivPrefixMatch) {
    return { type: 'arxiv', value: arxivPrefixMatch[1] };
  }

  // Bare arXiv ID (modern) on its own line or surrounded by whitespace
  const bareMatch = text.match(/(?:^|\s)(\d{4}\.\d{4,5}(?:v\d+)?)(?:\s|$)/);
  if (bareMatch) {
    return { type: 'arxiv', value: bareMatch[1] };
  }

  // Bare arXiv ID (legacy) e.g. hep-th/9711200
  const bareLegacyMatch = text.match(/(?:^|\s)([a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?)(?:\s|$)/);
  if (bareLegacyMatch) {
    return { type: 'arxiv', value: bareLegacyMatch[1] };
  }

  return null;
}

function normalizeTitle(s: string): string {
  return s.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Cheap token-Jaccard similarity, good enough to detect "wrong paper" results.
function titleSimilarity(a: string, b: string): number {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const ta = new Set(na.split(' '));
  const tb = new Set(nb.split(' '));
  let inter = 0;
  ta.forEach((t) => { if (tb.has(t)) inter++; });
  const union = ta.size + tb.size - inter;
  return union ? inter / union : 0;
}

async function fetchBibTeXFromCrossref(doi: string, timeout: number): Promise<string> {
  const encodedDOI = encodeURIComponent(doi.trim());
  const [err, res] = await Bob.util.asyncTo<Bob.HttpResponse>(
    Bob.api.$http.get({
      url: `https://api.crossref.org/works/${encodedDOI}/transform/application/x-bibtex`,
      timeout,
      header: { 'User-Agent': userAgent, 'Accept': 'application/x-bibtex' },
    }),
  );
  if (err) throw Bob.util.error('api', 'Failed to fetch BibTeX from Crossref', err);
  if (res?.response.statusCode === 404) throw Bob.util.error('notFound' as any, 'DOI not found on Crossref', res);
  if (res?.response.statusCode !== 200) throw Bob.util.error('api', `Crossref returned status ${res?.response.statusCode}`, res);
  return res?.data as string;
}

async function fetchBibTeXFromArXiv(arxivId: string, timeout: number): Promise<string> {
  // Strip version suffix for the BibTeX endpoint (e.g. 2301.07041v2 -> 2301.07041)
  const id = arxivId.replace(/v\d+$/, '');
  const [err, res] = await Bob.util.asyncTo<Bob.HttpResponse>(
    Bob.api.$http.get({
      url: `https://arxiv.org/bibtex/${id}`,
      timeout,
      header: { 'User-Agent': userAgent },
    }),
  );
  if (err) throw Bob.util.error('api', 'Failed to fetch BibTeX from arXiv', err);
  if (res?.response.statusCode === 404) throw Bob.util.error('notFound' as any, 'arXiv ID not found', res);
  if (res?.response.statusCode !== 200) throw Bob.util.error('api', `arXiv returned status ${res?.response.statusCode}`, res);
  return res?.data as string;
}

// Resolve with the first successful promise; reject only if all fail.
function firstSuccessful<T>(promises: Promise<T>[]): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let pending = promises.length;
    let firstError: any;
    promises.forEach((p) => {
      p.then(resolve).catch((e) => {
        if (firstError === undefined) firstError = e;
        if (--pending === 0) reject(firstError);
      });
    });
  });
}

async function fetchBibTeX(identifier: Identifier, timeout: number): Promise<string> {
  if (identifier.type === 'arxiv') {
    return fetchBibTeXFromArXiv(identifier.value, timeout);
  }
  // For arXiv DOIs (10.48550/arXiv.*), race Crossref and arXiv — first 200 wins.
  const arxivDOIMatch = identifier.value.match(/10\.48550\/arXiv\.(\d{4}\.\d{4,5}(?:v\d+)?)/i);
  if (arxivDOIMatch) {
    return firstSuccessful([
      fetchBibTeXFromCrossref(identifier.value, timeout),
      fetchBibTeXFromArXiv(arxivDOIMatch[1], timeout),
    ]);
  }
  return fetchBibTeXFromCrossref(identifier.value, timeout);
}

// Crossref bibliographic title search — typically <1s. Returns null if no high-confidence match.
async function searchCrossrefByTitle(title: string, timeout: number): Promise<Identifier | null> {
  const url = `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(title)}&rows=3&select=DOI,title`;
  const [err, res] = await Bob.util.asyncTo<Bob.HttpResponse>(
    Bob.api.$http.get({
      url,
      timeout,
      header: { 'User-Agent': userAgent, 'Accept': 'application/json' },
    }),
  );
  if (err || res?.response.statusCode !== 200) return null;
  const items: any[] = (res?.data as any)?.message?.items || [];
  for (const item of items) {
    const candidateTitle: string = (item.title || [])[0] || '';
    if (candidateTitle && titleSimilarity(title, candidateTitle) >= 0.75 && item.DOI) {
      return { type: 'doi', value: item.DOI };
    }
  }
  return null;
}

function buildPrompt(title: string): string {
  // Tight prompt: short input tokens + strict output format.
  return `Find the identifier for this paper:
"${title}"

Reply with ONLY one of:
- a DOI (e.g. "10.1234/example")
- an arXiv ID (e.g. "2301.07041")
- "NOT_FOUND" if no close title match exists.
No other text.`;
}

async function callLLM(
  prompt: string,
  provider: string,
  apiKey: string,
  timeout: number,
  baseURL?: string,
): Promise<string> {
  if (provider === 'claude') {
    const base = (baseURL || 'https://api.anthropic.com').replace(/\/$/, '');
    const [err, res] = await Bob.util.asyncTo<Bob.HttpResponse>(
      Bob.api.$http.post({
        url: `${base}/v1/messages`,
        timeout,
        header: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'web-search-2025-03-05',
          'content-type': 'application/json',
        },
        body: {
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 64,
          temperature: 0,
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }],
          messages: [{ role: 'user', content: prompt }],
        },
      }),
    );
    if (err) throw Bob.util.error('api', 'Claude API error', err);
    const content: any[] = (res?.data as any)?.content || [];
    const textBlock = content.find((b) => b.type === 'text');
    return textBlock?.text || '';
  }

  if (provider === 'openai') {
    const base = (baseURL || 'https://api.openai.com').replace(/\/$/, '');
    const [err, res] = await Bob.util.asyncTo<Bob.HttpResponse>(
      Bob.api.$http.post({
        url: `${base}/v1/responses`,
        timeout,
        header: {
          'Authorization': `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: {
          model: 'gpt-4o-mini',
          tools: [{ type: 'web_search_preview' }],
          max_output_tokens: 64,
          temperature: 0,
          input: prompt,
        },
      }),
    );
    if (err) throw Bob.util.error('api', 'OpenAI API error', err);
    const output: any[] = (res?.data as any)?.output || [];
    const message = output.find((item) => item.type === 'message');
    const textContent = (message?.content || []).find((c: any) => c.type === 'output_text');
    return textContent?.text || '';
  }

  if (provider === 'gemini') {
    const base = (baseURL || 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
    const [err, res] = await Bob.util.asyncTo<Bob.HttpResponse>(
      Bob.api.$http.post({
        url: `${base}/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
        timeout,
        header: { 'content-type': 'application/json' },
        body: {
          contents: [{ parts: [{ text: prompt }] }],
          tools: [{ google_search: {} }],
          generationConfig: { maxOutputTokens: 64, temperature: 0 },
        },
      }),
    );
    if (err) throw Bob.util.error('api', 'Gemini API error', err);
    const parts: any[] = (res?.data as any)?.candidates?.[0]?.content?.parts || [];
    const textPart = parts.find((p) => p.text);
    return textPart?.text || '';
  }

  throw Bob.util.error('api', `Unknown LLM provider: ${provider}`);
}

async function resolveIdentifierForTitle(
  title: string,
  provider: string,
  apiKey: string,
  llmTimeout: number,
  baseURL?: string,
): Promise<Identifier | null> {
  // 1) Try Crossref title search first — fast and free. Most journal papers resolve here.
  const crossrefHit = await searchCrossrefByTitle(title, FAST_TIMEOUT);
  if (crossrefHit) return crossrefHit;

  // 2) Fall back to LLM web search (only when Crossref had no high-confidence match).
  if (!apiKey) {
    throw Bob.util.error('api', 'Please set your API key in the plugin settings to search by title.');
  }
  const llmResponse = await callLLM(buildPrompt(title), provider, apiKey, llmTimeout, baseURL);
  return extractIdentifier(llmResponse);
}

async function _translate(text: string, options: QueryOption = {}): Promise<Bob.TranslateResult> {
  const {
    cache = 'disable',
    timeout = LLM_TIMEOUT_DEFAULT,
    llmProvider = 'claude',
    apiKey = '',
    baseURL = '',
  } = options;

  const inputText = text.trim();
  if (!inputText) throw Bob.util.error('api', 'Input is empty');

  const cacheEnabled = cache === 'enable';

  // Top-level result cache (raw input → final TranslateResult).
  const resultKey = CryptoJS.MD5(inputText).toString();
  if (cacheEnabled) {
    const cached = resultCache.get(resultKey);
    if (cached) return cached;
  }

  const result: Bob.TranslateResult = { from: 'auto', to: 'auto', toParagraphs: [] };

  // Resolve to an identifier:
  //   1. Try parsing DOI / arXiv ID directly out of the selection (no network).
  //   2. Otherwise treat as a title and use Crossref → LLM fallback.
  let identifier = extractIdentifier(inputText);

  if (!identifier) {
    // Title-stage cache (title → identifier).
    const titleKey = CryptoJS.MD5(normalizeTitle(inputText)).toString();
    if (cacheEnabled) {
      const cachedId = titleIdCache.get(titleKey) as Identifier | undefined;
      if (cachedId) identifier = cachedId;
    }

    if (!identifier) {
      identifier = await resolveIdentifierForTitle(
        inputText,
        llmProvider,
        apiKey,
        timeout,
        baseURL || undefined,
      );
      if (!identifier) {
        throw Bob.util.error('notFound' as any, 'Could not find a matching paper. The title may be invalid or not indexed.');
      }
      if (cacheEnabled) titleIdCache.set(titleKey, identifier);
    }
  }

  // BibTeX-stage cache (identifier → bibtex). Cheap to populate, big win on retries.
  const idKey = CryptoJS.MD5(`${identifier.type}:${identifier.value}`).toString();
  let bibtex: string | undefined;
  if (cacheEnabled) {
    bibtex = bibtexCache.get(idKey) as string | undefined;
  }
  if (!bibtex) {
    bibtex = await fetchBibTeX(identifier, FAST_TIMEOUT);
    if (cacheEnabled) bibtexCache.set(idKey, bibtex);
  }

  result.toParagraphs = [bibtex];

  if (cacheEnabled) {
    resultCache.set(resultKey, result);
  }
  return result;
}

export { _translate };
