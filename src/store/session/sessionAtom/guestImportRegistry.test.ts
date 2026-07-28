import { beforeEach, describe, expect, it } from "vitest";

import {
  __GUEST_IMPORT_REGISTRY_INTERNALS,
  mergeGuestImportedSessions,
  recordGuestImportedSession,
  removeGuestImportedSession,
} from "./guestImportRegistry";
import type { Session } from "./types";

const { GUEST_IMPORT_REGISTRY_STORAGE_KEY, MAX_REGISTRY_ENTRIES } =
  __GUEST_IMPORT_REGISTRY_INTERNALS;

function guestSession(id: string, updatedAt = "2026-07-17T10:00:00Z"): Session {
  return {
    session_id: id,
    status: "completed",
    created_at: "2026-07-17T09:00:00Z",
    updated_at: updatedAt,
    completed_at: updatedAt,
    name: `Shared replay ${id}`,
    repoPath: "/viewer/repo",
    category: "external_history",
    agentIconId: "archive",
    agentDisplayName: "Collaboration Snapshot",
    importedFrom: {
      orgId: "corg-1",
      sourceSessionId: `source-${id}`,
      ownerMemberId: "owner-1",
      ownerDisplayName: "Owner",
      ownerAvatarUrl: "https://example.com/owner.png",
      epoch: 2,
      seq: 3,
      count: 40,
      frozenCount: 30,
      tailHash: "tail-hash",
      importedAt: updatedAt,
      externalHistorySource: "codex_app",
      sourceDisplay: {
        cliAgentType: "codex",
        agentDisplayName: "Codex App",
        model: "gpt-5.6-sol",
      },
      shareToken: `token-${id}`,
      shareEndpointUrl: "https://supabase.acme.dev",
    },
  } as Session;
}

function memberSession(id: string): Session {
  const session = guestSession(id);
  return {
    ...session,
    importedFrom: { ...session.importedFrom!, shareToken: undefined },
  };
}

function nativeSession(id: string): Session {
  return {
    session_id: id,
    status: "completed",
    created_at: "2026-07-17T09:00:00Z",
    updated_at: "2026-07-17T11:00:00Z",
    name: `Native ${id}`,
    category: "rust_agent",
  } as Session;
}

describe("guestImportRegistry", () => {
  beforeEach(() => {
    localStorage.removeItem(GUEST_IMPORT_REGISTRY_STORAGE_KEY);
  });

  it("re-materializes a recorded guest row after an authoritative replace", () => {
    const guest = guestSession("imported-session-1");
    recordGuestImportedSession(guest);

    const merged = mergeGuestImportedSessions([nativeSession("agent-1")]);

    expect(merged.map((session) => session.session_id)).toEqual([
      "agent-1",
      "imported-session-1",
    ]);
    const restored = merged.find(
      (session) => session.session_id === "imported-session-1"
    );
    expect(restored?.importedFrom?.shareToken).toBe("token-imported-session-1");
    expect(restored?.importedFrom?.shareEndpointUrl).toBe(
      "https://supabase.acme.dev"
    );
    expect(restored?.importedFrom?.ownerAvatarUrl).toBe(
      "https://example.com/owner.png"
    );
    expect(restored?.importedFrom?.sourceDisplay).toEqual({
      cliAgentType: "codex",
      agentDisplayName: "Codex App",
      model: "gpt-5.6-sol",
    });
  });

  it("prefers the live row over the registry copy on id collision", () => {
    const guest = guestSession("imported-session-1");
    recordGuestImportedSession(guest);
    const liveRow = { ...guest, name: "Renamed live" };

    const merged = mergeGuestImportedSessions([liveRow]);

    expect(merged).toHaveLength(1);
    expect(merged[0].name).toBe("Renamed live");
  });

  it("never records member imports (no share token)", () => {
    recordGuestImportedSession(memberSession("imported-session-2"));
    expect(mergeGuestImportedSessions([])).toEqual([]);
  });

  it("removal is durable across merges", () => {
    recordGuestImportedSession(guestSession("imported-session-1"));
    removeGuestImportedSession("imported-session-1");
    expect(mergeGuestImportedSessions([])).toEqual([]);
  });

  it("survives a cold start (fresh module read from storage only)", () => {
    recordGuestImportedSession(guestSession("imported-session-1"));

    const raw = localStorage.getItem(GUEST_IMPORT_REGISTRY_STORAGE_KEY);
    expect(raw).toBeTruthy();
    localStorage.setItem(GUEST_IMPORT_REGISTRY_STORAGE_KEY, raw!);

    const merged = mergeGuestImportedSessions([]);
    expect(merged).toHaveLength(1);
    expect(merged[0].session_id).toBe("imported-session-1");
  });

  it("resets silently on a corrupt payload", () => {
    localStorage.setItem(GUEST_IMPORT_REGISTRY_STORAGE_KEY, "{not json");
    expect(mergeGuestImportedSessions([nativeSession("agent-1")])).toHaveLength(
      1
    );
  });

  it("evicts the oldest entries past the cap", () => {
    for (let index = 0; index < MAX_REGISTRY_ENTRIES + 5; index += 1) {
      recordGuestImportedSession(
        guestSession(
          `imported-session-${index}`,
          `2026-07-17T10:${String(index % 60).padStart(2, "0")}:${String(
            Math.floor(index / 60)
          ).padStart(2, "0")}Z`
        )
      );
    }
    const merged = mergeGuestImportedSessions([]);
    expect(merged).toHaveLength(MAX_REGISTRY_ENTRIES);
    expect(
      merged.some((session) => session.session_id === "imported-session-0")
    ).toBe(false);
  });
});
