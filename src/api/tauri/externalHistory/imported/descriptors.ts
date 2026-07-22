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
    },
    {
      sourceId: "mimo_code",
      listCategory: "external_history:mimo_code",
      prefix: "mimocodeapp-",
      iconId: "mimo_code",
      displayName: "Mimo Code",
      groupLabel: "Mimo Code",
      listable: true,
      replayable: true,
    },
    {
      sourceId: "omp",
      listCategory: "external_history:omp",
      prefix: "ompapp-",
      iconId: "omp",
      displayName: "OMP",
      groupLabel: "OMP",
      listable: true,
      replayable: true,
    },
    {
      sourceId: "qoder_cli",
      listCategory: "external_history:qoder_cli",
      prefix: "qodercliapp-",
      iconId: "qoder",
      displayName: "Qoder CLI",
      groupLabel: "Qoder CLI",
      listable: true,
      replayable: true,
    },
  ];
