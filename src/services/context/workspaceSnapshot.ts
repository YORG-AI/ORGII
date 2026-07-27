/**
 * Snapshot of the current workspace state for agent APIs.
 *
 * Includes editor, git, diagnostics, and workspace folder data.
 * Kept in a dependency-free module so `api/tauri/agent/types` and RPC schemas
 * do not import `collectors/AdeContextCollector` (which pulls Jotai stores).
 */
import type {
  DispatchCategory,
  KeySource,
} from "@src/api/tauri/session/dispatchTypes";
import type { CliAgentType } from "@src/api/types/keys";
import type { TechSavvyLevel } from "@src/config/profile/userProfile";
import type { ViewModeType } from "@src/config/viewModeTypes";
import type { ChatPanelSurfaceKind } from "@src/store/ui/chatPanelAtom";
import type { StationMode } from "@src/store/ui/simulatorAtom";
import type { StatusBarAppType } from "@src/store/ui/workStationLayout/statusBarAtoms";
import type {
  WorkStationTabCategory,
  WorkStationTabType,
} from "@src/store/workstation/tabs/types";
import type { UserPresenceWire } from "@src/types/userPresence";

export interface UserProfileWire {
  name?: string;
  techSavvy?: TechSavvyLevel;
  jobRoles?: string[];
  familiarTechStacks?: string[];
  description?: string;
}

export interface GuideTargetSnapshot {
  id: string;
  label: string;
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export interface AppUiSnapshot {
  route?: {
    pathname: string;
    search: string;
    hash: string;
    href: string;
    viewMode: ViewModeType;
  };
  workstation?: {
    stationMode: StationMode;
    activeApp: StatusBarAppType;
    browserUrl?: string;
    browserIsLoading?: boolean;
    browserIsPrivate?: boolean;
    browserSessionCount?: number;
    browserCurrentSessionIndex?: number;
    projectName?: string;
    projectSlug?: string;
    activeTab?: {
      id: string;
      type: WorkStationTabType;
      category?: WorkStationTabCategory;
      title: string;
      filePath?: string;
      url?: string;
      sessionId?: string;
      projectId?: string;
      projectName?: string;
    };
  };
  session?: {
    activeSessionId: string | null;
    workstationActiveSessionId: string | null;
    name?: string;
    status?: string;
    category?: DispatchCategory;
    repoPath?: string;
    model?: string;
    agentExecMode?: string;
    cliAgentType?: CliAgentType;
    keySource?: KeySource;
  };
  chatPanel?: {
    visible: boolean;
    maximized: boolean;
    surface: ChatPanelSurfaceKind;
  };
  overlays?: {
    spotlightOpen: boolean;
    adeManagerEnabled: boolean;
  };
  visibleGuideTargets?: GuideTargetSnapshot[];
}

export interface PullRequestCommitSnapshot {
  sha: string;
  message: string;
}

export interface CurrentPullRequestSnapshot {
  prNumber: number;
  prTitle: string;
  prUrl: string;
  prStatus: "draft" | "open" | "merged" | "closed";
  sourceBranch?: string;
  targetBranch?: string;
  additions?: number;
  deletions?: number;
  filesChanged?: number;
  body?: string;
  commits?: PullRequestCommitSnapshot[];
}

export interface WorkspaceSnapshot {
  activeFile?: string;
  openFiles?: string[];
  cursorPosition?: string;
  gitBranch?: string;
  gitStatus?: string;
  gitChangedFiles?: string[];
  linterErrors?: string[];
  workspaceFolders?: string[];
  /** The PR for the current branch, enriched with commits and description. */
  currentPullRequest?: CurrentPullRequestSnapshot;
  /** Active repository path selected in the ADE toolbar. Maps to IdeContext.repo_path on the Rust side. */
  repoPath?: string;
  /**
   * QQ-style availability the user set in the sidebar footer. Shipped on
   * every turn even when there is no IDE data so the agent can adapt to
   * whether the user is online, invisible, or away.
   */
  userPresence?: UserPresenceWire;
  /**
   * User profile preferences from Settings → My Role. Shipped on every turn
   * so the agent can calibrate explanations and examples to the user.
   */
  userProfile?: UserProfileWire;
  /**
   * Current ORGII UI state: selected route, WorkStation station/app/tab,
   * active session, chat-panel surface, visible guide targets, and overlay
   * state. Used by GUI-control agents to reason about what the user is seeing.
   */
  appUi?: AppUiSnapshot;
}
