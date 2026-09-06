import { describe, expect, it } from "vitest";

import type { CloudSessionDownloadProgress } from "@src/features/Org2Cloud/cloudSessionDownloadProgressAtom";
import type { Session } from "@src/store/session";

import { isImportedSessionSubmitBlocked } from "./importedSessionSubmitReadiness";

const session = {
  session_id: "imported-session-abc",
  importedFrom: {
    orgId: "org-1",
    sourceSessionId: "source-1",
    sourceEndpointUrl: "https://cloud.example.test",
  },
} as Session;

function progress(
  loadedEvents: number,
  phase: CloudSessionDownloadProgress["phase"] = "downloading"
): CloudSessionDownloadProgress {
  return {
    authIdentityKey: "https://cloud.example.test|user-1",
    rowId: "org-1:owner:source-1",
    orgId: "org-1",
    loadedEvents,
    totalEvents: 100,
    startedAtMs: 0,
    updatedAtMs: 1,
    phase,
  };
}

describe("isImportedSessionSubmitBlocked", () => {
  it.each([0, 29, 67, 99])(
    "blocks imported replay submit at %i%%",
    (loadedEvents) => {
      expect(
        isImportedSessionSubmitBlocked({
          sessionId: session.session_id,
          session,
          progress: progress(loadedEvents),
        })
      ).toBe(true);
    }
  );

  it("blocks finalizing, paused, and not-yet-hydrated imported sessions", () => {
    for (const phase of ["finalizing", "paused"] as const) {
      expect(
        isImportedSessionSubmitBlocked({
          sessionId: session.session_id,
          session,
          progress: progress(99, phase),
        })
      ).toBe(true);
    }
    expect(
      isImportedSessionSubmitBlocked({
        sessionId: session.session_id,
        session: undefined,
        progress: progress(100, "completed"),
      })
    ).toBe(true);
  });

  it("unblocks only a completed, provenance-hydrated replay", () => {
    expect(
      isImportedSessionSubmitBlocked({
        sessionId: session.session_id,
        session,
        progress: progress(100, "completed"),
      })
    ).toBe(false);
    expect(
      isImportedSessionSubmitBlocked({
        sessionId: session.session_id,
        session,
        progress: undefined,
      })
    ).toBe(false);
  });

  it("does not gate ordinary native sessions", () => {
    expect(
      isImportedSessionSubmitBlocked({
        sessionId: "agentsession-native",
        session: undefined,
        progress: progress(67),
      })
    ).toBe(false);
  });
});
