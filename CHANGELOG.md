# Changelog

## [0.1.0] - 2026-03-18

### Added
- Convert paper titles to BibTeX using LLM web search (Claude, OpenAI, Gemini)
- Convert DOIs to BibTeX directly via Crossref (no API key required)
- Convert bare arXiv IDs to BibTeX via arXiv
- Support for preprints: arXiv, ChemRxiv, bioRxiv, and others with Crossref-registered DOIs
- Native web search grounding per provider: Google Search (Gemini), web_search tool (Claude), web_search_preview (OpenAI)
- Custom base URL setting for API proxy/self-hosted deployments
- Result caching option
- `notFound` error type for missing papers and unresolvable DOIs
- Plugin icon (document + `@` symbol on indigo-to-teal gradient)
