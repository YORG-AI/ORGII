import { createStore } from "jotai";
import { describe, expect, it, vi } from "vitest";

import { sessionsAtom } from "@src/store/session/sessionAtom/atoms";
import type { Session } from "@src/store/session/sessionAtom/types";

import { sessionOrgTagsAtom } from "../TeamCollaboration/sessionOrgTagsAtom";
import {
  org2CloudPushCursorsAtom,
  org2CloudPushedMetadataAtom,
  org2CloudRepoScopesAtom,
} from "./org2CloudSyncAtoms";
import {
  markedSessionIdsForOrg,
  orgsWithLocalPushMarkers,
  reconcileOrgRetracts,
} from "./org2CloudSyncEngine.retractReconcile";

// Network-identity lookups must ANSWER in these tests: a FAILED lookup now
// defers the out-of-scope verdict (scope-flapping guard) instead of counting
// as "no match". Identity = itself keeps exact-string semantics.
vi.mock("@src/api/tauri/github", () => ({
  resolveGitHubRepoNetworkIdentityLocal: vi.fn(async (fullName: string) => ({
    source_full_name: fullName,
  })),
}));

const ORG = "11111111-1111-4111-8111-111111111111";

describe("push-marker enumeration", () => {
  it("collects org ids and session ids from both marker atoms", () => {
    const cursors = { [`${ORG}:sess-a`]: {} };
    const meta = { [`${ORG}:sess-b`]: true, "other-org:sess-c": true };
    expect(orgsWithLocalPushMarkers(cursors, meta)).toEqual(
      new Set([ORG, "other-org"])
    );
    expect(markedSessionIdsForOrg(ORG, cursors, meta)).toEqual(
      new Set(["sess-a", "sess-b"])
    );
  });
});

function session(overrides: Partial<Session>): Session {
  return {
    session_id: "claudecodeapp-x",
    repoPath: "/Users/me/org2",
    repoRemoteUrls: ["git@github.com:org2ai/org2.git"],
    ...overrides,
  } as Session;
}

function setup(options: {
  sessions: Session[];
  marked: string[];
  scopes?: string[];
  serverConfirmed?: boolean;
}) {
  const store = createStore();
  store.set(sessionsAtom, options.sessions);
  store.set(
    org2CloudPushCursorsAtom,
    Object.fromEntries(
      options.marked.map((id) => [`${ORG}:${id}`, { orgId: ORG } as never])
    )
  );
  store.set(org2CloudPushedMetadataAtom, {});
  store.set(org2CloudRepoScopesAtom, { [ORG]: options.scopes ?? [] });
  const retractSession = vi.fn(async () => undefined);
  const deps = {
    store: store as never,
    accessByOrg: {},
    wasCloudPushed: () => true,
    retractSession,
    hasServerConfirmedScopes: () => options.serverConfirmed ?? true,
    isCurrentGeneration: () => true,
  };
  return { deps, retractSession, store };
}

describe("reconcileOrgRetracts", () => {
  it("retracts a marked session that lost every admission route", async () => {
    const { deps, retractSession } = setup({
      sessions: [
        session({ session_id: "personal-1", repoRemoteUrls: undefined }),
      ],
      marked: ["personal-1"],
    });
    await reconcileOrgRetracts(deps, ORG);
    expect(retractSession).toHaveBeenCalledWith(ORG, "personal-1");
  });

  it("retracts an admitted session whose repo left the org scope", async () => {
    const { deps, retractSession, store } = setup({
      sessions: [session({ session_id: "claudecodeapp-x" })],
      marked: ["claudecodeapp-x"],
      scopes: ["github.com/other/repo"],
    });
    store.set(sessionOrgTagsAtom, {});
    await reconcileOrgRetracts(deps, ORG);
    expect(retractSession).toHaveBeenCalledWith(ORG, "claudecodeapp-x");
  });

  it("keeps an in-scope session untouched", async () => {
    const { deps, retractSession } = setup({
      sessions: [session({ session_id: "claudecodeapp-x" })],
      marked: ["claudecodeapp-x"],
      scopes: ["github.com/org2ai/org2"],
    });
    await reconcileOrgRetracts(deps, ORG);
    expect(retractSession).not.toHaveBeenCalled();
  });

  it("defers the out-of-scope verdict until scopes are server-confirmed", async () => {
    const { deps, retractSession } = setup({
      sessions: [session({ session_id: "claudecodeapp-x" })],
      marked: ["claudecodeapp-x"],
      scopes: ["github.com/other/repo"],
      serverConfirmed: false,
    });
    await reconcileOrgRetracts(deps, ORG);
    expect(retractSession).not.toHaveBeenCalled();
  });

  it("leaves locally-absent sessions to the vanished-session sweep", async () => {
    const { deps, retractSession } = setup({
      sessions: [],
      marked: ["gone-1"],
    });
    await reconcileOrgRetracts(deps, ORG);
    expect(retractSession).not.toHaveBeenCalled();
  });
});
