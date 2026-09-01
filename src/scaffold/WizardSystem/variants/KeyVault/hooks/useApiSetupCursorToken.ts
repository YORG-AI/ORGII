import { type MutableRefObject, useCallback, useEffect, useRef } from "react";

import { getCursorNativeModels } from "@src/api/services/keyValidation";
import { NATIVE_HARNESS_TYPE } from "@src/api/tauri/rpc/schemas/validation";
import { createLogger } from "@src/hooks/logger";
import { getMyKeyFallbackNativeModels } from "@src/hooks/models/nativeHarnessAccountModels";
import { getDefaultEnabledModels } from "@src/util/modelGrouping";

import type { EnvVar, WizardData } from "../types";

const log = createLogger("useApiSetup");

const CURSOR_REFRESH_TOKEN_ENV_KEY = "CURSOR_REFRESH_TOKEN";

interface UseApiSetupCursorTokenOptions {
  data: WizardData;
  onChange: (updates: Partial<WizardData>) => void;
  isCursor: boolean;
  setCursorSessionToken: (value: string) => void;
  resolvedCursorSessionToken: string | undefined;
  agentModels: string[];
  setTokenDetected: (value: boolean) => void;
  setManualSessionToken: (value: string) => void;
  setUseGuidedSetup: (value: boolean) => void;
  setSessionTokenMode: (value: "auto" | "manual") => void;
  setIsOnLoginPage: (value: boolean) => void;
  setBrowserOpen: (value: boolean) => void;
  setInputMode: (value: "direct" | "natural") => void;
  setExtracting: (value: boolean) => void;
  setExtractError: (value: string | null) => void;
  setDetectingToken: (value: boolean) => void;
  setTokenError: (value: string | null) => void;
}

interface UseApiSetupCursorTokenResult {
  agentModelsRef: MutableRefObject<string[]>;
  cursorHydrateInFlightRef: MutableRefObject<boolean>;
  cursorHydratedTokenRef: MutableRefObject<string | null>;
  hydrateCursorModels: (token: string) => Promise<void>;
  handleSessionTokenCaptured: (sessionToken: string) => Promise<void>;
  handleUrlChange: (url: string) => void;
  handleManualTokenChange: (value: string) => void;
}

