import { useCallback, useEffect, useRef, useState } from "react";

import { type ScopePropertyValue, projectApi } from "@src/api/http/project";
import { createLogger } from "@src/hooks/logger";
import { useProjectDataChanged } from "@src/hooks/project";

import { usePropertyDefinitions } from "./usePropertyDefinitions";

const logger = createLogger("useWorkItemPropertyView");
const EMPTY_VALUES: ScopePropertyValue[] = [];

interface PropertyViewSnapshot {
  scopeKey: string;
  values: ScopePropertyValue[];
}

interface PropertyViewRefresh {
  scopeKey: string;
  promise: Promise<void>;
  refreshAgain: boolean;
}

interface UseWorkItemPropertyViewParams {
  orgId: string;
  projectSlug: string | null;
  isActive: boolean;
}

/**
 * Scope-wide property data for filtering/grouping/table columns. Refreshes are
 * event-driven and generation-guarded; hidden project tabs retain the last
 * snapshot without issuing background reads.
 */
export function useWorkItemPropertyView({
  orgId,
  projectSlug,
  isActive,
}: UseWorkItemPropertyViewParams) {
  const scopeKey = JSON.stringify([orgId, projectSlug]);
  const propertyDefinitions = usePropertyDefinitions(orgId, isActive);
  const [snapshot, setSnapshot] = useState<PropertyViewSnapshot | null>(null);
  const generationRef = useRef(0);
  const inFlightRef = useRef<PropertyViewRefresh | null>(null);
  const mountedRef = useRef(true);
  const activeRef = useRef(isActive);
  const scopeKeyRef = useRef(scopeKey);

  const refresh = useCallback(async () => {
    if (!isActive) return;
    const current = inFlightRef.current;
    if (current?.scopeKey === scopeKey) {
      // Coalesce bursts into the active read plus at most one trailing read.
      // The trailing read preserves an invalidation that arrived mid-flight.
      current.refreshAgain = true;
      return current.promise;
    }

    const operation: PropertyViewRefresh = {
      scopeKey,
      promise: Promise.resolve(),
      refreshAgain: false,
    };
    operation.promise = (async () => {
      do {
        operation.refreshAgain = false;
        const generation = ++generationRef.current;
        try {
          const values = await projectApi.listScopePropertyValues(
            orgId,
            projectSlug
          );
          if (
            mountedRef.current &&
            activeRef.current &&
            scopeKeyRef.current === scopeKey &&
            generationRef.current === generation
          ) {
            setSnapshot({ scopeKey, values });
          }
        } catch (error) {
          if (
            mountedRef.current &&
            scopeKeyRef.current === scopeKey &&
            generationRef.current === generation
          ) {
            logger.warn("Failed to load property view data", error);
          }
        }
      } while (
        operation.refreshAgain &&
        mountedRef.current &&
        activeRef.current &&
        scopeKeyRef.current === scopeKey
      );
    })().finally(() => {
      if (inFlightRef.current === operation) inFlightRef.current = null;
    });
    inFlightRef.current = operation;
    return operation.promise;
  }, [isActive, orgId, projectSlug, scopeKey]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
    };
  }, []);

  useEffect(() => {
    activeRef.current = isActive;
    scopeKeyRef.current = scopeKey;
  }, [isActive, scopeKey]);

  useEffect(() => {
    if (!isActive) {
      generationRef.current += 1;
      return;
    }
    void refresh();
    return () => {
      generationRef.current += 1;
    };
  }, [isActive, refresh]);

  useProjectDataChanged(
    useCallback(
      (change) => {
        if (
          isActive &&
          (!change?.projectSlug || change.projectSlug === projectSlug)
        ) {
          void refresh();
        }
      },
      [isActive, projectSlug, refresh]
    )
  );

  const currentSnapshot = snapshot?.scopeKey === scopeKey ? snapshot : null;
  return {
    definitions: propertyDefinitions.data,
    values: currentSnapshot?.values ?? EMPTY_VALUES,
    ready: currentSnapshot !== null && !propertyDefinitions.loading,
    refresh,
  };
}
