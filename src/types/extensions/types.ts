/** Stats block from a remote skill directory detail response. */
export interface HubSkillStats {
  comments: number;
  downloads: number;
  installsAllTime: number;
  installsCurrent: number;
  stars: number;
  versions: number;
}

/** Owner info from a remote skill directory detail response. */
export interface HubSkillOwner {
  handle: string;
  displayName?: string;
  image?: string;
}

/** Full skill detail from the skills.sh directory/download API. */
export interface HubSkillDetail {
  slug: string;
  name: string;
  description: string;
  version: string;
  stats?: HubSkillStats;
  owner?: HubSkillOwner;
  createdAt?: number;
  updatedAt?: number;
  changelog?: string;
  skillMd?: string;
  source?: string;
  skillId?: string;
  installs?: number;
  snapshotHash?: string;
}

/** Search result from the remote skills directory. */
export interface HubSkillResult {
  slug: string;
  name: string;
  description: string;
  updatedAt?: number;
  source?: string;
  skillId?: string;
  installs?: number;
}

/** Result of installing a skill from the remote skills directory. */
export interface HubInstallResult {
  name: string;
  path: string;
}

/** Info about a skill with an available update from the remote skills directory. */
export interface SkillUpdateInfo {
  name: string;
  slug: string;
  installedVersion: string;
  latestVersion: string;
  changelog?: string;
}

/** Quality rating for a skill's description.
 *
 * Mirrors Rust `DescriptionQuality` in
 * `src-tauri/src/agent_core/intelligence/skills/loader/types.rs`. */
export const DESCRIPTION_QUALITY = {
  GOOD: "good",
  SHORT: "short",
  MISSING: "missing",
} as const;
export type DescriptionQuality =
  (typeof DESCRIPTION_QUALITY)[keyof typeof DESCRIPTION_QUALITY];

/** Where a skill came from. Mirrors the Rust `&'static str` value
 * threaded through `SkillsLoader::scan_skills_dir` (`scanner.rs`).
 *
 * - `WORKSPACE`        — `<repo>/.orgii/skills/<name>/`
 * - `BUILTIN`          — `~/.orgii/skills/<name>/` (per-user, default)
 * - `EMBEDDED_BUILTIN` — binary-embedded skills that ship with ORGII
 * - `EXTERNAL_SOURCE`  — auto-scanned repo/user `.<tool>/skills` and root `skills` directories
 * - `AGENT_SOURCE`     — agent definition read-only skill source dirs
 * - `SKILLS_SH`        — skills installed from skills.sh snapshots
 * - `GITHUB`           — skills installed from GitHub-backed directory entries */
export const SKILL_SOURCE = {
  WORKSPACE: "workspace",
  BUILTIN: "builtin",
  EMBEDDED_BUILTIN: "embedded_builtin",
  EXTERNAL_SOURCE: "external-source",
  AGENT_SOURCE: "agent-source",
  SKILLS_SH: "skills_sh",
  GITHUB: "github",
} as const;
export type SkillSource = (typeof SKILL_SOURCE)[keyof typeof SKILL_SOURCE];

/** Where a skill is saved when authored from the editor. */
export const SKILL_SCOPE = {
  GLOBAL: "global",
  WORKSPACE: "workspace",
} as const;
export type SkillScope = (typeof SKILL_SCOPE)[keyof typeof SKILL_SCOPE];

/** Default token budget for the skills section (must match Rust DEFAULT_SKILLS_TOKEN_BUDGET). */
export const SKILLS_TOKEN_BUDGET = 4000;

/** A locally installed skill (from skills_list Tauri command). */
export interface InstalledSkill {
  name: string;
  path: string;
  source: string;
  always: boolean;
  /** Whether all required binaries/env vars are present. */
  available: boolean;
  /** Whether the user has this skill enabled (not in disabledSkills). */
  enabled: boolean;
  requiredBins: string[];
  requiredEnv: string[];
  description: string;
  /** Estimated token cost in the system prompt. */
  estimatedTokens: number;
  /** Estimated tokens for the full SKILL.md content. */
  fullContentTokens: number;
  /** Quality of the description for agent discovery. */
  descriptionQuality: DescriptionQuality;
  /** Skill version from frontmatter (empty if not specified). */
  version: string;
  /** License from frontmatter (empty if not specified). */
  license: string;
  /** Compatibility notes from frontmatter (empty if not specified). */
  compatibility: string;
  /** Which required binaries are not found on PATH. */
  missingBins: string[];
  /** Which required env vars are not set. */
  missingEnv: string[];
  /** Relative paths of bundled files (scripts, references, assets). */
  bundledFiles: string[];
}

/** Category for a unified slash menu item. */
export type SlashItemCategory = "skill" | "action" | "tool";

/** Unified slash menu item shown in the `/` dropdown. */
export interface SlashItem {
  name: string;
  description: string;
  category: SlashItemCategory;
  source: string;
  acceptsArgs: boolean;
  /** Actual slash command inserted into the composer, e.g. `/session new`. */
  command?: string;
  /** Stable action identifier for dispatching built-in slash actions. */
  actionId?: string;
  /** For tool items: the MCP server name this tool belongs to. */
  serverName?: string;
  /**
   * For skill items: the skill's name as known to the backend (used as
   * the slash-command token, e.g. `/statusline`). Distinct from `name`
   * which is the human-readable display label.
   */
  skillName?: string;
  /** Absolute path to the skill directory when available. */
  skillPath?: string;
  /** Slash-menu grouping for skill rows. */
  skillScope?: "workspace" | "user";
}

