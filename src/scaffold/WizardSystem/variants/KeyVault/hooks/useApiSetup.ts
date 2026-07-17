import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { DetectedKey } from "@src/api/types/keys";
import { useReferencePrices } from "@src/hooks/keyVault/useReferencePrices";

import type { WizardData } from "../types";
import {
  type AgentCategory,
  getAgentCategory,
  getApiSetupAgentFlags,
} from "./apiSetupCategories";
import {
  getApiSetupProceedState,
  getResolvedCursorSessionToken,
} from "./apiSetupDerived";
import { useApiSetupCursorToken } from "./useApiSetupCursorToken";
import { useApiSetupExtraction } from "./useApiSetupExtraction";
import { useApiSetupHealthCheck } from "./useApiSetupHealthCheck";
import { useApiSetupTokenDetection } from "./useApiSetupTokenDetection";
import { useApiSetupValidation } from "./useApiSetupValidation";

export { getAgentCategory };
export type { AgentCategory };

export interface UseApiSetupOptions {
  data: WizardData;
  onChange: (updates: Partial<WizardData>) => void;
}

export function useApiSetup({ data, onChange }: UseApiSetupOptions) {
  const { t } = useTranslation("integrations");
  const {
    agentCategory,
    isCursor,
    isCodex,
    isCopilot,
    isKiro,
    isClaudeCode,
    isApiProvider,
    isOAuthAgent,
  } = getApiSetupAgentFlags(data.agent_type);

  const [browserOpen, setBrowserOpen] = useState(false);
  const [detectingToken, setDetectingToken] = useState(false);
  const [tokenDetected, setTokenDetected] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [inputMode, setInputMode] = useState<"direct" | "natural">("direct");
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState<string | null>(null);
  const [showKeySelection, setShowKeySelection] = useState(false);
  const [detectedKeys, setDetectedKeys] = useState<DetectedKey[]>([]);
  const [selectedCredentialIndex, setSelectedCredentialIndex] = useState(0);
  const [cursorSessionToken, setCursorSessionToken] = useState<string>(
    data.cursor_session_token || ""
  );
  const [useGuidedSetup, setUseGuidedSetup] = useState(
    () => data.setup_method === undefined || data.setup_method === "guided"
  );
  const [sessionTokenMode, setSessionTokenMode] = useState<"auto" | "manual">(
    () => (data.setup_method === "enter_token" ? "manual" : "auto")
  );
  const [manualSessionToken, setManualSessionToken] = useState<string>("");
  const [isOnLoginPage, setIsOnLoginPage] = useState(false);

  const { agentModels } = useReferencePrices(data.agent_type);
  const resolvedCursorSessionToken = getResolvedCursorSessionToken(
    cursorSessionToken,
    data
  );

  const {
    agentModelsRef,
    handleManualTokenChange,
    handleSessionTokenCaptured,
    handleUrlChange,
  } = useApiSetupCursorToken({
    data,
    onChange,
    isCursor,
    setCursorSessionToken,
    resolvedCursorSessionToken,
    agentModels,
    setTokenDetected,
    setManualSessionToken,
    setUseGuidedSetup,
    setSessionTokenMode,
    setIsOnLoginPage,
    setBrowserOpen,
    setInputMode,
    setExtracting,
    setExtractError,
    setDetectingToken,
    setTokenError,
  });

  const {
    keyValidated,
    validatingKey,
    validationError,
    fetchedModels,
    extractedConfig,
    validateKey,
  } = useApiSetupValidation({
    data,
    onChange,
    isCursor,
    isCodex,
    isClaudeCode,
    inputMode,
    resolvedCursorSessionToken,
    agentModelsRef,
  });

  const { handleAutoDetectToken, handleConfirmKeySelection } =
    useApiSetupTokenDetection({
      data,
      onChange,
      t,
      isCursor,
      isOAuthAgent,
      isClaudeCode,
      isCodex,
      agentModelsRef,
      detectedKeys,
      selectedCredentialIndex,
      setDetectingToken,
      setTokenDetected,
      setTokenError,
      setCursorSessionToken,
      setShowKeySelection,
      setDetectedKeys,
      setSelectedCredentialIndex,
    });

  const handleExtract = useApiSetupExtraction({
    data,
    onChange,
    t,
    setExtracting,
    setExtractError,
    setInputMode,
  });

  useApiSetupHealthCheck({
    data,
    onChange,
    cursorSessionToken,
    isOnLoginPage,
    isCursor,
  });

  const { hasSessionToken, canProceed } = getApiSetupProceedState({
    data,
    isCursor,
    isCodex,
    isKiro,
    isClaudeCode,
    keyValidated,
    tokenDetected,
    sessionTokenMode,
    manualSessionToken,
  });

  return {
    agentCategory,
    isCursor,
    isCodex,
    isCopilot,
    isKiro,
    isClaudeCode,
    isApiProvider,
    isOAuthAgent,
    browserOpen,
    setBrowserOpen,
    detectingToken,
    tokenDetected,
    tokenError,
    inputMode,
    setInputMode,
    extracting,
    extractError,
    showKeySelection,
    setShowKeySelection,
    detectedKeys,
    selectedCredentialIndex,
    setSelectedCredentialIndex,
    handleConfirmKeySelection,
    cursorSessionToken,
    useGuidedSetup,
    setUseGuidedSetup,
    sessionTokenMode,
    setSessionTokenMode,
    manualSessionToken,
    handleManualTokenChange,
    handleSessionTokenCaptured,
    handleUrlChange,
    isOnLoginPage,
    hasSessionToken,
    setTokenDetected,
    keyValidated,
    validatingKey,
    validationError,
    fetchedModels,
    extractedConfig,
    validateKey,
    handleAutoDetectToken,
    handleExtract,
    canProceed,
    clearTokenError: () => setTokenError(null),
    clearExtractError: () => setExtractError(null),
  };
}
