import { resolveSessionDisplayMetadata } from "@src/util/session/sessionDisplayMetadata";

import { KANBAN_AGENT_TYPE_FILTER } from "../../config";
import { resolveKanbanAgentFilter } from "./kanbanAgentFilter";

describe("resolveKanbanAgentFilter", () => {
  it("keeps imported app provenance ahead of its underlying CLI type", () => {
    const display = resolveSessionDisplayMetadata({
      kind: "local",
      session: {
        session_id: "imported-codex-copy",
        importedFrom: {
          sourceSessionId: "remote-codex-source",
          externalHistorySource: "codex_app",
          sourceDisplay: {
            cliAgentType: "codex",
            agentDisplayName: "Codex App",
          },
        },
      },
    });

    expect(resolveKanbanAgentFilter(display)).toEqual({
      agentTypeFilter: KANBAN_AGENT_TYPE_FILTER.CODEX_APP,
      agentTypeFilterKind: "external",
      agentTypeFilterLabel: "Codex App",
    });
  });

  it("projects remote external rows through the same app filter", () => {
    const display = resolveSessionDisplayMetadata({
      kind: "remote",
      session: {
        sourceSessionId: "remote-codex-source",
        cliAgentType: "codex",
        agentDisplayName: "Codex App",
        origin: { kind: "external_history", source: "codex_app" },
      },
    });

    expect(resolveKanbanAgentFilter(display)).toEqual({
      agentTypeFilter: KANBAN_AGENT_TYPE_FILTER.CODEX_APP,
      agentTypeFilterKind: "external",
      agentTypeFilterLabel: "Codex App",
    });
  });

  it("uses the definition id for local and remote Rust agents", () => {
    const display = resolveSessionDisplayMetadata({
      kind: "remote",
      session: {
        sourceSessionId: "remote-rust-agent",
        agentDefinitionId: "builtin:sde",
        agentDisplayName: "SDE Agent",
        origin: { kind: "orgii" },
      },
    });

    expect(resolveKanbanAgentFilter(display, "builtin:sde")).toEqual({
      agentTypeFilter: KANBAN_AGENT_TYPE_FILTER.SDE_AGENT,
      agentTypeFilterKind: "rust",
      agentTypeFilterLabel: "SDE Agent",
    });
  });
});
