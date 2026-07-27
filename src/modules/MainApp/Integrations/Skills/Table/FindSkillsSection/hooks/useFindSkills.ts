import { useCallback, useMemo, useState } from "react";

import type { HubSkillResult } from "@src/types/extensions";

import {
  normalizeSkillSearchQuery,
  previewRemoteSkill,
  searchSkillsHub,
} from "../service";

interface UseFindSkillsOptions {
  onPreview?: (slug: string) => void;
}

export function useFindSkills({ onPreview }: UseFindSkillsOptions) {
  const [query, setQueryState] = useState("");
  const [results, setResults] = useState<HubSkillResult[]>([]);
  const [hasSearched, setHasSearched] = useState(false);
  const [searching, setSearching] = useState(false);
  const [previewingSlug, setPreviewingSlug] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const normalizedQuery = useMemo(
    () => normalizeSkillSearchQuery(query),
    [query]
  );
  const canSearch = normalizedQuery !== null && !searching;

  const setQuery = useCallback((value: string) => {
    setQueryState(value);
    setError(null);
  }, []);

  const clearSearch = useCallback(() => {
    setQueryState("");
    setResults([]);
    setHasSearched(false);
    setError(null);
  }, []);

  const search = useCallback(async () => {
    if (!normalizedQuery || searching) return;
    setSearching(true);
    setError(null);
    setHasSearched(true);
    try {
      setResults(await searchSkillsHub(normalizedQuery));
    } catch (cause) {
      setResults([]);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSearching(false);
    }
  }, [normalizedQuery, searching]);

  const preview = useCallback(
    async (result: HubSkillResult) => {
      if (previewingSlug !== null) return;
      setPreviewingSlug(result.slug);
      setError(null);
      try {
        await previewRemoteSkill(result);
        onPreview?.(result.slug);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setPreviewingSlug(null);
      }
    },
    [onPreview, previewingSlug]
  );

  return {
    query,
    results,
    hasSearched,
    searching,
    previewingSlug,
    error,
    canSearch,
    setQuery,
    clearSearch,
    search,
    preview,
  };
}
