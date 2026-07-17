import { describe, expect, it } from "vitest";

import type { CloudOrgRemoteSessionsEntry } from "@src/features/Org2Cloud/org2CloudRemoteSessionsAtom";
import { COLLAB_IDENTITY_KIND } from "@src/store/collaboration/types";
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";

import type { ForkTaskContext } from "../../forkSession";
import { resolveAddressingComment } from "./addressingComment";

const TASK_CONTEXT: ForkTaskContext = {
  orgId: "org-1",
  sourceSessionId: "source-1",
  commentId: "comment-1",
  taskId: "task-1",
  excerpt: "fix the flaky auth test",
};

const IMPORTED_FROM = {
  orgId: "org-1",
  sourceSessionId: "fork-remote-1",
  ownerMemberId: "m2",
};

function makeRemote(
  overrides: Partial<RemoteTeammateSessionMetadata> = {}
): RemoteTeammateSessionMetadata {
  return {
    id: "org-1:m2:fork-remote-1",
    orgId: "org-1",
    ownerMemberId: "m2",
    ownerUserId: "m2",
    ownerDisplayName: "Bob",
    ownerIdentityKind: COLLAB_IDENTITY_KIND.HUMAN,
    sourceSessionId: "fork-remote-1",
    title: "Pushed comment-task fork",
    eventsEpoch: 1,
    eventsFrozenSeq: 1,
    eventsCount: 4,
    eventsTailHash: "hash",
    addressesComment: { commentId: "comment-1", sourceSessionId: "source-1" },
    ...overrides,
  };
}

function makeEntries(
  rows: RemoteTeammateSessionMetadata[],
  orgId = "org-1"
): Record<string, CloudOrgRemoteSessionsEntry> {
  return { [orgId]: { rows, state: "ready", fetchedAt: 1 } };
}

describe("resolveAddressingComment", () => {
  it("resolves the registry taskContext with its excerpt", () => {
    expect(
      resolveAddressingComment({
        taskContext: TASK_CONTEXT,
        importedFrom: undefined,
        remoteEntries: {},
      })
    ).toEqual({
      orgId: "org-1",
      sourceSessionId: "source-1",
      commentId: "comment-1",
      excerpt: "fix the flaky auth test",
    });
  });

  it("drops a whitespace-only registry excerpt", () => {
    const resolved = resolveAddressingComment({
      taskContext: { ...TASK_CONTEXT, excerpt: "   " },
      importedFrom: undefined,
      remoteEntries: {},
    });
    expect(resolved?.excerpt).toBeUndefined();
    expect(resolved?.commentId).toBe("comment-1");
  });

  it("prefers the registry carrier over the wire carrier", () => {
    const resolved = resolveAddressingComment({
      taskContext: { ...TASK_CONTEXT, commentId: "registry-comment" },
      importedFrom: IMPORTED_FROM,
      remoteEntries: makeEntries([makeRemote()]),
    });
    expect(resolved?.commentId).toBe("registry-comment");
  });

  it("falls back to the imported row's wire addressesComment (no excerpt)", () => {
    expect(
      resolveAddressingComment({
        taskContext: undefined,
        importedFrom: IMPORTED_FROM,
        remoteEntries: makeEntries([makeRemote()]),
      })
    ).toEqual({
      orgId: "org-1",
      sourceSessionId: "source-1",
      commentId: "comment-1",
    });
  });

  it("returns undefined when the cached remote row is tombstoned", () => {
    expect(
      resolveAddressingComment({
        taskContext: undefined,
        importedFrom: IMPORTED_FROM,
        remoteEntries: makeEntries([
          makeRemote({ deletedAt: "2026-07-02T00:00:00.000Z" }),
        ]),
      })
    ).toBeUndefined();
  });

  it("returns undefined when no rows are cached for the org", () => {
    expect(
      resolveAddressingComment({
        taskContext: undefined,
        importedFrom: IMPORTED_FROM,
        remoteEntries: makeEntries([makeRemote()], "other-org"),
      })
    ).toBeUndefined();
  });

  it("returns undefined when the remote row carries no addressesComment", () => {
    expect(
      resolveAddressingComment({
        taskContext: undefined,
        importedFrom: IMPORTED_FROM,
        remoteEntries: makeEntries([
          makeRemote({ addressesComment: undefined }),
        ]),
      })
    ).toBeUndefined();
  });

  it("returns undefined for a plain local session (neither carrier)", () => {
    expect(
      resolveAddressingComment({
        taskContext: undefined,
        importedFrom: undefined,
        remoteEntries: makeEntries([makeRemote()]),
      })
    ).toBeUndefined();
  });
});
