# Tool search and offline evaluation

## Run

```sh
bun run eval:search
bun run bench:search
```

This deterministic local evaluation imports the public `ToolCatalog` API. It
does not invoke tools, connect to providers, use model judges, or require API keys.
It emits JSON with aggregate metrics, both top-five rankings for every query,
and the names of queries whose NDCG regressed. Nonzero exit means a quality gate
or metric sanity check failed.

- Runner: `scripts/search-evaluation.ts`.
- Fixed corpus and explicit relevance judgments: `scripts/fixtures/search-corpus.ts`.
- Supplementary plural/negative validation: `scripts/fixtures/search-validation.ts`.
- Scale benchmark: `scripts/search-benchmark.ts`.
- Contract tests: `packages/codemode/tests/catalog.test.ts`.
- Implementation: `packages/codemode/src/bm25.ts` owns scoring and corpus statistics;
  `search.ts` owns tool-ranking policy and tokenization; `discovery.ts` owns paging
  and previews. These are internal modules, not additional public exports.

The evaluation is separate from `bun run check`; run both when changing search.
To retain a comparison, redirect stdout to a JSON file outside the checkout.

## Ranking

Each catalog builds an immutable search index over its snapshotted names and full
descriptions, never schemas or executable/private fields. Search is metadata-only.
Names and descriptions contribute tokens to the same document, with camel-case
and acronym boundaries split before lowercasing, Unicode NFKC normalization, and
punctuation separating words. Query text is lowercased before tokenization to keep
query casing irrelevant. Duplicate query tokens do not increase their weight.

Tokenization adds limited English plural aliases **alongside the original tokens**:
regular `-s`, consonant `-ies` to `-y`, and selected `-es` forms (`boxes`, `classes`,
`watches`). This lets `invoices` match `invoice` and `deliveries` match `delivery`
while retaining additional exact-plural evidence. Aliases contribute to document
length and frequency like other indexed tokens; duplicate query aliases count once.
Only ASCII letter-only tokens qualify; words shorter than four characters,
ambiguous `-ss`/`-us`/`-is`/`-ics` endings, and listed exceptions such as
`news`, `series`, and `species` are excluded. The original names and exact-name preference do
not change. This is a bounded heuristic, not a dictionary, language detector, or
general stemmer: irregular plurals and ambiguous words/identifiers remain limitations.

For a token `t`, a document `d`, and `N` documents:

```text
idf(t) = ln(1 + (N - df(t) + 0.5) / (df(t) + 0.5))
BM25(d, q) = sum over distinct query tokens t:
  idf(t) * tf(t, d) * (k1 + 1)
  / (tf(t, d) + k1 * (1 - b + b * length(d) / averageLength))

k1 = 1.2
b = 0.75
```

Frequency saturation limits the value of repetition; length normalization reduces
the advantage of verbose descriptions containing incidental keywords. Smoothed
positive IDF emphasizes rarer terms without giving common terms negative weights.
Corpus statistics are computed once per catalog revision, not per query. Search
scans the indexed documents; it is not an inverted-index or semantic search engine.

This is **name-aware BM25**, not a pure BM25 ordering. Sort by:

1. Case-insensitive exact full name.
2. Distinct whitespace query fragments occurring in the name, preserving the
   existing preference for action names over incidental description mentions.
3. BM25 score.
4. Distinct raw substring matches in the combined name and description.
5. Catalog insertion order for remaining ties.

Raw substring matches remain eligible even without an exact token match, retaining
partial-name, partial-description, and punctuation searches. Empty/tokenless
catalogs are supported. `search()` returns all matching full metadata; discovery
still previews/paginates those results and exact-name `describe()` is unchanged.
The gateway filters the combined catalog's ranked results by server before paging;
it does not recalculate IDF separately for the selected server.

No general stemming, synonyms, language-specific segmentation, embeddings, fuzzy
spelling, or relevance feedback are provided. `invoice` and `invoices` still retain
distinct exact-token statistics in addition to their shared alias. Search rankings
can change when the catalog's contents or descriptions change. Name coverage still
outranks BM25: a customer-profile action can rank above an invoice alternative for
`customer invoices`, even though the profile is judged irrelevant to this task.

## Dataset and metrics

The synthetic-v1 corpus contains **43 tools and 38 queries**: 36 answerable queries
and two no-answer host queries, including a blank query. It covers billing,
workspace documents, webhook operations, development, messaging, calendar,
infrastructure, and identity. Cases include mixed case, identifier separators,
acronyms, Unicode, partial matches, and verbose tools that mention but cannot
perform the requested operation. Tools that only refer to an operation are not
necessarily relevant to performing it.

Judgments are fixed: **2** means directly relevant, **1** a useful alternative,
and unlisted tools are irrelevant. Review judgments before tuning ranking. These
are hand-authored synthetic examples, not held-out provider data or evidence of
real-agent success. Do not treat the results as a universal quality guarantee.

A separate **8-tool, 13-query** synthetic validation corpus covers policy,
repository, message, box, and category plurals, plus false-alias risks such as
`news`/`new`, `analysis`/`analysi`, and identifier suffixes. It has separate IDF
statistics, keeping the original 43-tool comparison unchanged. These additional
cases were authored during this investigation, not collected as an untouched
held-out dataset. Genuine provider/traffic validation is still needed.

