import { useEffect, useState } from "react";

import { scanCliVersion as scanCliVersionRpc } from "@src/api/services/keyValidation";
import type {
  CliAgentType,
  CliVersionSnapshot,
} from "@src/api/tauri/rpc/schemas/validation";
import { createLogger } from "@src/hooks/logger";

const VERSION_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const log = createLogger("CliVersions");

let sharedVersions = new Map<CliAgentType, CliVersionSnapshot>();
const scanPromises = new Map<CliAgentType, Promise<CliVersionSnapshot>>();
const listeners = new Set<() => void>();
interface ScheduledVersionRecheck {
  scanAt: number;
  subscribers: number;
  timeoutId: number;
}
const scheduledVersionRechecks = new Map<
  CliAgentType,
  ScheduledVersionRecheck
>();
const versionRechecksInFlight = new Map<CliAgentType, number>();
const handledVersionRechecks = new Map<CliAgentType, number>();

function isFresh(snapshot: CliVersionSnapshot): boolean {
  const scannedAt = Date.parse(snapshot.scanned_at);
  return (
    !snapshot.stale &&
    Number.isFinite(scannedAt) &&
    Date.now() - scannedAt < VERSION_CACHE_TTL_MS
  );
}

function notifyListeners() {
  for (const listener of listeners) listener();
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
  notifyListeners();
}

async function scanVersion(agentType: CliAgentType, force = false) {
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
}

function runScheduledVersionRecheck(agentType: CliAgentType, scanAt: number) {
  const scheduled = scheduledVersionRechecks.get(agentType);
  if (!scheduled || scheduled.scanAt !== scanAt) return;

  scheduledVersionRechecks.delete(agentType);
  handledVersionRechecks.set(agentType, scanAt);
  versionRechecksInFlight.set(agentType, scanAt);
  void scanVersion(agentType, true)
    .catch((error) => {
      log.warn("Scheduled CLI version recheck failed", error);
    })
    .finally(() => {
      if (versionRechecksInFlight.get(agentType) === scanAt) {
        versionRechecksInFlight.delete(agentType);
      }
      notifyListeners();
    });
}

function subscribeVersionRecheck(agentType: CliAgentType, scanAt: number) {
  if ((handledVersionRechecks.get(agentType) ?? 0) >= scanAt) {
    return () => undefined;
  }

  const existing = scheduledVersionRechecks.get(agentType);
  if (existing?.scanAt === scanAt) {
    existing.subscribers += 1;
    return () => {
      const current = scheduledVersionRechecks.get(agentType);
      if (current !== existing) return;
      current.subscribers -= 1;
      if (current.subscribers === 0) {
        window.clearTimeout(current.timeoutId);
        scheduledVersionRechecks.delete(agentType);
      }
    };
  }

  if (existing) window.clearTimeout(existing.timeoutId);
  const scheduled: ScheduledVersionRecheck = {
    scanAt,
    subscribers: 1,
    timeoutId: window.setTimeout(
      () => runScheduledVersionRecheck(agentType, scanAt),
      Math.max(0, scanAt - Date.now())
    ),
  };
  scheduledVersionRechecks.set(agentType, scheduled);

  return () => {
    const current = scheduledVersionRechecks.get(agentType);
    if (current !== scheduled) return;
    current.subscribers -= 1;
    if (current.subscribers === 0) {
      window.clearTimeout(current.timeoutId);
      scheduledVersionRechecks.delete(agentType);
    }
  };
}

function isVersionRecheckPending(agentType: CliAgentType, scanAt: number) {
  return (
    scheduledVersionRechecks.get(agentType)?.scanAt === scanAt ||
    versionRechecksInFlight.get(agentType) === scanAt
  );
}

function getVersion(agentType: CliAgentType) {
  const snapshot = sharedVersions.get(agentType);
  return snapshot
    ? {
        ...snapshot,
        stale: !isFresh(snapshot),
      }
    : undefined;
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

  return {
    getVersion,
    isVersionRecheckPending,
    scanVersion,
    subscribeVersionRecheck,
  };
}
