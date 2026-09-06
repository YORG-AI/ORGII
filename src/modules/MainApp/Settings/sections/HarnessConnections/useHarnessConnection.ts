import { useCallback, useEffect, useRef, useState } from "react";

import { rpc } from "@src/api/tauri/rpc";
import type {
  ConnectionHarness,
  HarnessConnectionView,
} from "@src/api/tauri/rpc/schemas/agentOrgs";

// At most two in-flight reads. No retained response cache, timers or background scans.
const reads = new Map<ConnectionHarness, Promise<HarnessConnectionView>>();
const listeners = new Set<() => void>();

export type HarnessConnectionReloadResult =
  | { status: "updated" }
  | { status: "stale" }
  | { status: "failed"; error: string };

export function refreshHarnessConnections() {
  reads.clear();
  listeners.forEach((listener) => listener());
}
export function readHarnessConnection(agentName: ConnectionHarness) {
  const pending = reads.get(agentName);
  if (pending) return pending;
  const request = rpc.agentOrgs.connections
    .status({ agentName })
    .finally(() => {
      if (reads.get(agentName) === request) reads.delete(agentName);
    });
  reads.set(agentName, request);
  return request;
}

export function useHarnessConnection(agentName: ConnectionHarness) {
  const [view, setView] = useState<HarnessConnectionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);
  const load = useCallback(
    async (surfaceError = true): Promise<HarnessConnectionReloadResult> => {
      const current = ++generation.current;
      setLoading(true);
      try {
        const next = await readHarnessConnection(agentName);
        if (generation.current !== current) return { status: "stale" };
        setView(next);
        setError(null);
        return { status: "updated" };
      } catch (error) {
        if (generation.current !== current) return { status: "stale" };
        const detail = String(error);
        if (surfaceError) setError(detail);
        return { status: "failed", error: detail };
      } finally {
        if (generation.current === current) setLoading(false);
      }
    },
    [agentName]
  );
  useEffect(() => {
    setView(null);
    void load();
    const reload = () => {
      void load();
    };
    const focus = () => {
      if (!document.hidden) reload();
    };
    const requestGeneration = generation;
    listeners.add(reload);
    window.addEventListener("focus", focus);
    return () => {
      requestGeneration.current++;
      listeners.delete(reload);
      window.removeEventListener("focus", focus);
    };
  }, [load]);
  const reload = useCallback(() => {
    setError(null);
    return load(false);
  }, [load]);
  return {
    view,
    error,
    loading,
    reload,
  };
}