- **MRR@5:** reciprocal rank of the first relevant result; zero if none occurs in
  the first five. Both relevance grades count as a hit.
- **NDCG@5:** discounted gain with `2^grade - 1`, normalized by the ideal ranking.
- **Recall@5:** relevant tools in the first five divided by all labeled relevant
  tools, not by five.
- **No-answer correctness:** evaluated separately; negatives are excluded from
  the averaged relevance metrics.
- **Family-weighted metrics:** average query metrics within each intent family,
  then average families equally. `customer invoices` and its repeated/case variant
  share one family, yielding 35 answerable families rather than 36 independent
  intents. The report retains the ordinary per-query aggregates for comparison.

The runner checks hand-calculated perfect/displaced rankings and the top-five
cutoff before evaluating. It also validates unique corpus names and judgment
references. The baseline freezes the previous case-insensitive substring ranker
independently of the new tokenizer. A separate summary for queries the baseline
already matched prevents newly tokenized matches from hiding ranking tradeoffs.

Gates require overall NDCG@5 to improve by more than 0.02, overall MRR@5 and
Recall@5 not to regress, NDCG@5 on already-matched queries to improve, and all
negative queries to remain empty. **Every answerable query in both datasets must
also preserve baseline NDCG@5 and Recall@5**, preventing an aggregate improvement
from hiding the previously observed individual regressions.

## Recorded result

Local run on Bun 1.4.3, 2026-10-30:

| Metric                    | Previous substring ranker | BM25 before aliases | BM25 with aliases |
| ------------------------- | ------------------------- | ------------------- | ----------------- |
| MRR@5                     | 0.8333                    | 0.9861              | 0.9861            |
| NDCG@5                    | 0.8233                    | 0.9656              | 0.9757            |
| Recall@5                  | 0.8750                    | 0.9676              | 1.0000            |
| No-answer queries correct | 2/2                       | 2/2                 | 2/2               |

The three earlier per-query NDCG regressions are resolved without changing their
judgments: `customer invoices` and its repeated/case variant return the single-invoice
alternative at rank five (previously six); `failed deliveries` returns the audit
alternative second (previously third). Exact plural evidence is retained, avoiding
the recall loss observed when replacing plural tokens outright. Across the original
queries, no NDCG or Recall@5 regression remains against the legacy baseline.

For the 32 already-matched queries, NDCG@5 is now **0.9737** versus **0.9262** for
the legacy ranker, and Recall@5 is **1.0000** versus **0.9844**. Family-weighted
NDCG@5 is **0.9771** versus **0.8204**. Supplementary validation achieves NDCG@5
and Recall@5 of **1.0000**, with all six no-answer cases empty.

## Scale and limits

There is no explicit tool-count cap in `ToolCatalog`. Capacity depends on total
metadata/token volume, query size, and host memory/CPU—not just the tool count.
Index construction visits all tokens and stores per-document frequencies and corpus
statistics. Each synchronous host search scans every document, checks query tokens
and raw substrings, then sorts the matches (`O(M log M)` for `M` matches). It has no
inverted index, search cache, early top-k pruning, or search-specific resource limit.
Long descriptions and queries increase work; concurrent requests can queue behind
this synchronous CPU work. Guest execution limits do not bound catalog construction.

Discovery defaults to five previews of at most 200 UTF-16 code units each, regardless
of catalog size; **it still ranks the full catalog before paging**. Host `search()`
returns all matches. Snapshot rebuilds pay indexing cost again and may temporarily
coexist with older revisions; the benchmark does not measure gateway refresh churn.

`bun run bench:search` exercises the real public catalog/discovery implementation,
not a mocked ranking function. It replicates synthetic tool metadata under unique
namespaces at 100, 1,000, and 10,000 tools, plus a 1,000-tool long-description
scenario. Queries cover exact names, intent, plurals, all-tools-match, and no matches.
Assertions protect exact-name priority, full match counts, no-answer behavior, and
the default five-tool page/total/next offset; callback execution would throw.

Sample on Apple M3 Pro, macOS arm64, Bun 1.4.3 (20 warmups, 100 timed calls per query):

| Tools / descriptions | Build ms | Search median ms range | Search p95 ms range | Approx. retained heap MiB |
| -------------------- | -------- | ---------------------- | ------------------- | ------------------------- |
| 100 / ~112 chars     | 8.27     | 0.014–0.025            | 0.031–0.091         | 0.44                      |
| 1,000 / ~114 chars   | 5.45     | 0.145–0.232            | 0.340–0.525         | 3.71                      |
| 10,000 / ~115 chars  | 43.97    | 2.752–5.773            | 4.183–7.767         | 29.35                     |
| 1,000 / ~2,346 chars | 46.95    | 0.217–0.555            | 0.353–1.180         | 6.54                      |

For 1,000 short-description tools, broad discovery returned five previews in
**0.223 ms median / 0.383 ms p95**, with a **684-byte** result body. These figures
suggest 1,000 tools are inexpensive for this workload, not a production capacity
guarantee. The benchmark is sequential and warm, excludes upstream/QuickJS/MCP/network
costs, and reports single-build timings (the first includes startup/JIT overhead).
The long-description scenario repeats documentation as a length stressor, not
real-world linguistic content. Heap is an approximate post-GC delta after input
metadata already exists; it excludes that input allocation, native/WASM memory,
and peak/RSS. There are no machine-specific latency gates.
