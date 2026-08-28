/**
 * Session Creator — shared config
 *
 * Types and config arrays shared between SessionCreator (features/)
 * and ChatPanel (engines/). Moved from features/SessionCreator/config.ts
 * to break the cross-feature dependency.
 */
import {
  Infinity01Icon,
  CloudIcon,
  FolderKanbanIcon,
  LaptopIcon,
  ListTodoIcon,
  Search01Icon,
  SplitIcon,
} from "@src/icons";

// ============================================
// Session Configuration
// ============================================

export const SESSION_CONFIG = {
  MAX_SESSION_NAME_LENGTH: 50,
  DEFAULT_SESSION_NAME: "New Session",
  MAX_REPOS: 3,
  INPUT_WIDTH: 550,
  BASE_FONT_SIZE: 20,
  MIN_FONT_SIZE: 14,
  MAX_FONT_SIZE: 20,
  MIN_UNDERLINE_WIDTH: 140,
  MAX_UNDERLINE_WIDTH: 570,
  EDITOR_MAX_WIDTH: 650,
  EDITOR_MIN_HEIGHT: 100,
} as const;

// ============================================
// Agent exec mode (Rust `AgentExecMode`)
// ============================================
//
// User-selectable picker shows the three entries in `AGENT_EXEC_MODES`:
//   build / plan / ask.
// `debug`, `review`, and `wingman` remain valid wire values but are hidden
// from the picker (`debug` was removed from the UI on 2026-06-02; `review`
// drives background work-item review flows; `wingman` is the passive
// observer mode). Legacy `explore` values in localStorage are migrated to
// `ask` at load time (see `creatorDefaultExecModeAtom`).

export type AgentExecMode =
  | "build"
  | "ask"
  | "plan"
  | "debug"
  | "review"
  | "wingman";

export const DEFAULT_AGENT_EXEC_MODE: AgentExecMode = "build";

/**
 * Every valid `AgentExecMode` wire value the Rust backend can emit.
 *
 * Use this — NOT `AGENT_EXEC_MODES.map(m => m.id)` — when validating an
 * incoming exec mode from Rust (WS events, session records, persisted
 * settings). `AGENT_EXEC_MODES` is the *picker* list (build/ask/plan only).
 * The full union also includes `review` (internal flows)
 * and `wingman` (passive-observer mode). Validating against the picker
 * list silently coerced wingman/review sessions to `"build"`, which
 * re-enabled write tools on a read-only / passive session — the exact
 * footgun the Rust `AgentExecMode::parse` comment warns about.
 */
export const ALL_AGENT_EXEC_MODES: ReadonlySet<AgentExecMode> =
  new Set<AgentExecMode>([
    "build",
    "ask",
    "plan",
    "debug",
    "review",
    "wingman",
  ]);

export function normalizeAgentExecMode(value: unknown): AgentExecMode | null {
  return typeof value === "string" &&
    (ALL_AGENT_EXEC_MODES as ReadonlySet<string>).has(value)
    ? (value as AgentExecMode)
    : null;
}

/**
 * Resolve the execution mode of an existing session.
 *
 * Creator defaults are intentionally excluded: changing the mode for the next
 * new session must never mutate the behavior of a session that already exists.
 * Historical rows without a mode, and unknown values from older builds, use
 * the safe canonical runtime default instead.
 */
export function resolveSessionAgentExecMode(value: unknown): AgentExecMode {
  return normalizeAgentExecMode(value) ?? DEFAULT_AGENT_EXEC_MODE;
}

export function isAgentExecMode(value: unknown): value is AgentExecMode {
  return normalizeAgentExecMode(value) === value;
}

export interface AgentExecModeEntry {
  id: AgentExecMode;
  icon: typeof Infinity01Icon;
  i18nKey: string;
  name: string;
  description: string;
}

export const AGENT_EXEC_MODES: AgentExecModeEntry[] = [
  {
    id: "build",
    icon: Infinity01Icon,
    i18nKey: "planner.modes.build",
    name: "Build",
    description: "Full tool access — read, write, execute",
  },
  {
    id: "plan",
    icon: ListTodoIcon,
    i18nKey: "planner.modes.plan",
    name: "Plan",
    description: "Draft a plan file for user review — no direct edits",
  },
  {
    id: "ask",
    icon: Search01Icon,
    i18nKey: "planner.modes.ask",
    name: "Ask",
    description: "Read-only research — search + read + ask",
  },
];

export function getAgentExecModeEntry(id: string): AgentExecModeEntry {
  return AGENT_EXEC_MODES.find((mode) => mode.id === id) ?? AGENT_EXEC_MODES[0];
}

// ============================================
// Composer modes (product-mode axis, orgtrack/v1 §5.2)
// ============================================

/**
 * The one user-visible mode selector writes the PRODUCT mode
 * (`build | plan | ask | project`); the runtime exec mode is derived
 * (identity for build/plan/ask, `project → build`). `project` is NOT an
 * `AgentExecMode` — it never reaches the exec-mode wire enum; it flips
 * the persistent `session.productMode` axis that gates the
 * WorkItem/Routine mutation surface.
 */
export const PRODUCT_MODE_PROJECT = "project" as const;

export interface ComposerModeEntry {
  id: AgentExecMode | typeof PRODUCT_MODE_PROJECT;
  icon: typeof Infinity01Icon;
  i18nKey: string;
  name: string;
  description: string;
}

/** Picker list for the composer ModePill: exec modes + Project. */
export const COMPOSER_MODES: ComposerModeEntry[] = [
  ...AGENT_EXEC_MODES,
  {
    id: PRODUCT_MODE_PROJECT,
    icon: FolderKanbanIcon,
    i18nKey: "planner.modes.project",
    name: "Project",
    description:
      "Build with the PM CLI and persistent Work Items/Routines enabled",
  },
];

/** Runtime exec mode a composer selection maps to (§5.2 default map). */
export function execModeForComposerSelection(
  id: ComposerModeEntry["id"]
): AgentExecMode {
  return id === PRODUCT_MODE_PROJECT ? "build" : id;
}

// ============================================
// Running location
// ============================================

export type RunningLocation = "local" | "worktree" | "cloud";

export const DEFAULT_RUNNING_LOCATION: RunningLocation = "local";

export interface RunningLocationEntry {
  id: RunningLocation;
  icon: typeof LaptopIcon;
  iconClassName?: string;
  i18nKey: string;
  name: string;
  description: string;
  disabled?: boolean;
}

export const RUNNING_LOCATIONS: RunningLocationEntry[] = [
  {
    id: "local",
    icon: LaptopIcon,
    i18nKey: "planner.runningLocation.local",
    name: "This Mac",
    description: "Run on this device",
  },
  {
    id: "worktree",
    icon: SplitIcon,
    iconClassName: "rotate-90",
    i18nKey: "planner.runningLocation.worktree",
    name: "New Worktree",
    description: "Run in a new git worktree",
  },
  {
    id: "cloud",
    icon: CloudIcon,
    i18nKey: "planner.runningLocation.cloud",
    name: "Cloud",
    description: "Run in the cloud",
    disabled: true,
  },
];
