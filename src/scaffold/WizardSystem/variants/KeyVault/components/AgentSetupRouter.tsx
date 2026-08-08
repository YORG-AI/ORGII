/**
 * AgentSetupRouter
 *
 * Routes to the correct credential setup component based on `agentCategory`.
 * Extracted from ApiSetup to keep the main component under the 600-line limit.
 */
import React from "react";

import { getOAuthModelCatalog } from "@src/api/services/keyValidation";
import { CLI_AGENT } from "@src/api/tauri/rpc/schemas/validation";
import { LOCAL_MODEL_PROVIDER } from "@src/api/types/keys";

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

interface AgentSetupRouterProps extends AgentSetupProps {
  agentCategory: string | null;
  isComplex: boolean;
  setupMethod: string | undefined;

  // Cursor-specific
  tokenDetected: boolean;
  setTokenDetected: (detected: boolean) => void;
  detectingToken: boolean;
  tokenError: string | null;
  setTokenError: (error: string | null) => void;
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
  autoStartCodexLogin?: boolean;
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
  setTokenError,
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
  autoStartCodexLogin,
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
          autoStartLogin={autoStartCodexLogin}
          onSessionCaptured={async (values: CodexSessionValues) => {
            const catalog = await getOAuthModelCatalog(CLI_AGENT.CODEX, {
              accessToken: values.accessToken,
              refreshToken: values.refreshToken,
              idToken: values.idToken,
            }).catch((err: unknown) => {
              setTokenError(
                err instanceof Error
                  ? err.message
                  : "Codex model discovery failed"
              );
              return undefined;
            });
            if (!catalog) return;
            const defaultEnabledModels = catalog.defaultEnabledModels.filter(
              (modelId) => catalog.models.includes(modelId)
            );
            const enabledModels =
              defaultEnabledModels.length > 0
                ? defaultEnabledModels
                : catalog.models.slice(0, 1);
            onChange({
              // Intentionally do NOT set `name` here. Forcing "OpenAI" either
              // trips `isDuplicateName` (disabling Done) or shadows the
              // `nextDefaultName` dedupe in `submit()`. Let the wizard's own
              // name-resolution handle it (empty → "OpenAI" / "OpenAI-1" ...).
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
              available_models: catalog.models,
              model_context_lengths: catalog.modelContextLengths,
              model_variants: catalog.modelVariants.map((variant) => ({
                model: variant.model,
                baseModel: variant.base_model,
                reasoning: variant.reasoning ?? undefined,
                fast: variant.fast,
                contextWindow: variant.context_window ?? undefined,
              })),
              default_variants: catalog.defaultVariants,
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
            const catalog = await getOAuthModelCatalog(CLI_AGENT.CLAUDE_CODE, {
              accessToken: values.accessToken,
              refreshToken: values.refreshToken,
            }).catch((err: unknown) => {
              setTokenError(
                err instanceof Error
                  ? err.message
                  : "Claude Code model discovery failed"
              );
              return undefined;
            });
            if (!catalog) return;
            const defaultEnabledModels = catalog.defaultEnabledModels.filter(
              (modelId) => catalog.models.includes(modelId)
            );
            const enabledModels =
              defaultEnabledModels.length > 0
                ? defaultEnabledModels
                : catalog.models.slice(0, 1);
            const expiresAt = values.expiresIn
              ? Date.now() + values.expiresIn * 1000
              : undefined;
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
              // Intentionally do NOT set `name` here. Forcing "Anthropic"
              // trips `isDuplicateName` (disabling Done) or shadows the
              // `nextDefaultName` dedupe in `submit()`. The wizard resolves
              // the account name itself (empty → brand label / "-1" / ...).
              available_models: catalog.models,
              model_context_lengths: catalog.modelContextLengths,
              model_variants: catalog.modelVariants.map((variant) => ({
                model: variant.model,
                baseModel: variant.base_model,
                reasoning: variant.reasoning ?? undefined,
                fast: variant.fast,
                contextWindow: variant.context_window ?? undefined,
              })),
              default_variants: catalog.defaultVariants,
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
