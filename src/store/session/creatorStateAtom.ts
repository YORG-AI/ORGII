/**
 * Session Creator State Atom
 *
 * Shared state for session creator page that the toolbar can access
 * for displaying and modifying session mode and location.
 *
 * Persists to localStorage so selections are remembered across sessions.
 */
import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";

import type { AgentRole } from "@src/api/http/project/types/agentWorkflow";
import type { CliAgentType } from "@src/api/tauri/rpc/schemas/validation";
import type { DispatchCategory } from "@src/api/tauri/session";
import { createLogger } from "@src/hooks/logger";
import { BUILTIN_SDE_DEF_ID } from "@src/util/session/sessionDispatch";

const log = createLogger("SessionCreatorState");

// ============================================
// Type Definitions
// ============================================

export const SESSION_TARGET_KIND = {
  AGENT: "agent",
  AGENT_ORG: "agent_org",
  CLI_AGENT: "cli_agent",
  HUMAN: "human",
} as const;

export type SessionTargetKind =
  (typeof SESSION_TARGET_KIND)[keyof typeof SESSION_TARGET_KIND];

export const CLI_LAUNCH_MODE = {
  GUI: "gui",
  TUI: "tui",
} as const;

export type CliLaunchMode =
  (typeof CLI_LAUNCH_MODE)[keyof typeof CLI_LAUNCH_MODE];

export const SESSION_SOURCE_TYPE = {
  LOCAL: "local",
  GITHUB: "github",
  SYSTEM_PATH: "system_path",
} as const;

export const SYSTEM_PATH_ID = {
  HOME: "home",
  DOCUMENTS: "documents",
} as const;

/** Unified source type for session creation */
export type SessionSourceType =
  (typeof SESSION_SOURCE_TYPE)[keyof typeof SESSION_SOURCE_TYPE];

export type SystemPathId = (typeof SYSTEM_PATH_ID)[keyof typeof SYSTEM_PATH_ID];

export const DEFAULT_SESSION_ORG_ID = "personal-org";
export const DEFAULT_SESSION_ORG_NAME = "Personal Org";

export interface SessionLaunchOrgContext {
  orgId: string;
  orgName?: string;
  projectSlug?: string;
  projectId?: string;
  projectName?: string;
  workItemId?: string;
  agentRole?: AgentRole | string;
}

export function createDefaultSessionLaunchOrgContext(): SessionLaunchOrgContext {
  return {
    orgId: DEFAULT_SESSION_ORG_ID,
    orgName: DEFAULT_SESSION_ORG_NAME,
  };
}

/** Unified source selection for session creation */
export interface SessionSource {
  /** Source type: local repo/folder, github remote repo, or system path scope */
  type: SessionSourceType;

  // Local repo fields
  /** Repository ID (when type is 'local') */
  repoId?: string;
  /** Repository name (when type is 'local' or 'github') */
  repoName?: string;
  /** Repository path (when type is 'local') */
  repoPath?: string;

  // System path fields
  /** System path identifier (when type is 'system_path') */
  systemPathId?: SystemPathId;

  // GitHub repo fields
  /** GitHub connection ID (when type is 'github') */
  githubConnectionId?: string;
  /** GitHub repo full name (when type is 'github') */
  githubRepoFullName?: string;

  // Common fields
  /** Branch name */
  branch?: string;
}

export interface SessionCreatorState {
  /** Dispatch category: "cli_agent" or "rust_agent" */
  dispatchCategory: DispatchCategory;
  /** Launch target kind layered above dispatch routing. */
  targetKind: SessionTargetKind;
  /** Unified source selection */
  source: SessionSource | null;
  /** Selected AgentDefinition ID for Rust agents */
  selectedAgentDefinitionId: string | null;
  /** Selected Agent Team ID when targetKind is agent_org */
  selectedAgentOrgId: string | null;
  /** Display name of the selected agent (Rust, CLI, or Agent Team) */
  agentName: string | null;
  /** Icon identifier for the selected agent */
  agentIconId: string | null;
  /** CLI agent type — only set when dispatchCategory is "cli_agent" */
  cliAgentType: CliAgentType | null;
  /** How CLI sessions launch from the creator: prompt composer (GUI) or direct terminal UI (TUI). */
  cliLaunchMode: CliLaunchMode;
}

// ============================================
// Default State
// ============================================

const DEFAULT_AGENT_ORG_ID = "default:sde-feature-team";
const DEFAULT_AGENT_NAME = "SDE Agent";
const DEFAULT_AGENT_ICON_ID = "code";

const DEFAULT_STATE: SessionCreatorState = {
  dispatchCategory: "rust_agent",
  targetKind: SESSION_TARGET_KIND.AGENT,
  source: null,
  selectedAgentDefinitionId: BUILTIN_SDE_DEF_ID,
  selectedAgentOrgId: null,
  agentName: DEFAULT_AGENT_NAME,
  agentIconId: DEFAULT_AGENT_ICON_ID,
  cliAgentType: null,
  cliLaunchMode: CLI_LAUNCH_MODE.GUI,
};

function withDefaultSdeAgent(state: SessionCreatorState): SessionCreatorState {
  return {
    ...state,
    dispatchCategory: "rust_agent",
    targetKind: SESSION_TARGET_KIND.AGENT,
    selectedAgentDefinitionId: BUILTIN_SDE_DEF_ID,
    selectedAgentOrgId: null,
    agentName: DEFAULT_AGENT_NAME,
    agentIconId: DEFAULT_AGENT_ICON_ID,
    cliAgentType: null,
    cliLaunchMode: CLI_LAUNCH_MODE.GUI,
  };
}

