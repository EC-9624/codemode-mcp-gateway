import { type SearchJudgment } from "./search-corpus.ts";

/** Supplementary synthetic cases, separate from the original tuning corpus and its IDF. */
export const searchValidationCorpus = [
  { name: "policy.inspect", description: "Review an access policy and its owner." },
  { name: "source.inspect", description: "Inspect a repository and its default branch." },
  { name: "chat.read", description: "Read a message from a conversation." },
  { name: "storage.open", description: "Open a box in storage." },
  { name: "taxonomy.inspect", description: "Inspect a category and its parent." },
  { name: "release.announce", description: "Announce a new release." },
  {
    name: "codes.lookup",
    description: "Look up statu analysi acces sery specy physic s3key codes.",
  },
  { name: "reports.news", description: "Read the news bulletin." },
] as const;

export const searchValidationJudgments: readonly SearchJudgment[] = [
  { name: "policy plural", query: "policies", relevance: { "policy.inspect": 2 } },
  { name: "repository plural", query: "repositories", relevance: { "source.inspect": 2 } },
  { name: "message plural", query: "messages", relevance: { "chat.read": 2 } },
  { name: "box plural", query: "boxes", relevance: { "storage.open": 2 } },
  { name: "category plural", query: "categories", relevance: { "taxonomy.inspect": 2 } },
  { name: "news is not new", query: "news", relevance: { "reports.news": 2 } },
  { name: "status is not statu", query: "status", relevance: {} },
  { name: "analysis is not analysi", query: "analysis", relevance: {} },
  { name: "access is not acces", query: "access", relevance: { "policy.inspect": 2 } },
  { name: "series is not sery", query: "series", relevance: {} },
  { name: "species is not specy", query: "species", relevance: {} },
  { name: "physics is not physic", query: "physics", relevance: {} },
  { name: "identifier suffix", query: "s3keys", relevance: {} },
];
