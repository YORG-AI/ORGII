import type { CliAgentType } from "@src/api/tauri/rpc/schemas/validation";
import type { DispatchCategory } from "@src/api/tauri/session";
import type { IconSvgElement } from "@src/icons";
import type { CliLaunchMode } from "@src/store/session";
import type { SessionTargetKind } from "@src/store/session/creatorStateAtom";

import type { BasePaletteProps } from "../../shared";

export interface AgentSelection {
  category: DispatchCategory;
  targetKind: SessionTargetKind;
  agentDefinitionId?: string;
  agentOrgId?: string;
  cliAgentType?: CliAgentType;
  cliLaunchMode?: CliLaunchMode;
  agentName: string;
  agentIconId?: string;
}

export interface AgentOption {
  id: string;
  name: string;
  desc: string;
  iconId?: string;
  category: DispatchCategory;
  targetKind: SessionTargetKind;
  agentDefinitionId?: string;
  agentOrgId?: string;
  cliAgentType?: CliAgentType;
  isBuiltIn: boolean;
  isCli: boolean;
  isOrg: boolean;
  rightContent?: React.ReactNode;
}

export interface DispatchCategoryPaletteProps extends BasePaletteProps {
  onSelect: (selection: AgentSelection) => void;
  currentCategory?: DispatchCategory;
  currentAgentDefinitionId?: string;
  currentAgentOrgId?: string;
  currentCliAgentType?: CliAgentType;
  /**
   * When true the Agent Teams group is omitted entirely. Used by member-row
   * pickers inside a team panel where selecting another team makes no sense.
   */
  hideOrgs?: boolean;
  /** Omit CLI agents from contexts that only support Rust-native sessions. */
  hideCliAgents?: boolean;
  /**
   * When true only CLI agent entries are shown. Used by CLI-only picker surfaces.
   */
  cliOnly?: boolean;
  /** Include the Human-session document target in session-creation pickers. */
  includeHumanSession?: boolean;
  /**
   * Optional context pill rendered above the input — used by callers that
   * pre-select a target (e.g. an org member row clicking its agent pill)
   * so the palette title reflects what is being chosen for.
   */
  titleLabel?: string;
  /** Static glyph paired with `titleLabel`. Defaults to no icon when omitted. */
  titleIcon?: IconSvgElement;
  /** Optional placeholder override for contextual picker copy. */
  placeholderLabel?: string;
}
