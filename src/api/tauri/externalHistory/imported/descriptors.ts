import type { ImportedHistorySourceId } from "@src/types/session/externalHistory";

export type { ImportedHistorySourceId } from "@src/types/session/externalHistory";

/**
 * Which client produced an imported session, parsed by the backend from the
 * source's own self-identification (Codex `originator`, Claude `entrypoint`).
 * Absent on sources that record no provenance — the UI renders no badge then
 * rather than guessing.
 *
 * `org2` is deliberately unlabeled in the UI: inside ORGII, "ORGII drove this"
 * is the unmarked default, not a distinction worth a badge.
 */
export const IMPORTED_CLIENT_ORIGINS = [
  "official_app",
  "cli",
  "third_party",
  "org2",
] as const;

export type ImportedClientOrigin = (typeof IMPORTED_CLIENT_ORIGINS)[number];

export type ImportedHistoryListCategory =
  `external_history:${ImportedHistorySourceId}`;

/**
 * Native-CLI continuation capability of an imported source. Present only
 * when `orgtrack_core::sources::cli_resume` can plan a resume for the
 * source (the backend stays authoritative per session — subagent rows and
 * malformed ids still resolve to no plan). Sources without it are pure
 * read-only replays: no continue button and no chat composer.
 */
export interface ImportedHistoryCliResume {
  /** `code_sessions.cli_agent_type` of the owning CLI (launch-profile key). */
  agentType: string;
  /** Fallback label when the CLI registry has not answered (or errored). */
  displayName: string;
}

/**
 * Native-app deep-link capability of an imported source. Present only when
 * `orgtrack_core::sources::app_open` can address a single conversation in
 * the vendor's own app (the backend stays authoritative per session —
 * subagent rows and malformed ids still resolve to no plan). Independent of
 * {@link ImportedHistoryCliResume}: a source can be CLI-resumable without
 * having an app link, and the reverse is possible too.
 */
export interface ImportedHistoryAppOpen {
  /** Fallback label before the backend plan answers (or if it errors). */
  displayName: string;
  /** Destination app brand, which can differ from the importing CLI's icon. */
  iconId: string;
}

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
  cliResume?: ImportedHistoryCliResume;
  appOpen?: ImportedHistoryAppOpen;
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
      supportsWindowedReplay: true,
      cliResume: {
        agentType: "cursor_cli",
        displayName: "Cursor CLI",
      },
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
      supportsWindowedReplay: true,
      cliResume: {
        agentType: "codex",
        displayName: "Codex",
      },
      appOpen: {
        displayName: "Codex",
        iconId: "codex",
      },
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
      supportsWindowedReplay: true,
      cliResume: {
        agentType: "claude_code",
        displayName: "Claude Code",
      },
      appOpen: {
        displayName: "Claude",
        iconId: "claude",
      },
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
      supportsWindowedReplay: true,
      cliResume: {
        agentType: "opencode",
        displayName: "OpenCode",
      },
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
      supportsWindowedReplay: true,
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
      supportsWindowedReplay: true,
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
      supportsWindowedReplay: true,
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
      supportsWindowedReplay: true,
      cliResume: {
        agentType: "cline",
        displayName: "Cline",
      },
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
      supportsWindowedReplay: true,
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
      supportsWindowedReplay: true,
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
      supportsWindowedReplay: true,
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
      supportsWindowedReplay: true,
      cliResume: {
        agentType: "mimo_code",
        displayName: "MiMo Code",
      },
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
      supportsWindowedReplay: true,
      cliResume: {
        agentType: "omp",
        displayName: "OMP",
      },
    },
    {
      sourceId: "pi",
      listCategory: "external_history:pi",
      prefix: "piapp-",
      iconId: "pi",
      displayName: "Pi",
      groupLabel: "Pi",
      listable: true,
      replayable: true,
      supportsWindowedReplay: true,
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
      supportsWindowedReplay: true,
    },
    {
      sourceId: "qwen_code",
      listCategory: "external_history:qwen_code",
      prefix: "qwencodeapp-",
      iconId: "qwen_code",
      displayName: "Qwen Code",
      groupLabel: "Qwen Code",
      listable: true,
      replayable: true,
      supportsWindowedReplay: true,
    },
    {
      sourceId: "kimi",
      listCategory: "external_history:kimi",
      prefix: "kimihistoryapp-",
      iconId: "kimi",
      displayName: "Kimi",
      groupLabel: "Kimi",
      listable: true,
      replayable: true,
      supportsWindowedReplay: true,
      cliResume: {
        agentType: "kimi_cli",
        displayName: "Kimi",
      },
    },
    {
      sourceId: "copilot",
      listCategory: "external_history:copilot",
      prefix: "copilotapp-",
      iconId: "copilot",
      displayName: "Copilot CLI",
      groupLabel: "Copilot CLI",
      listable: true,
      replayable: true,
      supportsWindowedReplay: true,
      cliResume: {
        agentType: "copilot",
        displayName: "Copilot CLI",
      },
    },
  ];