/** Built-in slash action names. */
export const SLASH_ACTIONS = {
  SUMMARIZE: "Summarize",
  SETUP_REPO: "Setup Repo",
  PROJECT_NEW: "Project New",
  PROJECT_LIST: "Project List",
  PROJECT_LINK_REPO: "Project Link Repo",
  PROJECT_OPEN: "Project Open",
  WI_NEW: "WI New",
  WI_LIST: "WI List",
  WI_LINK_PROJECT: "WI Link Project",
  WI_START_SESSION: "WI Start Session",
  SESSION_NEW: "Session New",
  SESSION_LIST: "Session List",
  SESSION_LINK_WI: "Session Link WI",
  SESSION_MERGE: "Session Merge",
  SESSION_CANCEL: "Session Cancel",
  MODEL_SWITCH: "Model Switch",
} as const;

/** Canonical built-in slash action registry shared by the inline `/` menu and pinned actions. */
export const BUILTIN_SLASH_ACTION_ITEMS: SlashItem[] = [
  // # 仓库上下文指令：用于重置/刷新当前窗口的 repo 识别与聊天上下文。
  {
    name: SLASH_ACTIONS.SETUP_REPO,
    command: "/setup repo",
    actionId: "setup.repo",
    description: "重置当前仓库识别与聊天上下文",
    category: "action",
    source: "builtin",
    acceptsArgs: false,
  },

  // # 项目指令：用于创建、查看、打开项目，以及把项目绑定到当前代码仓库。
  {
    name: SLASH_ACTIONS.PROJECT_NEW,
    command: "/project new",
    actionId: "project.new",
    description: "创建用于归纳相关工作的项目容器",
    category: "action",
    source: "builtin",
    acceptsArgs: true,
  },
  {
    name: SLASH_ACTIONS.PROJECT_LIST,
    command: "/project list",
    actionId: "project.list",
    description: "查看已有项目列表",
    category: "action",
    source: "builtin",
    acceptsArgs: false,
  },
  {
    name: SLASH_ACTIONS.PROJECT_LINK_REPO,
    command: "/project link-repo",
    actionId: "project.linkRepo",
    description: "将项目关联到当前仓库/工作区",
    category: "action",
    source: "builtin",
    acceptsArgs: true,
  },
  {
    name: SLASH_ACTIONS.PROJECT_OPEN,
    command: "/project open",
    actionId: "project.open",
    description: "打开项目工作界面",
    category: "action",
    source: "builtin",
    acceptsArgs: true,
  },

  // # 任务指令：用于创建、查看任务，并把任务挂到项目或从任务启动执行会话。
  {
    name: SLASH_ACTIONS.WI_NEW,
    command: "/wi new",
    actionId: "wi.new",
    description: "创建可追踪的工作项/任务",
    category: "action",
    source: "builtin",
    acceptsArgs: true,
  },
  {
    name: SLASH_ACTIONS.WI_LIST,
    command: "/wi list",
    actionId: "wi.list",
    description: "查看工作项/任务列表",
    category: "action",
    source: "builtin",
    acceptsArgs: false,
  },
  {
    name: SLASH_ACTIONS.WI_LINK_PROJECT,
    command: "/wi link-project",
    actionId: "wi.linkProject",
    description: "将工作项挂到指定项目下",
    category: "action",
    source: "builtin",
    acceptsArgs: true,
  },
  {
    name: SLASH_ACTIONS.WI_START_SESSION,
    command: "/wi start-session",
    actionId: "wi.startSession",
    description: "从工作项启动 agent 会话",
    category: "action",
    source: "builtin",
    acceptsArgs: true,
  },

  // # 会话指令：用于新建、查看、关联、合并或取消实际执行代码任务的 agent session。
  {
    name: SLASH_ACTIONS.SESSION_NEW,
    command: "/session new",
    actionId: "session.new",
    description: "启动一个新的 agent 会话",
    category: "action",
    source: "builtin",
    acceptsArgs: true,
  },
  {
    name: SLASH_ACTIONS.SESSION_LIST,
    command: "/session list",
    actionId: "session.list",
    description: "查看 agent 会话列表",
    category: "action",
    source: "builtin",
    acceptsArgs: false,
  },
  {
    name: SLASH_ACTIONS.SESSION_LINK_WI,
    command: "/session link-wi",
    actionId: "session.linkWi",
    description: "将会话关联到工作项",
    category: "action",
    source: "builtin",
    acceptsArgs: true,
  },
  {
    name: SLASH_ACTIONS.SESSION_MERGE,
    command: "/session merge",
    actionId: "session.merge",
    description: "合并已完成会话的分支",
    category: "action",
    source: "builtin",
    acceptsArgs: true,
  },
  {
    name: SLASH_ACTIONS.SESSION_CANCEL,
    command: "/session cancel",
    actionId: "session.cancel",
    description: "取消正在执行的 agent 会话",
    category: "action",
    source: "builtin",
    acceptsArgs: true,
  },

  // # 模型指令：用于像 OpenClaw 一样通过 /model <模型名> 切换当前 session 的模型。
  {
    name: SLASH_ACTIONS.MODEL_SWITCH,
    command: "/model",
    actionId: "model.switch",
    description:
      "切换当前会话模型；不带参数时展示可选模型列表，支持别名/模糊匹配",
    category: "action",
    source: "builtin",
    acceptsArgs: true,
  },
];
