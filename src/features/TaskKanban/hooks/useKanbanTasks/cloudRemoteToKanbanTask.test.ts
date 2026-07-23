import { describe, expect, it } from "vitest";

import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";
import type { Session } from "@src/store/session";

import { buildCloudRemoteKanbanProjection } from "./cloudRemoteToKanbanTask";

const NOW = Date.parse("2026-07-22T12:00:00.000Z");

function remoteRow(
  overrides: Partial<RemoteTeammateSessionMetadata> = {}
): RemoteTeammateSessionMetadata {
  return {
    id: "org-1:remote-session-1",
    orgId: "org-1",
    ownerMemberId: "member-2",
    ownerUserId: "user-2",
    ownerDisplayName: "Teammate",
    ownerIdentityKind: "human",
    sourceSessionId: "remote-session-1",
    title: "Shared task",
    status: "completed",
    cliAgentType: "codex",
    agentDisplayName: "Codex App",
    model: "gpt-5.6",
    lastActivityAt: "2026-07-22T11:00:00.000Z",
    eventsEpoch: 1,
    eventsFrozenSeq: 0,
    eventsCount: 4,
    eventsTailHash: "tail",
    ...overrides,
  };
}

function localSession(overrides: Partial<Session> = {}): Session {
  return {
    session_id: "local-session-1",
    status: "completed",
    created_at: "2026-07-22T10:00:00.000Z",
    updated_at: "2026-07-22T11:00:00.000Z",
    ...overrides,
  };
}

const options = {
  orgId: "org-1",
  viewerUserId: "user-1",
  autoArchiveTtl: "24h" as const,
  nowMs: NOW,
};

describe("buildCloudRemoteKanbanProjection", () => {
  it("projects teammate rows with creator identity and replay behavior", () => {
    const result = buildCloudRemoteKanbanProjection([remoteRow()], [], options);

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({
      id: "cloud-remote:org-1:remote-session-1",
      status: "turn_finished",
      canMove: false,
      canOpen: true,
      cliAgentType: "codex",
      agentTypeFilter: "codex",
      agentTypeFilterKind: "cli",
      modelName: "gpt-5.6",
      createdBy: { id: "member-2", name: "Teammate" },
    });
    expect(result.remoteSessionsByTaskId.get(result.tasks[0].id)?.id).toBe(
      "org-1:remote-session-1"
    );
  });

  it("keeps metadata-only teammate rows visible but non-interactive", () => {
    const result = buildCloudRemoteKanbanProjection(
      [remoteRow({ eventsEpoch: undefined })],
      [],
      options
    );

    expect(result.tasks[0]?.canOpen).toBe(false);
  });

  it("uses the same stale-session archive policy as local tasks", () => {
    const result = buildCloudRemoteKanbanProjection(
      [remoteRow({ lastActivityAt: "2026-07-20T11:00:00.000Z" })],
      [],
      options
    );

    expect(result.tasks[0]).toMatchObject({
      status: "archived",
      resultStatus: "archived",
    });
  });

  it("uses the ORG2 mark for cloud-projected built-in Rust agents", () => {
    const result = buildCloudRemoteKanbanProjection(
      [
        remoteRow({
          cliAgentType: undefined,
          agentDefinitionId: "builtin:agent-architect",
          agentDisplayName: "Agent Architect",
        }),
      ],
      [],
      options
    );

    expect(result.tasks[0]?.agentIconId).toBe("orgii");
  });

  it("uses external source branding even when legacy metadata omits agent fields", () => {
    const result = buildCloudRemoteKanbanProjection(
      [
        remoteRow({
          sourceSessionId: "external-codex-session",
          cliAgentType: undefined,
          agentDisplayName: undefined,
          model: undefined,
          origin: { kind: "external_history", source: "codex_app" },
        }),
      ],
      [],
      options
    );

    expect(result.tasks[0]).toMatchObject({
      agentLabel: "Codex App",
      agentIconId: "codex",
      agentTypeFilter: "codex_app",
      agentTypeFilterKind: "external",
    });
  });

  it("deduplicates the viewer's own local source session", () => {
    const result = buildCloudRemoteKanbanProjection(
      [
        remoteRow({
          ownerMemberId: "member-1",
          ownerUserId: "user-1",
          sourceSessionId: "local-session-1",
        }),
      ],
      [localSession()],
      options
    );

    expect(result.tasks).toEqual([]);
  });

  it("does not hide a teammate row on a source-id collision", () => {
    const result = buildCloudRemoteKanbanProjection(
      [remoteRow({ sourceSessionId: "local-session-1" })],
      [localSession()],
      options
    );

    expect(result.tasks).toHaveLength(1);
  });

  it("deduplicates a locally imported replay copy", () => {
    const result = buildCloudRemoteKanbanProjection(
      [remoteRow()],
      [
        localSession({
          importedFrom: {
            orgId: "org-1",
            sourceSessionId: "remote-session-1",
            ownerMemberId: "member-2",
            epoch: 1,
            seq: 0,
            count: 4,
          },
        }),
      ],
      options
    );

    expect(result.tasks).toEqual([]);
  });
});
