/**
 * Query-shape heuristics for @agents-js/tools.
 *
 * Two responsibilities, both transparent string matching (no ML, no deps):
 *
 * 1. Pick which memory primitives fetchContext should run.
 * 2. Score tool-vs-query relevance for findTools.
 *
 * If heuristics ever need to grow beyond keyword matching, move them behind
 * a pluggable scorer interface — don't add ML. The point of Shape 2 is
 * that agents can predict the router's behavior from reading the source.
 */

import type { FetchContextHint, ToolDefinition } from "./types.ts";

/** Memory-biased query signals. */
const MEMORY_SIGNALS = [
  "memory",
  "memories",
  "rule",
  "rules",
  "prior",
  "previous",
  "remember",
  "remembered",
  "recall",
  "agent",
  "session",
  "sessions",
  "jens",
  "decision",
  "decided",
];

/** Docs-biased query signals. */
const DOCS_SIGNALS = [
  "how",
  "doc",
  "docs",
  "document",
  "documentation",
  "spec",
  "specification",
  "readme",
  "guide",
  "plan",
  "hub",
  "vault",
  "adr",
  "architecture",
];

/**
 * Pick a routing hint based on query-shape heuristics. Explicit `hint`
 * passed by the caller always wins.
 */
export function routeFetchContext(query: string, hint?: FetchContextHint): FetchContextHint {
  if (hint) {
    return hint;
  }
  const tokens = tokenize(query);
  const memoryScore = countMatches(tokens, MEMORY_SIGNALS);
  const docsScore = countMatches(tokens, DOCS_SIGNALS);

  if (memoryScore > docsScore) {
    return "prefer-memories";
  }
  if (docsScore > memoryScore) {
    return "prefer-docs";
  }
  return "both";
}

/**
 * Score a tool against a query. Higher score = better match. 0 means no
 * match and the tool should be filtered out by the registry.
 *
 * Scoring: +2 per keyword hit, +1 per description token hit, +3 if the
 * tool name itself appears as a whole token in the query.
 */
export function scoreTool(tool: ToolDefinition, query: string): number {
  const qTokens = new Set(tokenize(query));
  if (qTokens.size === 0) {
    return 0;
  }

  let score = 0;
  if (qTokens.has(tool.name.toLowerCase())) {
    score += 3;
  }
  for (const kw of tool.keywords ?? []) {
    if (qTokens.has(kw.toLowerCase())) {
      score += 2;
    }
  }
  const descTokens = tokenize(tool.description);
  for (const dt of descTokens) {
    if (qTokens.has(dt)) {
      score += 1;
    }
  }
  return score;
}

/**
 * Lightweight keyword-score for snippet ranking. Counts how many query
 * tokens appear in `text`. Case-insensitive; no stemming.
 */
export function scoreSnippet(text: string, query: string): number {
  const qTokens = new Set(tokenize(query));
  if (qTokens.size === 0) {
    return 0;
  }
  const textTokens = tokenize(text);
  let score = 0;
  for (const t of textTokens) {
    if (qTokens.has(t)) {
      score += 1;
    }
  }
  return score;
}

/**
 * Splits a string on runs of any character that is not lowercase
 * alphanumeric. Used by the tokenizer below.
 *
 * Using a regex because a chained `.split(" ").split("-").split(...)` on
 * every punctuation character we want to treat as a separator would be
 * substantially more verbose and harder to read than a single character
 * class. The `+` collapses runs so empty tokens never appear.
 */
const NON_ALPHANUMERIC_RUN = /[^a-z0-9]+/;

/** Split on whitespace and non-word chars; lowercase; drop short tokens. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(NON_ALPHANUMERIC_RUN)
    .filter((t) => t.length >= 2);
}

function countMatches(tokens: string[], signals: string[]): number {
  const set = new Set(tokens);
  let n = 0;
  for (const s of signals) {
    if (set.has(s)) {
      n += 1;
    }
  }
  return n;
}
