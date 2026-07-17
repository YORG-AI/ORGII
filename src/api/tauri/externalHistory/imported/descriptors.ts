import type { ImportedHistorySourceId } from "@src/types/session/externalHistory";

export type { ImportedHistorySourceId } from "@src/types/session/externalHistory";

export type ImportedHistoryListCategory =
  `external_history:${ImportedHistorySourceId}`;

export interface ImportedHistorySourceDescriptor {
  sourceId: ImportedHistorySourceId;
  listCategory: ImportedHistoryListCategory;
  prefix: string;
  iconId: string;
  displayName: string;
  groupLabel: string;
  listable: true;
  replayable: true;
  supportsWindowedReplay: boolean;
}

export const IMPORTED_HISTORY_SOURCE_DESCRIPTORS: readonly ImportedHistorySourceDescriptor[] =
  [
    {
      sourceId: "cursor_ide",
      listCategory: "external_history:cursor_ide",
      prefix: "cursoride-",
      iconId: "cursor",
      displayName: "Cursor App",
      groupLabel: "Cursor App",
      listable: true,
      replayable: true,
      supportsWindowedReplay: true,
    },
    {
      sourceId: "cursor_cli",
      listCategory: "external_history:cursor_cli",
      prefix: "cursorcliapp-",
      iconId: "cursor",
      displayName: "Cursor CLI",
      groupLabel: "Cursor CLI",
      listable: true,
      replayable: true,
      supportsWindowedReplay: false,
    },
    {
      sourceId: "codex_app",
      listCategory: "external_history:codex_app",
      prefix: "codexapp-",
      iconId: "codex",
      displayName: "Codex App",
      groupLabel: "Codex App",
      listable: true,
      replayable: true,
      supportsWindowedReplay: false,
    },
    {
      sourceId: "claude_code",
      listCategory: "external_history:claude_code",
      prefix: "claudecodeapp-",
      iconId: "claude_code",
      displayName: "Claude App",
      groupLabel: "Claude App",
      listable: true,
      replayable: true,
      supportsWindowedReplay: false,
    },
    {
      sourceId: "opencode",
      listCategory: "external_history:opencode",
      prefix: "opencodeapp-",
      iconId: "opencode",
      displayName: "OpenCode",
      groupLabel: "OpenCode",
      listable: true,
      replayable: true,
      supportsWindowedReplay: false,
    },
    {
      sourceId: "windsurf",
      listCategory: "external_history:windsurf",
      prefix: "windsurfapp-",
      iconId: "windsurf",
      displayName: "Windsurf",
      groupLabel: "Windsurf",
      listable: true,
      replayable: true,
      supportsWindowedReplay: false,
    },
    {
      sourceId: "workbuddy",
      listCategory: "external_history:workbuddy",
      prefix: "workbuddyapp-",
      iconId: "workbuddy",
      displayName: "WorkBuddy",
      groupLabel: "WorkBuddy",
      listable: true,
      replayable: true,
      supportsWindowedReplay: false,
    },
    {
      sourceId: "trae",
      listCategory: "external_history:trae",
      prefix: "traeapp-",
      iconId: "trae",
      displayName: "Trae",
      groupLabel: "Trae",
      listable: true,
      replayable: true,
      supportsWindowedReplay: false,
    },
    {
      sourceId: "cline",
      listCategory: "external_history:cline",
      prefix: "clineapp-",
      iconId: "cline",
      displayName: "Cline",
      groupLabel: "Cline",
      listable: true,
      replayable: true,
      supportsWindowedReplay: false,
    },
    {
      sourceId: "warp",
      listCategory: "external_history:warp",
      prefix: "warpapp-",
      iconId: "warp",
      displayName: "Warp",
      groupLabel: "Warp",
      listable: true,
      replayable: true,
      supportsWindowedReplay: false,
    },
    {
      sourceId: "zcode",
      listCategory: "external_history:zcode",
      prefix: "zcodeapp-",
      iconId: "zcode",
      displayName: "ZCode",
      groupLabel: "ZCode",
      listable: true,
      replayable: true,
      supportsWindowedReplay: false,
    },
    {
      sourceId: "qoder",
      listCategory: "external_history:qoder",
      prefix: "qoderapp-",
      iconId: "qoder",
      displayName: "Qoder",
      groupLabel: "Qoder",
      listable: true,
      replayable: true,
      supportsWindowedReplay: false,
    },
  ];
