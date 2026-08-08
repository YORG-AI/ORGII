import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  __CLIENT_CREATED_SESSION_REGISTRY_INTERNALS,
  acknowledgeNativeCreatedSessions,
  loadClientCreatedRosterProjections,
  mergeClientCreatedSessions,
  recordClientCreatedSession,
  removeClientCreatedSession,
  syncClientCreatedSessionRecords,
} from "./createdSessionRegistry";
import type { Session } from "./types";

const {
  CLIENT_CREATED_SESSION_REGISTRY_STORAGE_KEY,
  LEGACY_GUEST_IMPORT_REGISTRY_STORAGE_KEY,
  MAX_REGISTRY_ENTRIES,
} = __CLIENT_CREATED_SESSION_REGISTRY_INTERNALS;

function session(id: string, updatedAt = "2026-08-08T10:00:00Z"): Session {
  return {
    session_id: id,
    status: "completed",
    created_at: updatedAt,
    updated_at: updatedAt,
    name: id,
    category: "rust_agent",
  };
}

describe("createdSessionRegistry", () => {
  beforeEach(() => {
    localStorage.removeItem(CLIENT_CREATED_SESSION_REGISTRY_STORAGE_KEY);
    localStorage.removeItem(LEGACY_GUEST_IMPORT_REGISTRY_STORAGE_KEY);
    vi.restoreAllMocks();
  });

  it("re-materializes a locally owned row and its explicit roster projection", () => {
    const imported = {
      ...session("imported-session-collaboration"),
      category: "external_history" as const,
    };
    recordClientCreatedSession(imported, {
      category: "standalone_agent",
      ownership: "local",
    });

    expect(mergeClientCreatedSessions([])).toEqual([imported]);
    expect(loadClientCreatedRosterProjections()).toEqual([
      {
        sessionId: imported.session_id,
        category: "standalone_agent",
        ownership: "local",
      },
    ]);
  });

  it("keeps a pending native creation through replacement and evicts it on acknowledgement", () => {
    const fork = session("agentsession-fork");
    recordClientCreatedSession(fork, {
      category: "standalone_agent",
      ownership: "native",
    });

    expect(mergeClientCreatedSessions([])).toEqual([fork]);
    expect(acknowledgeNativeCreatedSessions([fork])).toEqual([fork.session_id]);
    expect(loadClientCreatedRosterProjections()).toEqual([]);
    expect(mergeClientCreatedSessions([])).toEqual([]);
  });

  it("does not treat persisted-cache hydration as native acknowledgement", () => {
    const fork = session("agentsession-fork");
    recordClientCreatedSession(fork, {
      category: "standalone_agent",
      ownership: "native",
    });

    expect(
      mergeClientCreatedSessions([fork], { acknowledgeNative: false })
    ).toEqual([fork]);
    expect(loadClientCreatedRosterProjections()).toEqual([
      {
        sessionId: fork.session_id,
        category: "standalone_agent",
        ownership: "native",
      },
    ]);
  });

  it("does not acknowledge a locally owned row on an ID collision", () => {
    const imported = session("imported-session-json");
    recordClientCreatedSession(imported, {
      category: "standalone_agent",
      ownership: "local",
    });

    expect(acknowledgeNativeCreatedSessions([imported])).toEqual([]);
    expect(loadClientCreatedRosterProjections()).toHaveLength(1);
  });

  it("keeps the durable snapshot aligned with persisted session metadata", () => {
    const imported = session("imported-session-json");
    recordClientCreatedSession(imported, {
      category: "standalone_agent",
      ownership: "local",
    });
    syncClientCreatedSessionRecords([{ ...imported, name: "Renamed" }]);

    expect(mergeClientCreatedSessions([])[0].name).toBe("Renamed");
  });

  it("removes a local row durably", () => {
    const imported = session("imported-session-json");
    recordClientCreatedSession(imported, {
      category: "standalone_agent",
      ownership: "local",
    });
    removeClientCreatedSession(imported.session_id);

    expect(mergeClientCreatedSessions([])).toEqual([]);
    expect(loadClientCreatedRosterProjections()).toEqual([]);
  });

  it("migrates the legacy guest registry without losing capability fields", () => {
    const guest = {
      ...session("imported-session-guest"),
      category: "external_history" as const,
      importedFrom: {
        orgId: "org-1",
        sourceSessionId: "source-1",
        ownerMemberId: "owner-1",
        epoch: 1,
        seq: 2,
        count: 3,
        shareToken: "share-token",
      },
    };
    localStorage.setItem(
      LEGACY_GUEST_IMPORT_REGISTRY_STORAGE_KEY,
      JSON.stringify({ [guest.session_id]: guest })
    );

    const restored = mergeClientCreatedSessions([])[0];
    expect(restored.importedFrom?.shareToken).toBe("share-token");
    expect(loadClientCreatedRosterProjections()[0].category).toBe(
      "standalone_agent"
    );
    expect(
      localStorage.getItem(LEGACY_GUEST_IMPORT_REGISTRY_STORAGE_KEY)
    ).toBeNull();
  });

  it("bounds never-acknowledged rows with deterministic oldest-first eviction", () => {
    vi.spyOn(Date, "now").mockReturnValue(1);
    for (let index = 0; index < MAX_REGISTRY_ENTRIES + 2; index += 1) {
      recordClientCreatedSession(
        session(
          `imported-session-${index}`,
          new Date(Date.UTC(2026, 7, 8, 10, 0, index)).toISOString()
        ),
        { category: "standalone_agent", ownership: "local" }
      );
    }

    const ids = new Set(
      mergeClientCreatedSessions([]).map((entry) => entry.session_id)
    );
    expect(ids.size).toBe(MAX_REGISTRY_ENTRIES);
    expect(ids.has("imported-session-0")).toBe(false);
    expect(ids.has(`imported-session-${MAX_REGISTRY_ENTRIES + 1}`)).toBe(true);
  });
});
