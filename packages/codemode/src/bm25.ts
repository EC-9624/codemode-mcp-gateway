const k1 = 1.2;
const b = 0.75;

/** Snapshot corpus statistics; score every value without imposing tool-specific ranking policy. */
export function createBm25<T>(corpus: Iterable<{ value: T; tokens: readonly string[] }>) {
  const documents = [...corpus].map((document) => {
    const frequencies = new Map<string, number>();
    for (const token of document.tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);

    return { value: document.value, frequencies, length: document.tokens.length };
  });

  const documentFrequencies = new Map<string, number>();
  for (const document of documents) {
    for (const term of document.frequencies.keys())
      documentFrequencies.set(term, (documentFrequencies.get(term) ?? 0) + 1);
  }

  const idf = new Map(
    [...documentFrequencies].map(([term, count]) => [
      term,
      Math.log1p((documents.length - count + 0.5) / (count + 0.5)),
    ]),
  );

  const averageLength =
    documents.reduce((sum, document) => sum + document.length, 0) / documents.length || 1;

  return (tokens: readonly string[]) => {
    const terms = new Set(tokens);

    return documents.map((document) => ({
      value: document.value,
      score: bm25(
        terms,
        document.frequencies,
        idf,
        k1 * (1 - b + (b * document.length) / averageLength),
      ),
    }));
  };
}

function bm25(
  terms: ReadonlySet<string>,
  frequencies: ReadonlyMap<string, number>,
  idf: ReadonlyMap<string, number>,
  normalization: number,
): number {
  let score = 0;
  for (const term of terms) {
    const frequency = frequencies.get(term) ?? 0;
    if (frequency === 0) continue;

    score += ((idf.get(term) ?? 0) * frequency * (k1 + 1)) / (frequency + normalization);
  }

  return score;
}
