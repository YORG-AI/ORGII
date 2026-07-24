import {
  STORY_SYNC_ADAPTER,
  type SyncConnection,
} from "@src/api/http/integrations";
import {
  type ExternalSkillsetsTab,
  extensionKindForSkillsetTab,
} from "@src/config/mainAppPaths";

import { CHANNEL_TYPES } from "./Connections/Channels/config";
import {
  type ChannelInstance,
  STATUS_DOT_COLOR,
} from "./Connections/Channels/types";
import type { DrillDownItem } from "./shared/DrillDownListPanel";
import type { IntegrationCategory } from "./types";

export interface BuildDrillDownItemsInput {
  category: IntegrationCategory;
  externalSkillsetsTab?: ExternalSkillsetsTab;
  databases:
    | readonly {
        id: string;
        name: string;
        connectionStatus: string;
      }[]
    | null
    | undefined;
  mcpServers: readonly { name: string; status: string }[];
  markdownRules: readonly { source: string; name: string; enabled: boolean }[];
  routines: readonly { id: string; name: string; enabled: boolean }[];
  projectConnections: readonly SyncConnection[];
  groupedChannels: ReadonlyMap<string, readonly ChannelInstance[]>;
}

export function buildIntegrationsDrillDownItems(
  input: BuildDrillDownItemsInput
): DrillDownItem[] {
  switch (input.category) {
    case "databases":
      return (input.databases ?? []).map((db) => ({
        id: db.id,
        name: db.name,
        statusDot:
          db.connectionStatus === "connected"
            ? "bg-success-6"
            : db.connectionStatus === "error"
              ? "bg-danger-6"
              : "bg-text-4",
      }));
    case "tools":
    case "computerUse":
    case "myRoles":
    case "sessionMemoryEmbedding":
      return [];
    case "externalSkillsets": {
      const kind = extensionKindForSkillsetTab(
        input.externalSkillsetsTab ?? "skills"
      );
      if (kind !== "mcp") return [];
      return input.mcpServers.map((srv) => ({
        id: srv.name,
        name: srv.name,
        statusDot:
          srv.status === "connected"
            ? "bg-success-6"
            : srv.status === "error"
              ? "bg-danger-6"
              : "bg-text-4",
      }));
    }
    case "rulesMemoryEvolution": {
      return input.markdownRules.map((rule) => ({
        id: `${rule.source}:${rule.name}`,
        name: rule.name,
        statusDot: rule.enabled ? "bg-success-6" : "bg-text-4",
      }));
    }
    case "routines": {
      return input.routines.map((routine) => ({
        id: routine.id,
        name: routine.name,
        statusDot: routine.enabled ? "bg-success-6" : "bg-text-4",
      }));
    }
    case "git":
      return input.projectConnections
        .filter(
          (connection) => connection.adapter_id === STORY_SYNC_ADAPTER.GITHUB
        )
        .map((connection) => ({
          id: connection.id,
          name: connection.label,
          statusDot: "bg-success-6",
        }));
    case "connections": {
      const items: DrillDownItem[] = [];
      for (const chType of CHANNEL_TYPES) {
        const instances = input.groupedChannels.get(chType.type);
        if (!instances) continue;
        for (const inst of instances) {
          items.push({
            id: `${inst.type}:${inst.accountId}`,
            name: inst.accountId,
            statusDot: STATUS_DOT_COLOR[inst.connectionStatus] ?? "bg-fill-3",
          });
        }
      }
      return items;
    }
    default:
      return [];
  }
}

export interface DrillDownSelectedIdInput {
  category: IntegrationCategory;
  externalSkillsetsTab?: ExternalSkillsetsTab;
  selectedDatabaseId: string | null | undefined;
  extensionSelectedId: string | null;
  selectedMarkdownRule: { source: string; name: string } | null | undefined;
  selectedRoutineId: string | null | undefined;
  selectedIntegrationKind: "git" | "channel" | null;
  selectedGitProvider: string | null;
  selectedChannel: { type: string; accountId: string } | null | undefined;
}

export function getIntegrationsDrillDownSelectedId(
  input: DrillDownSelectedIdInput
): string | null {
  switch (input.category) {
    case "databases":
      return input.selectedDatabaseId ?? null;
    case "tools":
    case "computerUse":
    case "myRoles":
    case "sessionMemoryEmbedding":
      return null;
    case "externalSkillsets": {
      const kind = extensionKindForSkillsetTab(
        input.externalSkillsetsTab ?? "skills"
      );
      if (kind !== "mcp") return null;
      return input.extensionSelectedId;
    }
    case "rulesMemoryEvolution": {
      const md = input.selectedMarkdownRule;
      if (md) return `${md.source}:${md.name}`;
      return null;
    }
    case "routines":
      return input.selectedRoutineId ?? null;
    case "git":
      return input.selectedGitProvider;
    case "connections": {
      const ch = input.selectedChannel;
      if (ch) return `${ch.type}:${ch.accountId}`;
      return null;
    }
    default:
      return null;
  }
}

export interface DrillDownLoadingInput {
  category: IntegrationCategory;
  externalSkillsetsTab?: ExternalSkillsetsTab;
  databasesLoading: boolean;
  mcpLoading: boolean;
  skillsInstalledLoading: boolean;
  policiesMarkdownLoading: boolean;
  routinesLoading: boolean;
  channelStateLoaded: boolean;
}

export function getIntegrationsDrillDownLoading(
  input: DrillDownLoadingInput
): boolean {
  switch (input.category) {
    case "databases":
      return input.databasesLoading;
    case "tools":
    case "computerUse":
    case "myRoles":
    case "sessionMemoryEmbedding":
      return false;
    case "externalSkillsets": {
      const kind = extensionKindForSkillsetTab(
        input.externalSkillsetsTab ?? "skills"
      );
      if (kind === "mcp") return input.mcpLoading;
      return input.skillsInstalledLoading;
    }
    case "rulesMemoryEvolution":
      return input.policiesMarkdownLoading;
    case "routines":
      return input.routinesLoading;
    case "connections":
      return !input.channelStateLoaded;
    default:
      return false;
  }
}

export function getIntegrationsDrillDownTitle(
  category: IntegrationCategory,
  translateCategory: (key: string) => string,
  externalSkillsetsTab?: ExternalSkillsetsTab
): string {
  if (category === "externalSkillsets") {
    const kind = extensionKindForSkillsetTab(externalSkillsetsTab ?? "skills");
    if (kind === "mcp") return "MCP";
    return translateCategory(`categories.${kind}`);
  }
  return translateCategory(`categories.${category}`);
}
