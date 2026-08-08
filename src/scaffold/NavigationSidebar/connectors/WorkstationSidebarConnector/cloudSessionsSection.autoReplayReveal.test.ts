import { describe, expect, it } from "vitest";

import { buildCloudRemoteItemId } from "@src/features/Org2Cloud/cloudRemoteItemId";
import type { CloudSessionBusyEntry } from "@src/features/Org2Cloud/cloudSessionBusyAtom";
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";
import type { SessionSidebarRevealRequest } from "@src/store/ui/sidebarAtom";

import {
  AUTO_REPLAY_REQUEST_TTL_MS,
  type CloudAutoReplayInput,
  decideCloudAutoReplay,
} from "./cloudSessionsSection.autoReplayReveal";

const ORG = "0830d453-1111-4222-8333-444455556666";
const OWNER = "6c6a39b1-4ca5-4c48-89b4-74d1565c258d";
const SOURCE = "sdeagent-1784668132283";
const ROW_ID = `${ORG}:${OWNER}:${SOURCE}`;
const NOW = 1_800_000_000_000;
const FETCHED_AT = NOW - 5_000;

const row = {
  id: ROW_ID,
  orgId: ORG,
  ownerUserId: OWNER,
  sourceSessionId: SOURCE,
  eventsEpoch: 4,
} as RemoteTeammateSessionMetadata;

function request(
  overrides: Partial<SessionSidebarRevealRequest> = {}
): SessionSidebarRevealRequest {
  return {
    sessionId: SOURCE,
    sidebarItemId: buildCloudRemoteItemId(ORG, ROW_ID),
    cloudOrgId: ORG,
    autoReplay: true,
    requestId: 7,
    issuedAt: NOW - 1_000,
    ...overrides,
  };
}

function input(
  overrides: Partial<CloudAutoReplayInput> = {}
): CloudAutoReplayInput {
  return {
    request: request(),
    orgId: ORG,
    consumedRequestId: 0,
    probe: null,
    rows: [row],
    state: "ready",
    fetchedAt: FETCHED_AT,
    busySessionRows: new Map<string, CloudSessionBusyEntry>(),
    selfUserId: "viewer-1",
    localOwnSessionIds: new Set<string>(),
    nowMs: NOW,
    ...overrides,
  };
}

