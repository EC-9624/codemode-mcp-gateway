import { ok, strictEqual } from "node:assert";
import { ToolCatalog } from "@codemode-mcp-gateway/codemode";
import { searchCorpus, searchJudgments, type SearchJudgment } from "./fixtures/search-corpus.ts";
import { searchValidationCorpus, searchValidationJudgments } from "./fixtures/search-validation.ts";

strictEqual(process.argv.length, 2, "Usage: bun run eval:search");

// Hand-calculated checks keep metric mistakes from looking like search improvements.
const perfect = measure(["direct", "related"], { direct: 2, related: 1 });
strictEqual(perfect.mrrAt5, 1);
strictEqual(perfect.ndcgAt5, 1);
strictEqual(perfect.recallAt5, 1);
const displaced = measure(["irrelevant", "direct"], { direct: 2, related: 1 });
strictEqual(displaced.mrrAt5, 0.5);
strictEqual(displaced.recallAt5, 0.5);
ok(Math.abs(displaced.ndcgAt5 - 3 / Math.log2(3) / (3 + 1 / Math.log2(3))) < 1e-12);
const beyondCutoff = measure(["one", "two", "three", "four", "five", "direct"], { direct: 2 });
strictEqual(beyondCutoff.mrrAt5, 0);
strictEqual(beyondCutoff.ndcgAt5, 0);
strictEqual(beyondCutoff.recallAt5, 0);

const original = evaluate(searchCorpus, searchJudgments);
const validation = evaluate(searchValidationCorpus, searchValidationJudgments);
const { results, baseline, current } = original;
const answerable = results.filter((result) => result.answerable);
const existingMatches = answerable.filter((result) => result.baseline.top5.length > 0);
ok(existingMatches.length > 0, "Include queries the baseline already matched.");
const existingBaseline = summarize(existingMatches.map((result) => result.baseline));
const existingCurrent = summarize(existingMatches.map((result) => result.current));

console.log(
  JSON.stringify(
    {
      corpus: "synthetic-v1",
      metricSanityChecks: "passed",
      existingMatches: {
        queryCount: existingMatches.length,
        baseline: existingBaseline,
        current: existingCurrent,
      },
      ...original,
      validation,
    },
    null,
    2,
  ),
);

ok(current.ndcgAt5 > baseline.ndcgAt5 + 0.02, "NDCG@5 must improve by more than 0.02.");
ok(
  existingCurrent.ndcgAt5 > existingBaseline.ndcgAt5,
  "Improve queries the baseline already matched.",
);
ok(current.mrrAt5 >= baseline.mrrAt5, "MRR@5 must not regress.");
ok(current.recallAt5 >= baseline.recallAt5, "Recall@5 must not regress.");
for (const dataset of [original, validation]) {
  for (const result of dataset.results) {
    if (!result.answerable) {
      strictEqual(result.current.top5.length, 0, `Unexpected matches for ${result.name}.`);
      continue;
    }

    ok(
      result.current.ndcgAt5 + 1e-12 >= result.baseline.ndcgAt5,
      `NDCG@5 regressed for ${result.name}.`,
    );
    ok(
      result.current.recallAt5 + 1e-12 >= result.baseline.recallAt5,
      `Recall@5 regressed for ${result.name}.`,
    );
  }
}

type SearchTool = { readonly name: string; readonly description: string };

