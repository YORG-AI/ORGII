/**
 * AgentSetupRouter
 *
 * Routes to the correct credential setup component based on `agentCategory`.
 * Extracted from ApiSetup to keep the main component under the 600-line limit.
 */
import React from "react";

import {
  getClaudeCodeOAuthModels as fetchClaudeCodeOAuthModels,
  getCodexOAuthModels as fetchCodexOAuthModels,
  getOAuthModelCatalog,
} from "@src/api/services/keyValidation";
import { CLI_AGENT } from "@src/api/tauri/rpc/schemas/validation";
import { LOCAL_MODEL_PROVIDER } from "@src/api/types/keys";
import { createLogger } from "@src/hooks/logger";

import { ApiKeyProviderSetup } from "./setup/ApiKeyProviderSetup";
import { ClaudeCodeSetup } from "./setup/ClaudeCodeSetup";
import { CodexSetup } from "./setup/CodexSetup";
import { CopilotSetup } from "./setup/CopilotSetup";
import { CursorSetup } from "./setup/CursorSetup";
import { GenericSetup } from "./setup/GenericSetup";
import { KiroSetup } from "./setup/KiroSetup";
import { LocalModelSetup } from "./setup/LocalModelSetup";
import type { AgentSetupProps } from "./setup/types";
import type {
  ClaudeCodeSessionValues,
  CodexSessionValues,
  KiroSessionValues,
} from "./setup/types";

const log = createLogger("ApiSetup");

interface AgentSetupRouterProps extends AgentSetupProps {
  agentCategory: string | null;
  isComplex: boolean;
  setupMethod: string | undefined;

  // Cursor-specific
  tokenDetected: boolean;
  setTokenDetected: (detected: boolean) => void;
  detectingToken: boolean;
  tokenError: string | null;
  clearTokenError: () => void;
  useGuidedSetup: boolean;
  setUseGuidedSetup: (use: boolean) => void;
  sessionTokenMode: "auto" | "manual";
  setSessionTokenMode: (mode: "auto" | "manual") => void;
  manualSessionToken: string;
  handleManualTokenChange: (value: string) => void;
  handleSessionTokenCaptured: (sessionToken: string) => void;
  handleUrlChange: (url: string) => void;
  hasSessionToken: boolean;
}

/**
 * Switches on `agentCategory` and renders the correct credential setup component.
 * All oauth `onSessionCaptured` callbacks are wired here so they don't clutter
 * the parent `ApiSetup` component.
 */