describe("decideCloudAutoReplay", () => {
  it("replays the referenced row once the org and listing have settled", () => {
    expect(decideCloudAutoReplay(input())).toEqual({
      kind: "replay",
      requestId: 7,
      row,
    });
  });

  it("ignores a request already consumed, so a remount cannot re-download", () => {
    expect(decideCloudAutoReplay(input({ consumedRequestId: 7 }))).toBeNull();
    expect(decideCloudAutoReplay(input({ consumedRequestId: 9 }))).toBeNull();
  });

  it("acts on a newer request after an earlier one was consumed", () => {
    expect(
      decideCloudAutoReplay(
        input({ request: request({ requestId: 8 }), consumedRequestId: 7 })
      )
    ).toMatchObject({ kind: "replay", requestId: 8 });
  });

  it("stops honouring a request that was never served in time", () => {
    // A reveal aimed at a cloud row is never cleared. Without expiry an
    // unrelated org switch an hour later would start a surprise download.
    const stale = request({
      issuedAt: NOW - AUTO_REPLAY_REQUEST_TTL_MS - 1,
    });
    expect(decideCloudAutoReplay(input({ request: stale }))).toBeNull();
    const fresh = request({ issuedAt: NOW - AUTO_REPLAY_REQUEST_TTL_MS + 1 });
    expect(decideCloudAutoReplay(input({ request: fresh }))).toMatchObject({
      kind: "replay",
    });
  });

  it("ignores reveal requests that did not ask for replay", () => {
    expect(
      decideCloudAutoReplay(
        input({ request: request({ autoReplay: undefined }) })
      )
    ).toBeNull();
    expect(decideCloudAutoReplay(input({ request: null }))).toBeNull();
  });

  it("waits until the section is scoped to the request's org", () => {
    expect(decideCloudAutoReplay(input({ orgId: null }))).toBeNull();
    expect(decideCloudAutoReplay(input({ orgId: "other-org" }))).toBeNull();
  });

  it("is not deferred by an unrelated row's in-flight action", () => {
    expect(
      decideCloudAutoReplay(
        input({
          busySessionRows: new Map<string, CloudSessionBusyEntry>([
            ["some-other-row", { kind: "replay", orgId: ORG }],
          ]),
        })
      )
    ).toMatchObject({ kind: "replay", requestId: 7 });
  });

  it("refocuses the referenced row's surface when it is already downloading", () => {
    expect(
      decideCloudAutoReplay(
        input({
          busySessionRows: new Map<string, CloudSessionBusyEntry>([
            [
              ROW_ID,
              {
                kind: "replay",
                orgId: ORG,
                localSessionId: "imported-session-abc",
              },
            ],
          ]),
        })
      )
    ).toEqual({
      kind: "focus-busy",
      requestId: 7,
      row,
      localSessionId: "imported-session-abc",
    });
  });

  it("keeps waiting when the busy referenced row has left the listing", () => {
    expect(
      decideCloudAutoReplay(
        input({
          rows: [],
          busySessionRows: new Map<string, CloudSessionBusyEntry>([
            [ROW_ID, { kind: "replay", orgId: ORG }],
          ]),
        })
      )
    ).toBeNull();
  });

  describe("absence", () => {
    it("waits for the initial listing rather than judging it missing", () => {
      for (const state of ["idle", "loading", "error"] as const) {
        expect(decideCloudAutoReplay(input({ rows: [], state }))).toBeNull();
      }
    });

    it("forces one refresh before believing a cached listing", () => {
      // "ready" only means a fetch once finished: an org the viewer is not
      // scoped to gets no invalidations, so its rows can predate the share
      // the reference points at.
      expect(decideCloudAutoReplay(input({ rows: [] }))).toEqual({
        kind: "refresh",
        requestId: 7,
        fetchedAt: FETCHED_AT,
      });
    });

    it("keeps waiting while the forced refresh is in flight", () => {
      expect(
        decideCloudAutoReplay(
          input({ rows: [], probe: { requestId: 7, fetchedAt: FETCHED_AT } })
        )
      ).toBeNull();
    });

    it("reports not-found only after a fetch that started post-request", () => {
      expect(
        decideCloudAutoReplay(
          input({
            rows: [],
            probe: { requestId: 7, fetchedAt: FETCHED_AT },
            fetchedAt: FETCHED_AT + 1,
          })
        )
      ).toEqual({ kind: "skip", requestId: 7, reason: "not-found" });
    });

    it("re-probes for a newer request instead of reusing an old probe", () => {
      expect(
        decideCloudAutoReplay(
          input({
            rows: [],
            request: request({ requestId: 8 }),
            consumedRequestId: 7,
            probe: { requestId: 7, fetchedAt: FETCHED_AT },
            fetchedAt: FETCHED_AT + 1,
          })
        )
      ).toMatchObject({ kind: "refresh", requestId: 8 });
    });

    it("replays normally once the refresh brings the row in", () => {
      expect(
        decideCloudAutoReplay(
          input({
            probe: { requestId: 7, fetchedAt: FETCHED_AT },
            fetchedAt: FETCHED_AT + 1,
          })
        )
      ).toMatchObject({ kind: "replay", requestId: 7 });
    });
  });

  it("reveals the local session instead of importing the viewer's own row", () => {
    // Replaying here would mint an imported-session-<hash> read-only copy
    // of a live writable session and hide the original from My Sessions.
    expect(
      decideCloudAutoReplay(
        input({
          selfUserId: OWNER,
          localOwnSessionIds: new Set([SOURCE]),
        })
      )
    ).toEqual({ kind: "reveal-local", requestId: 7, sessionId: SOURCE });
  });

  it("still replays an own-owned row that has no local session here", () => {
    expect(
      decideCloudAutoReplay(
        input({ selfUserId: OWNER, localOwnSessionIds: new Set<string>() })
      )
    ).toMatchObject({ kind: "replay" });
  });

  it("skips rows that cannot be replayed", () => {
    const unpublished = { ...row, eventsEpoch: undefined };
    expect(decideCloudAutoReplay(input({ rows: [unpublished] }))).toEqual({
      kind: "skip",
      requestId: 7,
      reason: "not-replayable",
    });
    const tombstoned = { ...row, deletedAt: "2026-07-27T00:00:00Z" };
    expect(decideCloudAutoReplay(input({ rows: [tombstoned] }))).toEqual({
      kind: "skip",
      requestId: 7,
      reason: "not-replayable",
    });
  });

  it("ignores requests whose sidebar item is missing or foreign", () => {
    expect(
      decideCloudAutoReplay(
        input({ request: request({ sidebarItemId: undefined }) })
      )
    ).toBeNull();
    expect(
      decideCloudAutoReplay(
        input({
          request: request({
            sidebarItemId: buildCloudRemoteItemId("other-org", ROW_ID),
          }),
        })
      )
    ).toBeNull();
    expect(
      decideCloudAutoReplay(
        input({ request: request({ sidebarItemId: "not-a-cloud-item" }) })
      )
    ).toBeNull();
  });
});
