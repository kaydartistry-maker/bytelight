---
name: arxiv-research
description: Search and read academic papers from arxiv via Semantic Scholar API + ar5iv HTML. No OAuth, no PDF parsing. Use when the user wants to find research papers, read a specific paper, look up citations, or explore academic literature. Trigger on "find papers on", "arxiv", "research on", "look up the paper", "academic search", "semantic scholar", "what does the literature say", "read this paper", or any arxiv/ar5iv URL.
---

# arxiv Research — Paper Search & Reading

Search academic papers via Semantic Scholar (214M papers, no auth needed) and read full paper text via ar5iv (HTML versions of arxiv papers). No OAuth, no PDF parsing, no tokens.

---

## Quick Use

`/arxiv [query]` — Search for papers on a topic
`/arxiv read [arxiv-url]` — Read a specific paper's full text
`/arxiv cite [paper-id]` — Get citations and references for a paper

---

## Tools

All calls use `WebFetch`. No MCP server or API key required.

---

## 1. Search Papers (Semantic Scholar)

**Endpoint:** `https://api.semanticscholar.org/graph/v1/paper/search`

### Basic search
```
WebFetch URL: https://api.semanticscholar.org/graph/v1/paper/search?query=<URL-ENCODED-QUERY>&limit=10&fields=title,authors,year,abstract,citationCount,url,externalIds,openAccessPdf
Prompt: Extract the papers list. For each paper return: title, authors (names), year, abstract (first 2 sentences), citation count, arxiv ID if available, and Semantic Scholar URL.
```

### With filters
Add query params:
- `&year=2024-2026` — date range
- `&fieldsOfStudy=Computer Science` — field filter
- `&openAccessPdf` — only papers with free PDFs
- `&offset=10` — pagination

### Search by arxiv ID
```
WebFetch URL: https://api.semanticscholar.org/graph/v1/paper/arXiv:<ARXIV_ID>?fields=title,authors,year,abstract,citationCount,references,citations,externalIds,tldr
Prompt: Extract full paper details including TLDR, citation count, and key references.
```

For example, for paper `2401.12345`:
```
https://api.semanticscholar.org/graph/v1/paper/arXiv:2401.12345?fields=title,authors,year,abstract,citationCount,tldr,references.title,citations.title
```

---

## 2. Read Full Paper Text (ar5iv)

ar5iv converts arxiv papers to readable HTML. Swap `arxiv.org` for `ar5iv.org` in any URL.

### Convert URL
- `https://arxiv.org/abs/2401.12345` -> `https://ar5iv.org/abs/2401.12345`
- `https://arxiv.org/pdf/2401.12345` -> `https://ar5iv.org/abs/2401.12345`

### Fetch full paper
```
WebFetch URL: https://ar5iv.org/abs/<ARXIV_ID>
Prompt: Extract the full paper content including: title, authors, abstract, all section headings and their content, key equations or formulas described in words, figures/tables described, and conclusion. Preserve the paper's structure.
```

### Fetch specific section
```
WebFetch URL: https://ar5iv.org/abs/<ARXIV_ID>
Prompt: Extract only the [methodology/results/conclusion/related work] section from this paper. Include any relevant tables or figure descriptions.
```

### Coverage
ar5iv has papers up to end of February 2026. For papers after that, fall back to the arxiv abstract page:
```
WebFetch URL: https://arxiv.org/abs/<ARXIV_ID>
Prompt: Extract the abstract, metadata, and any available content from this arxiv page.
```

---

## 3. Citations & References

### Get references (what this paper cites)
```
WebFetch URL: https://api.semanticscholar.org/graph/v1/paper/arXiv:<ARXIV_ID>/references?fields=title,authors,year,citationCount,externalIds&limit=50
Prompt: List all referenced papers with title, authors, year, citation count, and arxiv ID if available. Sort by citation count.
```

### Get citations (what cites this paper)
```
WebFetch URL: https://api.semanticscholar.org/graph/v1/paper/arXiv:<ARXIV_ID>/citations?fields=title,authors,year,citationCount,externalIds&limit=50
Prompt: List all citing papers with title, authors, year, citation count, and arxiv ID if available. Sort by most recent first.
```

---

## 4. Paper Recommendations

### Find similar papers
```
WebFetch URL: https://api.semanticscholar.org/recommendations/v1/papers/forpaper/arXiv:<ARXIV_ID>?fields=title,authors,year,abstract,citationCount,externalIds&limit=10
Prompt: List recommended papers with title, authors, year, brief abstract, and citation count.
```

---

## 5. Author Lookup

### Search by author
```
WebFetch URL: https://api.semanticscholar.org/graph/v1/author/search?query=<AUTHOR_NAME>&fields=name,paperCount,citationCount,hIndex
Prompt: List matching authors with their paper count, citation count, and h-index.
```

### Get author's papers
```
WebFetch URL: https://api.semanticscholar.org/graph/v1/author/<AUTHOR_ID>/papers?fields=title,year,citationCount,externalIds&limit=20
Prompt: List the author's papers sorted by year, with citation counts and arxiv IDs.
```

---

## Workflow: Deep Research on a Topic

1. **Search** — Semantic Scholar query with relevant terms, get top 10
2. **Triage** — Read abstracts, identify the 2-3 most relevant papers
3. **Read** — Fetch full text via ar5iv for those papers
4. **Expand** — Check citations/references for anything missed
5. **Synthesize** — Summarize findings, key methods, open questions

---

## Rate Limits

- **Semantic Scholar**: No API key needed. Shared pool of 1000 req/s across all unauthenticated users. If throttled, wait a few seconds and retry.
- **ar5iv**: Standard web fetch, no known rate limits. Be reasonable.
- **arxiv API** (fallback): `http://export.arxiv.org/api/query?search_query=all:<QUERY>&max_results=10` — Atom XML, 3-second delay between calls requested.

---

## Tips

- Semantic Scholar search is better than arxiv's native API for discovery (semantic matching vs keyword)
- ar5iv HTML is far superior to trying to parse PDFs — full structured text
- Use `tldr` field from Semantic Scholar for quick paper summaries (AI-generated)
- For very recent papers (last few weeks), ar5iv may not have them yet — use the arxiv abstract page instead
- Chain searches: find a key paper, then explore its citations and references to map the landscape