export function normalizeSessionCreatorState(
  state: SessionCreatorState
): SessionCreatorState {
  const missingRustAgentSelection =
    state.dispatchCategory === "rust_agent" &&
    state.targetKind === SESSION_TARGET_KIND.AGENT &&
    !state.selectedAgentDefinitionId &&
    !state.selectedAgentOrgId;

  const defaultAgentOrgSelection =
    state.dispatchCategory === "rust_agent" &&
    state.targetKind === SESSION_TARGET_KIND.AGENT_ORG &&
    (!state.selectedAgentOrgId ||
      state.selectedAgentOrgId === DEFAULT_AGENT_ORG_ID);

  if (missingRustAgentSelection || defaultAgentOrgSelection) {
    return withDefaultSdeAgent(state);
  }

  return state;
}

export function normalizeAgentOnlySessionCreatorState(
  state: SessionCreatorState
): SessionCreatorState {
  if (
    state.dispatchCategory !== "human_session" &&
    state.targetKind !== SESSION_TARGET_KIND.HUMAN
  ) {
    return state;
  }

  return withDefaultSdeAgent(state);
}

// ============================================
// Atoms
// ============================================

/**
 * Session creator state atom - shared between toolbar and SessionCreator
 * Persists to localStorage so user's last selections are remembered
 */
export const sessionCreatorStateAtom = atomWithStorage<SessionCreatorState>(
  "orgii:sessionCreatorState",
  DEFAULT_STATE,
  {
    getItem: (key, initialValue) => {
      try {
        const item = localStorage.getItem(key);
        if (!item) return initialValue;
        const parsed = JSON.parse(item) as Partial<SessionCreatorState>;
        const nextState = { ...initialValue, ...parsed };
        return normalizeSessionCreatorState(nextState);
      } catch (error) {
        log.warn("[SessionCreatorState] Failed to load state:", error);
        return initialValue;
      }
    },
    setItem: (key, value) => {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch (error) {
        log.error("[SessionCreatorState] Failed to save state:", error);
      }
    },
    removeItem: (key) => {
      localStorage.removeItem(key);
    },
  },
  { getOnInit: true }
);

/**
 * Derived atom for unified source selection
 */
export const sessionSourceAtom = atom(
  (get) => get(sessionCreatorStateAtom).source,
  (get, set, source: SessionSource | null) => {
    set(sessionCreatorStateAtom, {
      ...get(sessionCreatorStateAtom),
      source,
    });
  }
);

/**
 * Derived atom for dispatch category
 */
export const dispatchCategoryAtom = atom(
  (get) => get(sessionCreatorStateAtom).dispatchCategory,
  (get, set, category: DispatchCategory) => {
    const previous = get(sessionCreatorStateAtom);
    set(sessionCreatorStateAtom, {
      ...previous,
      dispatchCategory: category,
      targetKind:
        category === "cli_agent"
          ? SESSION_TARGET_KIND.CLI_AGENT
          : category === "human_session"
            ? SESSION_TARGET_KIND.HUMAN
            : SESSION_TARGET_KIND.AGENT,
      selectedAgentOrgId: null,
    });
  }
);

/**
 * Derived atom for selected AgentDefinition ID.
 */
export const selectedAgentDefinitionIdAtom = atom(
  (get) => get(sessionCreatorStateAtom).selectedAgentDefinitionId,
  (get, set, agentDefinitionId: string | null) => {
    const previous = get(sessionCreatorStateAtom);
    set(sessionCreatorStateAtom, {
      ...previous,
      selectedAgentDefinitionId: agentDefinitionId,
      targetKind: agentDefinitionId
        ? SESSION_TARGET_KIND.AGENT
        : previous.targetKind,
      selectedAgentOrgId: agentDefinitionId
        ? null
        : previous.selectedAgentOrgId,
    });
  }
);

/**
 * Derived atom for the launch target kind.
 */
export const sessionTargetKindAtom = atom(
  (get) => get(sessionCreatorStateAtom).targetKind,
  (get, set, targetKind: SessionTargetKind) => {
    set(sessionCreatorStateAtom, {
      ...get(sessionCreatorStateAtom),
      targetKind,
    });
  }
);

/**
 * Derived atom for the selected Agent Team ID.
 */
export const selectedAgentOrgIdAtom = atom(
  (get) => get(sessionCreatorStateAtom).selectedAgentOrgId,
  (get, set, agentOrgId: string | null) => {
    const previous = get(sessionCreatorStateAtom);
    set(sessionCreatorStateAtom, {
      ...previous,
      selectedAgentOrgId: agentOrgId,
      targetKind: agentOrgId
        ? SESSION_TARGET_KIND.AGENT_ORG
        : previous.targetKind,
      selectedAgentDefinitionId: agentOrgId
        ? null
        : previous.selectedAgentDefinitionId,
    });
  }
);

/**
 * Derived atom for the selected target's display name (Rust, CLI, or Agent Team).
 */
export const agentNameAtom = atom(
  (get) => get(sessionCreatorStateAtom).agentName
);

/**
 * Derived atom for the selected agent's icon ID.
 */
export const agentIconIdAtom = atom(
  (get) => get(sessionCreatorStateAtom).agentIconId
);

/**
 * Derived atom for the selected CLI agent type.
 */
export const cliAgentTypeAtom = atom(
  (get) => get(sessionCreatorStateAtom).cliAgentType
);

/**
 * Derived atom for the selected CLI launch mode.
 */
export const cliLaunchModeAtom = atom(
  (get) => get(sessionCreatorStateAtom).cliLaunchMode,
  (get, set, cliLaunchMode: CliLaunchMode) => {
    set(sessionCreatorStateAtom, {
      ...get(sessionCreatorStateAtom),
      cliLaunchMode,
    });
  }
);
