import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { isVisibleInChat } from "@src/engines/SessionCore/ingestion/visibilityFilters";

const MAX_STRING_LEN = 10_000;
const SNIPPET_CONTEXT = 40;
const MAX_SNIPPET_LEN = 160;

export interface RustSearchResult {
  eventId: string;
  chatIndex: number;
  score: number;
  snippet: string;
}

export interface ChatSearchModes {
  caseSensitive: boolean;
  useRegex: boolean;
  wholeWord: boolean;
}

export const DEFAULT_CHAT_SEARCH_MODES: ChatSearchModes = {
  caseSensitive: false,
  useRegex: false,
  wholeWord: false,
};

export interface MappedSearchResult {
  item: SessionEvent;
  index: number;
  score: number;
  snippet: string;
}

function buildEventIdIndex(
  chatHistory: readonly SessionEvent[]
): Map<string, number> {
  const index = new Map<string, number>();
  for (let idx = 0; idx < chatHistory.length; idx++) {
    const event = chatHistory[idx];
    if (event.id) index.set(event.id, idx);
    if (event.chunk_id && event.chunk_id !== event.id) {
      index.set(event.chunk_id, idx);
    }
  }
  return index;
}

function resolveHistoryIndex(
  rustResult: RustSearchResult,
  eventIndex: ReadonlyMap<string, number>,
  chatHistoryLength: number
): number | undefined {
  const byId = eventIndex.get(rustResult.eventId);
  if (byId !== undefined) return byId;
  if (rustResult.chatIndex >= 0 && rustResult.chatIndex < chatHistoryLength) {
    return rustResult.chatIndex;
  }
  return undefined;
}

export function mapRustResultsToSearchResults(
  rustResults: readonly RustSearchResult[],
  chatHistory: readonly SessionEvent[]
): MappedSearchResult[] {
  const eventIndex = buildEventIdIndex(chatHistory);
  const mapped: MappedSearchResult[] = [];

  for (const rustResult of rustResults) {
    const historyIndex = resolveHistoryIndex(
      rustResult,
      eventIndex,
      chatHistory.length
    );
    if (historyIndex === undefined) continue;
    mapped.push({
      item: chatHistory[historyIndex],
      index: historyIndex,
      score: rustResult.score,
      snippet: rustResult.snippet,
    });
  }

  return mapped;
}

export function wrapNextSearchResultIndex(
  currentIndex: number,
  resultCount: number,
  direction: 1 | -1
): number {
  if (resultCount <= 0) return 0;
  if (direction === 1) {
    return (currentIndex + 1) % resultCount;
  }
  return currentIndex === 0 ? resultCount - 1 : currentIndex - 1;
}

function extractStringsFromValue(
  value: unknown,
  parts: string[],
  maxDepth: number,
  currentDepth = 0
): void {
  if (currentDepth >= maxDepth) return;
  if (typeof value === "string") {
    if (value.length < MAX_STRING_LEN) parts.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      extractStringsFromValue(item, parts, maxDepth, currentDepth + 1);
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const nested of Object.values(value)) {
      extractStringsFromValue(nested, parts, maxDepth, currentDepth + 1);
    }
  }
}

/** Mirrors Rust `build_searchable_text` for local fallback search. */
export function buildChatSearchableText(event: SessionEvent): string {
  const parts: string[] = [];
  if (event.functionName) parts.push(event.functionName);
  if (event.actionType) parts.push(event.actionType);
  extractStringsFromValue(event.args, parts, 3);
  extractStringsFromValue(event.result, parts, 4);
  if (event.displayText) parts.push(event.displayText);
  return parts.join(" ");
}

function createSearchSnippet(
  text: string,
  query: string,
  caseSensitive: boolean
): string {
  const matchIndex = caseSensitive
    ? text.indexOf(query)
    : text.toLowerCase().indexOf(query.toLowerCase());
  if (matchIndex < 0) return "";

  const start = Math.max(0, matchIndex - SNIPPET_CONTEXT);
  const end = Math.min(
    text.length,
    matchIndex + query.length + SNIPPET_CONTEXT
  );

  let snippet = `${start > 0 ? "..." : ""}${text.slice(start, end)}${end < text.length ? "..." : ""}`;
  if (snippet.length > MAX_SNIPPET_LEN) {
    snippet = `${snippet.slice(0, MAX_SNIPPET_LEN)}...`;
  }
  return snippet;
}

function findSearchMatchIndex(
  text: string,
  query: string,
  modes: ChatSearchModes
): number | null {
  const trimmed = query.trim();
  if (!trimmed) return null;

  if (modes.useRegex || modes.wholeWord) {
    const pattern = modes.wholeWord
      ? modes.useRegex
        ? `\\b${trimmed}\\b`
        : `\\b${trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`
      : trimmed;
    const flags = modes.caseSensitive ? "" : "i";
    try {
      const match = new RegExp(pattern, flags).exec(text);
      return match?.index ?? null;
    } catch {
      return null;
    }
  }

  const matchIndex = modes.caseSensitive
    ? text.indexOf(trimmed)
    : text.toLowerCase().indexOf(trimmed.toLowerCase());
  return matchIndex >= 0 ? matchIndex : null;
}

/**
 * Search the already-loaded chat history when Rust EventStore search returns
 * nothing (evicted store, id mapping drift, etc.).
 */
export function searchChatHistoryLocally(
  chatHistory: readonly SessionEvent[],
  query: string,
  modes: ChatSearchModes,
  maxResults: number
): MappedSearchResult[] {
  const trimmedQuery = query.trim();
  if (!trimmedQuery || maxResults <= 0) return [];

  const results: MappedSearchResult[] = [];
  for (let index = 0; index < chatHistory.length; index++) {
    if (results.length >= maxResults) break;
    const event = chatHistory[index];
    if (!isVisibleInChat(event)) continue;

    const searchable = buildChatSearchableText(event);
    const matchIndex = findSearchMatchIndex(searchable, trimmedQuery, modes);
    if (matchIndex === null) continue;

    results.push({
      item: event,
      index,
      score: matchIndex,
      snippet: createSearchSnippet(
        searchable,
        trimmedQuery,
        modes.caseSensitive
      ),
    });
  }

  results.sort((a, b) => a.score - b.score);
  return results;
}
