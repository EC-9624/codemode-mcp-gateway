import { createBm25 } from "./bm25.ts";

type SearchDocument = { readonly name: string; readonly description: string };

/** Index only searchable text while returning the caller's complete metadata unchanged. */
export function createToolSearch<T extends SearchDocument>(
  descriptions: Iterable<T>,
): (query: string) => T[] {
  const score = createBm25(
    [...descriptions].map((tool) => {
      const text = `${tool.name} ${tool.description}`;

      return {
        value: { tool, name: tool.name.toLowerCase(), text: text.toLowerCase() },
        tokens: tokenize(text),
      };
    }),
  );

  return (query) => {
    const normalized = query.toLowerCase().trim();
    if (normalized === "") return [];

    const fragments = [...new Set(normalized.split(/\s+/u))];

    return score(tokenize(normalized))
      .map((match) => ({
        tool: match.value.tool,
        exactName: Number(match.value.name === normalized),
        nameScore: fragments.filter((term) => match.value.name.includes(term)).length,
        // Keep partial names, description substrings, and punctuation queries searchable.
        coverage: fragments.filter((term) => match.value.text.includes(term)).length,
        score: match.score,
      }))
      .filter((match) => match.score > 0 || match.coverage > 0)
      .sort(
        (a, b) =>
          b.exactName - a.exactName ||
          b.nameScore - a.nameScore ||
          b.score - a.score ||
          b.coverage - a.coverage,
      )
      .map((match) => match.tool);
  };
}

function tokenize(text: string): string[] {
  const tokens =
    text
      .normalize("NFKC")
      .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
      .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2")
      .toLowerCase()
      .match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}]*/gu) ?? [];

  // Keep exact plural evidence as well as the alias; replacing tokens loses specificity.
  return tokens.flatMap((token) => {
    const alias = pluralAlias(token);

    return alias === undefined ? [token] : [token, alias];
  });
}

const pluralExceptions = new Set([
  "alias",
  "atlas",
  "bias",
  "canvas",
  "chaos",
  "cosmos",
  "diabetes",
  "herpes",
  "lens",
  "measles",
  "news",
  "series",
  "species",
]);

/** Limited English plural aliases, not a general stemmer or identifier normalizer. */
function pluralAlias(token: string): string | undefined {
  if (
    token.length < 4 ||
    !/^[a-z]+$/u.test(token) ||
    !token.endsWith("s") ||
    /(?:ss|us|is|ics)$/u.test(token) ||
    pluralExceptions.has(token)
  ) {
    return undefined;
  }

  if (token.length > 4 && /[^aeiou]ies$/u.test(token)) return token.slice(0, -3) + "y";

  if (/(?:ches|shes|xes|zzes|sses)$/u.test(token)) return token.slice(0, -2);

  return token.slice(0, -1);
}