export const AgentSetupRouter: React.FC<AgentSetupRouterProps> = ({
  agentCategory,
  isComplex,
  setupMethod,
  tokenDetected,
  setTokenDetected,
  detectingToken,
  tokenError,
  clearTokenError,
  useGuidedSetup,
  setUseGuidedSetup,
  sessionTokenMode,
  setSessionTokenMode,
  manualSessionToken,
  handleManualTokenChange,
  handleSessionTokenCaptured,
  handleUrlChange,
  hasSessionToken,
  ...sharedProps
}) => {
  const { onChange } = sharedProps;

  if (sharedProps.data.agent_type === LOCAL_MODEL_PROVIDER) {
    return <LocalModelSetup {...sharedProps} />;
  }

  switch (agentCategory) {
    case "api_key_provider":
      return <ApiKeyProviderSetup {...sharedProps} />;

    case "cursor":
      return (
        <CursorSetup
          {...sharedProps}
          tokenDetected={tokenDetected}
          detectingToken={detectingToken}
          tokenError={tokenError}
          onDetectToken={sharedProps.onAutoDetect ?? (() => {})}
          onClearTokenError={clearTokenError}
          useGuidedSetup={useGuidedSetup}
          setUseGuidedSetup={setUseGuidedSetup}
          sessionTokenMode={sessionTokenMode}
          setSessionTokenMode={setSessionTokenMode}
          manualSessionToken={manualSessionToken}
          onManualTokenChange={handleManualTokenChange}
          onSessionTokenCaptured={handleSessionTokenCaptured}
          onUrlChange={handleUrlChange}
          hasSessionToken={hasSessionToken}
          preselectedMethod={isComplex ? setupMethod : undefined}
        />
      );

    case "codex":
      return (
        <CodexSetup
          {...sharedProps}
          tokenDetected={tokenDetected}
          detectingToken={detectingToken}
          tokenError={tokenError}
          onDetectToken={sharedProps.onAutoDetect ?? (() => {})}
          onClearTokenError={clearTokenError}
          preselectedMethod={isComplex ? setupMethod : undefined}
          onSessionCaptured={async (values: CodexSessionValues) => {
            const catalog = await getOAuthModelCatalog(CLI_AGENT.CODEX);
            let discoveredModels: string[] = [];
            try {
              discoveredModels = await fetchCodexOAuthModels(
                values.accessToken,
                values.idToken
              );
            } catch (err) {
              log.warn(
                "[ApiSetup] Codex OAuth model discovery failed; using Rust catalog:",
                err
              );
            }
            const codexModels =
              discoveredModels.length > 0 ? discoveredModels : catalog.models;
            const defaultEnabledModels = catalog.defaultEnabledModels.filter(
              (modelId) => codexModels.includes(modelId)
            );
            const enabledModels =
              defaultEnabledModels.length > 0
                ? defaultEnabledModels
                : codexModels.slice(0, 1);
            onChange({
              name: "OpenAI",
              auth_method: "oauth",
              oauth_session_token: values.accessToken,
              raw_key_input: "",
              env_vars: [
                { name: "OPENAI_REFRESH_TOKEN", value: values.refreshToken },
                { name: "OPENAI_ID_TOKEN", value: values.idToken },
                ...(values.expiresIn
                  ? [
                      {
                        name: "OPENAI_EXPIRES_IN",
                        value: String(values.expiresIn),
                      },
                    ]
                  : []),
              ],
              available_models: codexModels,
              model_context_lengths: {},
              enabled_models: enabledModels,
              validated: true,
            });
            setTokenDetected(true);
          }}
        />
      );

    case "copilot":
      return (
        <CopilotSetup
          {...sharedProps}
          preselectedMethod={isComplex ? setupMethod : undefined}
        />
      );

    case "kiro":
      return (
        <KiroSetup
          {...sharedProps}
          tokenDetected={tokenDetected}
          detectingToken={detectingToken}
          tokenError={tokenError}
          onDetectToken={sharedProps.onAutoDetect ?? (() => {})}
          onClearTokenError={clearTokenError}
          preselectedMethod={isComplex ? setupMethod : undefined}
          onSessionCaptured={(values: KiroSessionValues) => {
            const envVars = [
              { name: "KIRO_ACCESS_TOKEN", value: values.accessToken },
              { name: "KIRO_REFRESH_TOKEN", value: values.refreshToken },
              ...(values.clientId
                ? [{ name: "KIRO_CLIENT_ID", value: values.clientId }]
                : []),
              ...(values.clientSecret
                ? [
                    {
                      name: "KIRO_CLIENT_SECRET",
                      value: values.clientSecret,
                    },
                  ]
                : []),
              ...(values.startUrl
                ? [{ name: "KIRO_START_URL", value: values.startUrl }]
                : []),
              ...(values.region
                ? [{ name: "KIRO_REGION", value: values.region }]
                : []),
              ...(values.expiresAt
                ? [{ name: "KIRO_EXPIRES_AT", value: values.expiresAt }]
                : []),
            ];
            onChange({
              env_vars: envVars,
              validated: true,
            });
            setTokenDetected(true);
            sharedProps.onAutoDetect?.();
          }}
        />
      );

    case "claude_code":
      return (
        <ClaudeCodeSetup
          {...sharedProps}
          tokenDetected={tokenDetected}
          detectingToken={detectingToken}
          tokenError={tokenError}
          onDetectToken={sharedProps.onAutoDetect ?? (() => {})}
          onClearTokenError={clearTokenError}
          preselectedMethod={isComplex ? setupMethod : undefined}
          onSessionCaptured={async (values: ClaudeCodeSessionValues) => {
            const catalog = await getOAuthModelCatalog(CLI_AGENT.CLAUDE_CODE);
            let discoveredModels: string[] = [];
            try {
              discoveredModels = await fetchClaudeCodeOAuthModels(
                values.accessToken
              );
            } catch (err) {
              log.warn(
                "[ApiSetup] Claude Code OAuth model discovery failed; using Rust catalog:",
                err
              );
            }
            const claudeCodeModels =
              discoveredModels.length > 0 ? discoveredModels : catalog.models;
            const defaultEnabledModels = catalog.defaultEnabledModels.filter(
              (modelId) => claudeCodeModels.includes(modelId)
            );
            const enabledModels =
              defaultEnabledModels.length > 0
                ? defaultEnabledModels
                : claudeCodeModels.slice(0, 1);
            const expiresAt = values.expiresIn
              ? Date.now() + values.expiresIn * 1000
              : undefined;
            const accountName = "Anthropic";
            const envVars = [
              ...(values.refreshToken
                ? [
                    {
                      name: "CLAUDE_CODE_REFRESH_TOKEN",
                      value: values.refreshToken,
                    },
                  ]
                : []),
              ...(values.expiresIn
                ? [
                    {
                      name: "CLAUDE_CODE_EXPIRES_IN",
                      value: String(values.expiresIn),
                    },
                  ]
                : []),
              ...(expiresAt
                ? [
                    {
                      name: "CLAUDE_CODE_EXPIRES_AT",
                      value: String(expiresAt),
                    },
                  ]
                : []),
            ];
            onChange({
              auth_method: "oauth",
              oauth_session_token: values.accessToken,
              raw_key_input: "",
              env_vars: envVars,
              account_metadata: values.accountMetadata ?? {},
              ...(accountName ? { name: accountName } : {}),
              available_models: claudeCodeModels,
              model_context_lengths: {},
              enabled_models: enabledModels,
              validated: true,
            });
            setTokenDetected(true);
          }}
        />
      );

    default:
      return <GenericSetup {...sharedProps} />;
  }
};
