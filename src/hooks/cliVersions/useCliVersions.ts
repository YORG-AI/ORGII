import { useCallback, useEffect, useState } from "react";

import { scanCliVersion as scanCliVersionRpc } from "@src/api/services/keyValidation";
import type {
  CliAgentType,
  CliVersionSnapshot,
} from "@src/api/tauri/rpc/schemas/validation";

const VERSION_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

let sharedVersions = new Map<CliAgentType, CliVersionSnapshot>();
const scanPromises = new Map<CliAgentType, Promise<CliVersionSnapshot>>();
const listeners = new Set<() => void>();

function isFresh(snapshot: CliVersionSnapshot): boolean {
  const scannedAt = Date.parse(snapshot.scanned_at);
  return (
    !snapshot.stale &&
    Number.isFinite(scannedAt) &&
    Date.now() - scannedAt < VERSION_CACHE_TTL_MS
  );
}

function publish(snapshot: CliVersionSnapshot) {
  const next = new Map(sharedVersions);
  const agentType = snapshot.agent_type as CliAgentType;
  const existing = next.get(agentType);
  if (
    !existing ||
    Date.parse(snapshot.scanned_at) >= Date.parse(existing.scanned_at)
  ) {
    next.set(agentType, snapshot);
  }
  sharedVersions = next;
  for (const listener of listeners) listener();
}

/** Shared, demand-driven CLI version observations for Session Creator. */
export function useCliVersions() {
  const [, setVersion] = useState(0);

  useEffect(() => {
    const listener = () => setVersion((version) => version + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const scanVersion = useCallback(
    async (agentType: CliAgentType, force = false) => {
      const cached = sharedVersions.get(agentType);
      if (!force && cached && isFresh(cached)) return cached;

      const existingPromise = scanPromises.get(agentType);
      if (existingPromise) return existingPromise;

      const promise = scanCliVersionRpc(agentType, force)
        .then((snapshot) => {
          publish(snapshot);
          return snapshot;
        })
        .finally(() => {
          if (scanPromises.get(agentType) === promise) {
            scanPromises.delete(agentType);
          }
        });
      scanPromises.set(agentType, promise);
      return promise;
    },
    []
  );

  const getVersion = useCallback((agentType: CliAgentType) => {
    const snapshot = sharedVersions.get(agentType);
    return snapshot
      ? {
          ...snapshot,
          stale: !isFresh(snapshot),
        }
      : undefined;
  }, []);

  return { getVersion, scanVersion };
}