function evaluate(corpus: readonly SearchTool[], judgments: readonly SearchJudgment[]) {
  const names = new Set(corpus.map((tool) => tool.name));
  strictEqual(names.size, corpus.length, "Corpus names must be unique.");
  strictEqual(
    new Set(judgments.map((judgment) => judgment.name)).size,
    judgments.length,
    "Judgment names must be unique.",
  );
  for (const judgment of judgments) {
    for (const name of Object.keys(judgment.relevance))
      ok(names.has(name), `Unknown relevance label ${name}.`);
  }

  const catalog = ToolCatalog.create(
    Object.fromEntries(
      corpus.map((tool) => [
        tool.name,
        {
          description: tool.description,
          execute: () => {
            throw new Error("Search evaluation must not invoke tools.");
          },
        },
      ]),
    ),
  );

  const results = judgments.map((judgment) => {
    const baseline = legacySearch(corpus, judgment.query);
    const current = catalog.search(judgment.query).map((tool) => tool.name);

    return {
      name: judgment.name,
      family: judgment.family ?? judgment.name,
      query: judgment.query,
      answerable: Object.keys(judgment.relevance).length > 0,
      baseline: { top5: baseline.slice(0, 5), ...measure(baseline, judgment.relevance) },
      current: { top5: current.slice(0, 5), ...measure(current, judgment.relevance) },
    };
  });

  const answerable = results.filter((result) => result.answerable);
  const negatives = results.filter((result) => !result.answerable);
  ok(answerable.length > 0 && negatives.length > 0, "Evaluate positive and negative queries.");

  const families = [...new Set(answerable.map((result) => result.family))].map((name) => {
    const members = answerable.filter((result) => result.family === name);

    return {
      name,
      queryCount: members.length,
      baseline: summarize(members.map((result) => result.baseline)),
      current: summarize(members.map((result) => result.current)),
    };
  });

  return {
    toolCount: corpus.length,
    queryCount: results.length,
    baseline: summarize(answerable.map((result) => result.baseline)),
    current: summarize(answerable.map((result) => result.current)),
    families: {
      count: families.length,
      baseline: summarize(families.map((family) => family.baseline)),
      current: summarize(families.map((family) => family.current)),
      results: families,
    },
    noAnswer: {
      total: negatives.length,
      baselineCorrect: negatives.filter((result) => result.baseline.top5.length === 0).length,
      currentCorrect: negatives.filter((result) => result.current.top5.length === 0).length,
    },
    regressions: answerable
      .filter((result) => result.current.ndcgAt5 + 1e-12 < result.baseline.ndcgAt5)
      .map((result) => result.name),
    results,
  };
}

/** Frozen pre-BM25 ranking, intentionally kept independent of the new index/tokenizer. */
function legacySearch(corpus: readonly SearchTool[], query: string): string[] {
  const terms = [...new Set(query.toLowerCase().trim().split(/\s+/u).filter(Boolean))];

  return corpus
    .map((tool) => {
      const name = tool.name.toLowerCase();
      const text = `${name} ${tool.description.toLowerCase()}`;

      return {
        name: tool.name,
        nameScore: terms.filter((term) => name.includes(term)).length,
        score: terms.filter((term) => text.includes(term)).length,
      };
    })
    .filter((match) => match.score > 0)
    .sort((a, b) => b.nameScore - a.nameScore || b.score - a.score)
    .map((match) => match.name);
}

function measure(ranked: readonly string[], relevance: SearchJudgment["relevance"]) {
  const grades = ranked.slice(0, 5).map((name) => relevance[name] ?? 0);
  const ideal = Object.values(relevance).sort((a, b) => b - a);
  const first = grades.findIndex((grade) => grade > 0);
  const idealGain = discountedGain(ideal.slice(0, 5));

  return {
    mrrAt5: first === -1 ? 0 : 1 / (first + 1),
    ndcgAt5: idealGain === 0 ? 0 : discountedGain(grades) / idealGain,
    recallAt5: ideal.length === 0 ? 0 : grades.filter((grade) => grade > 0).length / ideal.length,
  };
}

function discountedGain(grades: readonly number[]): number {
  return grades.reduce((sum, grade, index) => sum + (2 ** grade - 1) / Math.log2(index + 2), 0);
}

function summarize(metrics: readonly ReturnType<typeof measure>[]) {
  return {
    mrrAt5: metrics.reduce((sum, metric) => sum + metric.mrrAt5, 0) / metrics.length,
    ndcgAt5: metrics.reduce((sum, metric) => sum + metric.ndcgAt5, 0) / metrics.length,
    recallAt5: metrics.reduce((sum, metric) => sum + metric.recallAt5, 0) / metrics.length,
  };
}
