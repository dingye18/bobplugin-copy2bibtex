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

var resultCache = new Bob.CacheResult('translate-result');

function isDOI(text: string): boolean {
  return /^10\.\d{4,9}\/\S+/.test(text.trim());
}

// Matches bare arXiv IDs: 2301.07041 or hep-th/9711200 (old format)
function isArXivID(text: string): boolean {
  return /^\d{4}\.\d{4,5}(v\d+)?$/.test(text.trim())
    || /^[a-z-]+(\.[A-Z]{2})?\/\d{7}(v\d+)?$/.test(text.trim());
}

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

  // Bare arXiv ID on its own line or surrounded by whitespace
  const bareMatch = text.match(/(?:^|\s)(\d{4}\.\d{4,5}(?:v\d+)?)(?:\s|$)/);
  if (bareMatch) {
    return { type: 'arxiv', value: bareMatch[1] };
  }

  return null;
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

async function fetchBibTeX(identifier: Identifier, timeout: number): Promise<string> {
  if (identifier.type === 'arxiv') {
    return fetchBibTeXFromArXiv(identifier.value, timeout);
  }
  // For DOIs: try Crossref; if it's an arXiv DOI (10.48550/arXiv.*) and Crossref fails, fall back to arXiv
  try {
    return await fetchBibTeXFromCrossref(identifier.value, timeout);
  } catch (e) {
    const arxivDOIMatch = identifier.value.match(/10\.48550\/arXiv\.(\d{4}\.\d{4,5}(?:v\d+)?)/i);
    if (arxivDOIMatch) {
      return fetchBibTeXFromArXiv(arxivDOIMatch[1], timeout);
    }
    throw e;
  }
}

function buildPrompt(title: string): string {
  return `Search the web to find the identifier for this scientific paper:
"${title}"

The paper may be published in a journal, or it may be a preprint (arXiv, ChemRxiv, bioRxiv, etc.).
- If it has a DOI, reply with ONLY the DOI (e.g. "10.1234/example").
- If it is an arXiv preprint without a DOI, reply with ONLY the arXiv ID (e.g. "2301.07041" or "arXiv:2301.07041").
- If you cannot find or confirm the paper exists, reply with exactly "NOT_FOUND".
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
          max_tokens: 1024,
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
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

async function _translate(text: string, options: QueryOption = {}): Promise<Bob.TranslateResult> {
  const {
    cache = 'disable',
    timeout = 15000,
    llmProvider = 'claude',
    apiKey = '',
    baseURL = '',
  } = options;

  const cacheKey = CryptoJS.MD5(text);
  if (cache === 'enable') {
    const cached = resultCache.get(cacheKey);
    if (cached) return cached;
  } else {
    resultCache.clear();
  }

  const result: Bob.TranslateResult = { from: 'auto', to: 'auto', toParagraphs: [] };

  const inputText = text.trim();
  if (!inputText) throw Bob.util.error('api', 'Input is empty');

  let bibtex: string;

  if (isDOI(inputText)) {
    bibtex = await fetchBibTeX({ type: 'doi', value: inputText }, timeout);
  } else if (isArXivID(inputText)) {
    bibtex = await fetchBibTeX({ type: 'arxiv', value: inputText }, timeout);
  } else {
    if (!apiKey) {
      throw Bob.util.error('api', 'Please set your API key in the plugin settings to search by title.');
    }

    const prompt = buildPrompt(inputText);
    const llmResponse = await callLLM(prompt, llmProvider, apiKey, timeout, baseURL || undefined);
    const identifier = extractIdentifier(llmResponse);

    if (!identifier) {
      throw Bob.util.error('notFound' as any, 'Could not find a matching paper. The title may be invalid or not indexed.');
    }

    bibtex = await fetchBibTeX(identifier, timeout);
  }

  result.toParagraphs = [bibtex];

  if (cache === 'enable') {
    resultCache.set(cacheKey, result);
  }
  return result;
}

export { _translate };
