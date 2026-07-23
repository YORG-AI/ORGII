/**
 * useLearningsBrowser
 *
 * Backs the Learnings Browser: paged/filtered list +
 * status/body edits + delete. Purely UI-facing thin wrappers over
 * the `rpc.learning.*` procedures — no cross-module business logic,
 * so the hook lives under `src/hooks/settings/` (single-module use).
 */
import { useAtom } from "jotai";
import { useCallback, useEffect, useMemo, useState } from "react";

import { rpc } from "@src/api/tauri/rpc";
import type {
  LearningCategoryValue,
  LearningRecord,
  LearningSourceValue,
  LearningStatusValue,
  LearningsStatusReport,
  SettableLearningStatusValue,
} from "@src/api/tauri/rpc/schemas/learning";
import { useAsyncResource } from "@src/hooks/async";
import { learningsBrowserInitialFilterAtom } from "@src/store";

export interface LearningsBrowserFilters {
  agentScope?: string;
  status?: LearningStatusValue;
  source?: LearningSourceValue;
  category?: LearningCategoryValue;
  search?: string;
}

export interface UseLearningsBrowserOptions {
  /** When set and no explicit `filters.agentScope` is active, browse these
   *  per-agent scopes and merge the rows client-side. */
  agentScopes?: string[];
}

export interface UseLearningsBrowserReturn {
  /** Full list after server-side filter; order follows `updated_at DESC`. */
  items: LearningRecord[];
  loading: boolean;
  error: string | null;
  filters: LearningsBrowserFilters;
  status: LearningsStatusReport | null;
  setFilters: (next: LearningsBrowserFilters) => void;
  refresh: () => Promise<void>;
  setStatus: (id: string, next: SettableLearningStatusValue) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

interface LearningsBrowserData {
  items: LearningRecord[];
  status: LearningsStatusReport | null;
}

interface LearningsBrowserRequest {
  agentScopes?: string[];
  filters: LearningsBrowserFilters;
}

const EMPTY_LEARNINGS_BROWSER_DATA: LearningsBrowserData = {
  items: [],
  status: null,
};

export function useLearningsBrowser(
  options: UseLearningsBrowserOptions = {}
): UseLearningsBrowserReturn {
  const [initialFilter, setInitialFilter] = useAtom(
    learningsBrowserInitialFilterAtom
  );
  const [filters, setFiltersState] = useState<LearningsBrowserFilters>(() =>
    initialFilter ? { status: initialFilter } : {}
  );

  useEffect(() => {
    if (initialFilter) {
      setInitialFilter(null);
    }
  }, [initialFilter, setInitialFilter]);

  const scopeKey = useMemo(
    () =>
      JSON.stringify({
        agentScopes: options.agentScopes,
        filters,
      } satisfies LearningsBrowserRequest),
    [filters, options.agentScopes]
  );

  const fetchAll = useCallback(async (serializedRequest: string) => {
    const request = JSON.parse(serializedRequest) as LearningsBrowserRequest;
    const current = request.filters;
    const scopes = current.agentScope
      ? [current.agentScope]
      : request.agentScopes;
    if (scopes && scopes.length > 0) {
      const lists = await Promise.all(
        scopes.map((agentScope) =>
          rpc.learning.browseList({
            agentScope,
            status: current.status,
            source: current.source,
            category: current.category,
            search: current.search,
          })
        )
      );
      const byId = new Map<string, LearningRecord>();
      for (const list of lists) {
        for (const row of list) byId.set(row.id, row);
      }
      return {
        items: [...byId.values()].sort((rowA, rowB) =>
          rowB.updated_at.localeCompare(rowA.updated_at)
        ),
        status: null,
      };
    }

    const [items, status] = await Promise.all([
      rpc.learning.browseList({
        agentScope: current.agentScope,
        status: current.status,
        source: current.source,
        category: current.category,
        search: current.search,
      }),
      rpc.learning.getStatus({ agentScope: current.agentScope }),
    ]);
    return { items, status };
  }, []);

  const resource = useAsyncResource({
    fetcher: fetchAll,
    initialData: EMPTY_LEARNINGS_BROWSER_DATA,
    scopeKey,
  });

  const refresh = resource.refresh;

  const setFilters = useCallback((next: LearningsBrowserFilters) => {
    setFiltersState(next);
  }, []);

  const setStatus = useCallback(
    async (id: string, next: SettableLearningStatusValue) => {
      await rpc.learning.setStatus({ learningId: id, next });
      await refresh();
    },
    [refresh]
  );

  const remove = useCallback(
    async (id: string) => {
      await rpc.learning.remove({ learningId: id });
      await refresh();
    },
    [refresh]
  );

  return {
    items: resource.data.items,
    loading: resource.loading,
    error: resource.error,
    filters,
    status: resource.data.status,
    setFilters,
    refresh,
    setStatus,
    remove,
  };
}

export default useLearningsBrowser;
