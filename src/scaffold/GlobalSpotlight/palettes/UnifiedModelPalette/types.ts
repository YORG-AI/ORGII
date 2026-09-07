import type {
  CliAgentType,
  ModelType,
  NativeHarnessType,
} from "@src/api/tauri/rpc/schemas/validation";
import type { DispatchCategory, KeySource } from "@src/api/tauri/session/index";
import type { AdvancedConfig } from "@src/features/SessionCreator/types";

import type { BasePaletteProps } from "../../shared";

export interface SourceOption {
  id: string;
  label: string;
  modelType: ModelType;
  type: KeySource;
  accountId?: string;
  nativeHarnessType?: NativeHarnessType;
}

export interface UnifiedModelPaletteProps extends BasePaletteProps {
  advancedConfig: AdvancedConfig;
  onConfigChange: (config: AdvancedConfig) => void;
  /**
   * Display-name override for an already-running conversation's runtime.
   * Creator surfaces omit this and keep using the SessionCreator selection.
   */
  agentNameOverride?: string;
  /**
   * Override the dispatch category used for account filtering. When provided
   * (e.g. by ModelPill in an active session), this value takes precedence over
   * the SessionCreator atom so the palette filters accounts for the CURRENT
   * session's agent type rather than whatever the creator last had selected.
   */
  dispatchCategoryOverride?: DispatchCategory;
  /**
   * Override the CLI agent type used for account filtering. Paired with
   * `dispatchCategoryOverride` — pass the session's `cliAgentType` so that
   * CLI-agent-compatible accounts (e.g. Anthropic API key for claude_code)
   * are included even when the creator atom is pointing at a different agent.
   */
  cliAgentTypeOverride?: CliAgentType;
}