export function useApiSetupCursorToken({
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
}: UseApiSetupCursorTokenOptions): UseApiSetupCursorTokenResult {
  const agentModelsRef = useRef<string[]>([]);
  agentModelsRef.current = agentModels;
  const cursorHydrateInFlightRef = useRef(false);
  const cursorHydratedTokenRef = useRef<string | null>(null);

  const mountAgentTypeRef = useRef(data.agent_type);
  useEffect(() => {
    if (mountAgentTypeRef.current === data.agent_type) return;
    mountAgentTypeRef.current = data.agent_type;

    setTokenDetected(false);
    setTokenError(null);
    setDetectingToken(false);
    setCursorSessionToken("");
    setManualSessionToken("");
    cursorHydratedTokenRef.current = null;
    cursorHydrateInFlightRef.current = false;
    onChange({ oauth_session_token: "", auth_method: undefined });
    setUseGuidedSetup(true);
    setSessionTokenMode("auto");
    setIsOnLoginPage(false);
    setBrowserOpen(false);
    setInputMode("direct");
    setExtracting(false);
    setExtractError(null);
  }, [
    data.agent_type,
    onChange,
    setBrowserOpen,
    setCursorSessionToken,
    setDetectingToken,
    setExtractError,
    setExtracting,
    setInputMode,
    setIsOnLoginPage,
    setManualSessionToken,
    setSessionTokenMode,
    setTokenDetected,
    setTokenError,
    setUseGuidedSetup,
  ]);

  const prevSetupMethodRef = useRef(data.setup_method);
  useEffect(() => {
    if (prevSetupMethodRef.current === data.setup_method) return;
    prevSetupMethodRef.current = data.setup_method;
    if (!isCursor || !data.setup_method) return;

    switch (data.setup_method) {
      case "guided":
        setUseGuidedSetup(true);
        break;
      case "autodetect":
        setUseGuidedSetup(false);
        setBrowserOpen(false);
        setSessionTokenMode("auto");
        break;
      case "enter_token":
        setUseGuidedSetup(false);
        setBrowserOpen(false);
        setSessionTokenMode("manual");
        break;
    }
  }, [
    data.setup_method,
    isCursor,
    setBrowserOpen,
    setSessionTokenMode,
    setUseGuidedSetup,
  ]);

  const hydrateCursorModels = useCallback(
    async (token: string) => {
      if (!isCursor) return;
      const trimmed = token.trim();
      if (!trimmed) return;
      const cursorEnvVars: EnvVar[] = data.env_vars.filter(
        (envVar) => envVar.name !== CURSOR_REFRESH_TOKEN_ENV_KEY
      );
      if (cursorHydrateInFlightRef.current) return;
      if (
        cursorHydratedTokenRef.current === trimmed &&
        (data.available_models?.length ?? 0) > 0
      ) {
        return;
      }

      cursorHydrateInFlightRef.current = true;
      try {
        const nativeModels = await getCursorNativeModels(trimmed);
        const effectiveModels =
          nativeModels.length > 0
            ? nativeModels
            : agentModelsRef.current.length > 0
              ? agentModelsRef.current
              : getMyKeyFallbackNativeModels(NATIVE_HARNESS_TYPE.CURSOR);

        onChange({
          auth_method: "oauth",
          cursor_session_token: trimmed,
          env_vars: cursorEnvVars,
          available_models: effectiveModels,
          model_context_lengths: {},
          enabled_models: getDefaultEnabledModels(effectiveModels),
          model_aliases: data.model_aliases ?? [],
          validated: true,
        });
        setCursorSessionToken(trimmed);
        setTokenDetected(true);
        cursorHydratedTokenRef.current = trimmed;
      } catch (err) {
        log.warn("[useApiSetup] Cursor model hydration failed:", err);
        const fallbackModels =
          agentModelsRef.current.length > 0
            ? agentModelsRef.current
            : getMyKeyFallbackNativeModels(NATIVE_HARNESS_TYPE.CURSOR);
        onChange({
          auth_method: "oauth",
          cursor_session_token: trimmed,
          env_vars: cursorEnvVars,
          available_models: fallbackModels,
          model_context_lengths: {},
          enabled_models: getDefaultEnabledModels(fallbackModels),
          model_aliases: data.model_aliases ?? [],
          validated: true,
        });
        setCursorSessionToken(trimmed);
        setTokenDetected(true);
        cursorHydratedTokenRef.current = trimmed;
      } finally {
        cursorHydrateInFlightRef.current = false;
      }
    },
    [
      isCursor,
      onChange,
      data.env_vars,
      data.model_aliases,
      data.available_models?.length,
      setCursorSessionToken,
      setTokenDetected,
    ]
  );

  useEffect(() => {
    if (!isCursor) {
      cursorHydratedTokenRef.current = null;
      return;
    }
    const token = resolvedCursorSessionToken?.trim() ?? "";
    if (!token) {
      cursorHydratedTokenRef.current = null;
      return;
    }
    if ((data.available_models?.length ?? 0) > 0) return;
    if (cursorHydratedTokenRef.current === token) return;
    void hydrateCursorModels(token);
  }, [
    isCursor,
    resolvedCursorSessionToken,
    data.available_models?.length,
    hydrateCursorModels,
  ]);

  const handleSessionTokenCaptured = useCallback(
    async (sessionToken: string) => {
      cursorHydratedTokenRef.current = null;
      await hydrateCursorModels(sessionToken);
    },
    [hydrateCursorModels]
  );

  const handleUrlChange = useCallback(
    (url: string) => {
      const loginIndicators = [
        "authenticator",
        "/login",
        "/signin",
        "/sign-in",
      ];
      const isLogin = loginIndicators.some((indicator) =>
        url.toLowerCase().includes(indicator)
      );
      setIsOnLoginPage(isLogin);
    },
    [setIsOnLoginPage]
  );

  const handleManualTokenChange = useCallback(
    (value: string) => {
      setManualSessionToken(value);
      setCursorSessionToken(value);
      setTokenDetected(!!value);
      const trimmed = value.trim();
      if (!trimmed) {
        cursorHydratedTokenRef.current = null;
        onChange({
          auth_method: undefined,
          cursor_session_token: value,
          env_vars: data.env_vars.filter(
            (envVar) => envVar.name !== CURSOR_REFRESH_TOKEN_ENV_KEY
          ),
          validated: false,
          available_models: [],
          model_context_lengths: {},
          enabled_models: [],
        });
        return;
      }
      cursorHydratedTokenRef.current = null;
      onChange({
        auth_method: "oauth",
        cursor_session_token: value,
        env_vars: data.env_vars.filter(
          (envVar) => envVar.name !== CURSOR_REFRESH_TOKEN_ENV_KEY
        ),
        validated: true,
      });
      void hydrateCursorModels(trimmed);
    },
    [
      data.env_vars,
      hydrateCursorModels,
      onChange,
      setCursorSessionToken,
      setManualSessionToken,
      setTokenDetected,
    ]
  );

  return {
    agentModelsRef,
    cursorHydrateInFlightRef,
    cursorHydratedTokenRef,
    hydrateCursorModels,
    handleSessionTokenCaptured,
    handleUrlChange,
    handleManualTokenChange,
  };
}
