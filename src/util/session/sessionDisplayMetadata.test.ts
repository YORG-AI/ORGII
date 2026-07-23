import { resolveAgentIcon } from "@src/config/agentIcons";
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";
import type { Session } from "@src/store/session";
import { resolveSessionRowIcon } from "@src/util/session/sessionSidebarRow";

import {
  type LocalSessionDisplayInput,
  resolveSessionDisplayMetadata,
} from "./sessionDisplayMetadata";

describe("resolveSessionDisplayMetadata", () => {
  it("projects the same source identity from a cloud row and its imported replay", () => {
    const remote = {
      sourceSessionId: "1106510024",
      cliAgentType: "codex",
      agentDisplayName: "Codex App",
      model: "gpt-5.6-sol",
      origin: { kind: "external_history", source: "codex_app" },
    } as const satisfies Pick<
      RemoteTeammateSessionMetadata,
      | "sourceSessionId"
      | "cliAgentType"
      | "agentDisplayName"
      | "model"
      | "origin"
    >;
    const imported = {
      session_id: "imported-session-copy",
      status: "completed",
      created_at: "2026-07-23T00:00:00.000Z",
      updated_at: "2026-07-23T00:00:00.000Z",
      model: undefined,
      agentIconId: "archive",
      agentDisplayName: "Collaboration Snapshot",
      importedFrom: {
        orgId: "org-1",
        sourceSessionId: remote.sourceSessionId,
        ownerMemberId: "member-1",
        epoch: 1,
        seq: 0,
        count: 1,
        externalHistorySource: "codex_app",
        sourceDisplay: {
          cliAgentType: remote.cliAgentType,
          agentDisplayName: remote.agentDisplayName,
          model: remote.model,
        },
      },
    } satisfies Session;

    const remoteDisplay = resolveSessionDisplayMetadata({
      kind: "remote",
      session: remote,
    });
    const importedDisplay = resolveSessionDisplayMetadata({
      kind: "local",
      session: imported,
    });

    expect(importedDisplay).toEqual(remoteDisplay);
    expect(importedDisplay).toMatchObject({
      agentLabel: "Codex App",
      agentIconId: "codex",
      cliAgentType: "codex",
      modelName: "gpt-5.6-sol",
    });
    expect(imported.model).toBeUndefined();
  });

  it("recovers the app icon and label for legacy imports with provenance only", () => {
    const display = resolveSessionDisplayMetadata({
      kind: "local",
      session: {
        session_id: "imported-session-legacy",
        agentIconId: "archive",
        agentDisplayName: "Collaboration Snapshot",
        importedFrom: {
          orgId: "org-1",
          sourceSessionId: "legacy-source",
          ownerMemberId: "member-1",
          epoch: 1,
          seq: 0,
          count: 1,
          externalHistorySource: "codex_app",
        },
      },
    });

    expect(display).toMatchObject({
      agentLabel: "Codex App",
      agentIconId: "codex",
    });
    expect(display.modelName).toBeUndefined();
  });

  it("recognizes an imported external source from its original session id", () => {
    const display = resolveSessionDisplayMetadata({
      kind: "local",
      session: {
        session_id: "imported-session-deterministic-copy",
        agentIconId: "archive",
        importedFrom: {
          orgId: "org-1",
          sourceSessionId: "codexapp-original-session",
          ownerMemberId: "member-1",
          epoch: 1,
          seq: 0,
          count: 1,
        },
      },
    });

    expect(display).toMatchObject({
      agentLabel: "Codex App",
      agentIconId: "codex",
    });
  });

  it("uses the ORGII mark for built-in and native imported sessions", () => {
    expect(
      resolveSessionDisplayMetadata({
        kind: "local",
        session: {
          session_id: "sdeagent-1",
          agentDefinitionId: "builtin:sde",
          agentIconId: "code",
        },
      }).agentIconId
    ).toBe("orgii");

    expect(
      resolveSessionDisplayMetadata({
        kind: "local",
        session: {
          session_id: "imported-session-native",
          agentIconId: "archive",
          importedFrom: {
            orgId: "org-1",
            sourceSessionId: "source-1",
            ownerMemberId: "member-1",
            epoch: 1,
            seq: 0,
            count: 1,
          },
        },
      }).agentIconId
    ).toBe("orgii");
  });

  it("keeps legacy wire aliases displayable without accepting them as runnable CLI types", () => {
    const display = resolveSessionDisplayMetadata({
      kind: "remote",
      session: {
        sourceSessionId: "legacy-cloud-row",
        cliAgentType: "claude_code_cli",
        model: "claude-sonnet-5",
      },
    });

    expect(display).toMatchObject({
      agentLabel: "Claude Code CLI",
      agentIconId: "claude_code",
      agentType: "claude_code_cli",
      modelName: "claude-sonnet-5",
    });
    expect(display.cliAgentType).toBeUndefined();
  });

  it("drives the sidebar adapter from the same final icon used by Kanban", () => {
    const session = {
      session_id: "cliagent-org-coordinator",
      agentOrgId: "agent-team-1",
      cliAgentType: "opencode",
      agentIconId: "code",
    } satisfies LocalSessionDisplayInput;

    const display = resolveSessionDisplayMetadata({
      kind: "local",
      session,
    });

    expect(display.agentIconId).toBe("network");
    expect(resolveSessionRowIcon(session)).toBe(
      resolveAgentIcon(display.agentIconId)
    );
  });

  it("uses one native-cloud fallback across remote Kanban and sidebar", () => {
    const display = resolveSessionDisplayMetadata({
      kind: "remote",
      session: {
        sourceSessionId: "remote-native-session",
        agentDisplayName: "Agent Architect",
        origin: { kind: "orgii" },
      },
    });

    expect(display).toMatchObject({
      agentLabel: "Agent Architect",
      agentIconId: "orgii",
      isMonochromeBrandIcon: true,
    });
  });
});
