# bobplugin-copy2bibtex

A [Bob](https://github.com/ripperhe/Bob) plugin that converts literature titles or DOIs into BibTeX entries, ready to paste into your `.bib` file.

## Features

- **Title → BibTeX**: Select a paper title, the plugin uses an LLM (with web search) to find the DOI, then fetches the BibTeX from Crossref.
- **DOI → BibTeX**: Paste a DOI directly and get BibTeX instantly — no API key needed.
- **arXiv ID → BibTeX**: Paste a bare arXiv ID (e.g. `2301.07041`) and get BibTeX from arXiv.
- **Preprint support**: Handles arXiv, ChemRxiv, bioRxiv, and other preprints with DOIs.
- **Multi-LLM**: Choose between Claude (Anthropic), OpenAI (GPT), or Google (Gemini) for the title search.
- **Web search grounding**: Each LLM uses its native web/Google search tool to find and verify the paper, avoiding hallucinations.
- **Custom base URL**: Override the API endpoint for each provider (useful for proxies or self-hosted deployments).
- **Result caching**: Optionally cache results to avoid repeated API calls.

## Installation

1. Install [Bob](https://github.com/ripperhe/Bob/releases) (version ≥ 0.5.0)
2. Download the latest plugin: [Releases](https://github.com/dingye18/bobplugin-copy2bibtex/releases)
3. Double-click the `.bobplugin` file to install

## Configuration

Open Bob → Preferences → Services → Copy2BibTeX:

| Option | Description |
|---|---|
| **LLM 服务商** | LLM provider for title search: Claude, OpenAI, or Gemini |
| **API Key** | API key for the selected provider (not required for DOI/arXiv input) |
| **自定义接口地址** | Override the default API base URL (optional) |
| **缓存** | Enable result caching (default: off) |

## Usage

| Input | Result |
|---|---|
| Paper title | LLM searches the web → finds DOI → returns BibTeX |
| `10.1021/jp102971x` | Fetches BibTeX from Crossref directly |
| `2301.07041` | Fetches BibTeX from arXiv directly |

## Development

```bash
yarn install
yarn build   # outputs release/bobplugin-copy2bibtex-v*.bobplugin
```

## License

MIT
