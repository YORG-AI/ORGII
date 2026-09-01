/**
 * Shared types for agent setup components
 */
import type { WizardData } from "../../types";

type InputMode = "direct" | "natural";

export interface AgentSetupProps {
  data: WizardData;
  onChange: (updates: Partial<WizardData>) => void;

  // Validation state from useKeyValidation hook
  keyValidated: boolean;
  validatingKey: boolean;
  validationError: string | null;
  fetchedModels: string[] | null;
  validateKey: () => void;

  // Browser state for webview-based setups
  browserOpen: boolean;
  setBrowserOpen: (open: boolean) => void;
  browserCloseSignal?: number;

  // Input mode for GenericSetup (direct API key vs Auto-Extract)
  inputMode?: InputMode;
  onInputModeChange?: (mode: InputMode) => void;

  // Auto-detect from local config files (Quick Action)
  onAutoDetect?: () => void;
  autoDetecting?: boolean;
  autoDetectError?: string | null;
  onClearAutoDetectError?: () => void;

  // Rust-based extraction (for Auto-Extract mode)
  // Pass the raw messy text to extract from
  onExtract?: (
    rawInput: string,
    onSuccess?: (baseUrl?: string) => void
  ) => void;
  extracting?: boolean;
  extractError?: string | null;
  onClearExtractError?: () => void;
}

export interface CursorSetupProps extends AgentSetupProps {
  // Session token state
  tokenDetected: boolean;
  detectingToken: boolean;
  tokenError: string | null;
  onDetectToken: () => void;
  onClearTokenError?: () => void;

  // Guided vs manual mode
  useGuidedSetup: boolean;
  setUseGuidedSetup: (use: boolean) => void;

  // Manual mode state
  sessionTokenMode: "auto" | "manual";
  setSessionTokenMode: (mode: "auto" | "manual") => void;
  manualSessionToken: string;
  onManualTokenChange: (value: string) => void;

  // Native OAuth session token captured callback
  onSessionTokenCaptured: (sessionToken: string) => void;
  onUrlChange: (url: string) => void;

  // Validation conditions
  hasSessionToken: boolean;

  /** When set, the inline method selector is hidden (already chosen above) */
  preselectedMethod?: string;
}

export interface KiroSessionValues {
  accessToken: string;
  refreshToken: string;
  clientId?: string;
  clientSecret?: string;
  startUrl?: string;
  region?: string;
  expiresAt?: string;
}

export interface ClaudeCodeSessionValues {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  accountMetadata?: Record<string, string>;
}

export interface ClaudeCodeSetupProps extends AgentSetupProps {
  tokenDetected: boolean;
  detectingToken: boolean;
  tokenError: string | null;
  onDetectToken: () => void;
  onClearTokenError?: () => void;
  onSessionCaptured?: (values: ClaudeCodeSessionValues) => void;
  preselectedMethod?: string;
}

export interface CodexSessionValues {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  expiresIn?: number;
}

export interface CodexSetupProps extends AgentSetupProps {
  tokenDetected: boolean;
  detectingToken: boolean;
  tokenError: string | null;
  onDetectToken: () => void;
  onClearTokenError?: () => void;
  onSessionCaptured?: (values: CodexSessionValues) => void;
  preselectedMethod?: string;
  autoStartLogin?: boolean;
}

export interface KiroSetupProps extends AgentSetupProps {
  // Token detection state (quick action)
  tokenDetected: boolean;
  detectingToken: boolean;
  tokenError: string | null;
  onDetectToken: () => void;
  onClearTokenError?: () => void;

  onSessionCaptured?: (values: KiroSessionValues) => void;

  /** When set, the inline method selector is hidden (already chosen above) */
  preselectedMethod?: string;
}
