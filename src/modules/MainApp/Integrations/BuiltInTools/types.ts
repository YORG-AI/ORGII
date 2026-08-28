export type ToolSource = "builtin" | "mcp";

export type AgentKind = "os" | "sde" | "custom";

/** Simulator app types matching Rust `SimulatorApp` enum. */
export type SimulatorAppType =
  | "CODE_EDITOR"
  | "BROWSER"
  | "CHANNELS"
  | "STORY_MANAGER";

/** Workstation panel key matching Rust `HumanToolKey` enum. */
export type HumanToolKeyType =
  | "codeEditor"
  | "terminal"
  | "browser"
  | "sessions"
  | "projectManager"
  | "app";

const SIMULATOR_APP_VALUES: readonly SimulatorAppType[] = [
  "CODE_EDITOR",
  "BROWSER",
  "CHANNELS",
  "STORY_MANAGER",
];

const HUMAN_TOOL_KEY_VALUES: readonly HumanToolKeyType[] = [
  "codeEditor",
  "terminal",
  "browser",
  "sessions",
  "projectManager",
  "app",
];

/** Default when backend omits `simulatorApp` (custom tools). */
export const DEFAULT_SIMULATOR_APP: SimulatorAppType = "CHANNELS";

export function parseSimulatorApp(value: unknown): SimulatorAppType | null {
  if (typeof value !== "string") return null;
  return SIMULATOR_APP_VALUES.includes(value as SimulatorAppType)
    ? (value as SimulatorAppType)
    : null;
}

export function parseHumanToolKey(value: unknown): HumanToolKeyType | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return null;
  return HUMAN_TOOL_KEY_VALUES.includes(value as HumanToolKeyType)
    ? (value as HumanToolKeyType)
    : null;
}

/** Structured action/subcommand from the runtime Tool::actions() method. */
export interface ToolActionEntry {
  name: string;
  summary: string;
  layout?: string[];
}

export interface RawToolInfo {
  name: string;
  description: string;
  /** Longer copy for Integrations preview; built-in tools only. */
  description_detail?: string | null;
  /** Icon id (kebab-case, lucide-era slugs); from Rust `ToolInfo.icon_id`. */
  icon_id?: string | null;
  category: string;
  source: string;
  supported_agents: AgentKind[];
  /** Which simulator app this tool's events route to. */
  simulatorApp?: SimulatorAppType;
  /** Workstation panel key (codeEditor, terminal, browser, etc.). */
  humanToolKey?: HumanToolKeyType | null;
  /** If true, this tool is internal plumbing. */
  hidden?: boolean;
  /** Required capability bucket from Rust `RequiredCapability`. */
  requiredCapability?: string;
  /** Structured actions from runtime. Empty if no session is active. */
  actions?: ToolActionEntry[];
}

export interface ToolRow {
  name: string;
  description: string;
  /** Richer description for the detail preview (built-in tools). */
  descriptionDetail: string | null;
  /** Icon id from backend; Integrations uses this with `toolIcons`. */
  iconId: string | null;
  category: string;
  source: ToolSource;
  /** Internal plumbing tools are visible but read-only in the global list. */
  internal: boolean;
  supportedAgents: AgentKind[];
  /** Which simulator app this tool's events route to (from Rust). */
  simulatorApp: SimulatorAppType;
  /** Workstation panel key (codeEditor, terminal, browser, etc.). Null if no panel. */
  humanToolKey: HumanToolKeyType | null;
  /** Structured actions from runtime Tool::actions(). Empty when not populated. */
  actions: ToolActionEntry[];
}
