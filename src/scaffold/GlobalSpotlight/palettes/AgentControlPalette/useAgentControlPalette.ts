import { useAtomValue, useSetAtom } from "jotai";
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ChevronsRight,
  DraftingCompass,
  Loader2,
  XCircle,
} from "lucide-react";
import React, { useCallback, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";

import { sessionLaunch } from "@src/api/tauri/agent/session";
import { DISPATCH_CATEGORY } from "@src/api/tauri/session";
import Message from "@src/components/Message";
import {
  beginOptimisticTurn,
  failOptimisticTurn,
} from "@src/engines/SessionCore/control/optimisticTurnStatus";
import { chatEventsForSessionAtomFamily } from "@src/engines/SessionCore/derived/sessionScopedChatEvents";
import type { PendingSessionProposal } from "@src/engines/SessionCore/hooks/useAgentADEActions";
import type { AdvancedConfig } from "@src/features/SessionCreator/types";
import { useHousekeeperUiControl } from "@src/hooks/housekeeper";
import { useValidatedLastPair } from "@src/hooks/models/useValidatedLastPair";
import type { SpotlightItem } from "@src/scaffold/GlobalSpotlight/types";
import { collectAdeContext } from "@src/services/context/collectors";
import { adeManagerPaletteAtom } from "@src/store/session/adeManagerPaletteAtom";
import {
  creatorDefaultModelSelectionAtom,
  extractModelPair,
} from "@src/store/session/creatorDefaultModelAtom";
import { modelSelectorAtom } from "@src/store/ui/modelSelectorAtom";
import { adeManagerEnabledAtom } from "@src/store/ui/uiAtom";
import { invokeTauri } from "@src/util/platform/tauri";
import { BUILTIN_ADE_MANAGER_DEF_ID } from "@src/util/session/sessionDispatch";

import { useSelectorKernel } from "../core";
import {
  ADE_MANAGER_SESSION_NAME,
  ADE_MANAGER_SUBMIT_EVENT,
  ADE_MANAGER_TOGGLE_SHORTCUT_ID,
} from "./constants";
import type {
  AdeManagerActivityItem,
  AdeManagerRunStatus,
  AdeManagerSubmitDetail,
} from "./types";
import {
  EMPTY_ADE_MANAGER_EVENTS_ATOM,
  buildControlPrompt,
  resolveControlModel,
  resolveControlModelLabel,
  toAdeManagerActivityItem,
  upsertAdeManagerSession,
} from "./utils";

function useAdeManagerActivity(
  sessionId: string | null
): AdeManagerActivityItem[] {
  const eventsAtom = sessionId
    ? chatEventsForSessionAtomFamily(sessionId)
    : EMPTY_ADE_MANAGER_EVENTS_ATOM;
  const events = useAtomValue(eventsAtom);

  return useMemo(() => {
    if (!sessionId) return [];
    return events
      .map(toAdeManagerActivityItem)
      .filter((item): item is AdeManagerActivityItem => item !== null)
      .slice(-3)
      .reverse();
  }, [events, sessionId]);
}

export function useAgentControlPalette({
  isOpen,
  onClose,
  onGoBackToParent,
}: {
  isOpen: boolean;
  onClose: () => void;
  onGoBackToParent?: () => void;
}) {
  const { t } = useTranslation("common");
  const creatorDefaultLastModel = useValidatedLastPair();
  const setCreatorDefaultModel = useSetAtom(creatorDefaultModelSelectionAtom);
  const setAdeManagerEnabled = useSetAtom(adeManagerEnabledAtom);
  const setSelectorState = useSetAtom(modelSelectorAtom);
  const { tryRunHousekeeperUiControl } = useHousekeeperUiControl();

  // Persistent palette state — survives palette open/close cycles
  const paletteState = useAtomValue(adeManagerPaletteAtom);
  const setPaletteState = useSetAtom(adeManagerPaletteAtom);

  const {
    sessionId: controlSessionId,
    draftText,
    runStatus,
    activityCursor,
    pendingProposal,
  } = paletteState;

  const setDraftText = useCallback(
    (text: string) => setPaletteState((prev) => ({ ...prev, draftText: text })),
    [setPaletteState]
  );
  const setRunStatus = useCallback(
    (status: AdeManagerRunStatus) =>
      setPaletteState((prev) => ({ ...prev, runStatus: status })),
    [setPaletteState]
  );
  const setControlSessionId = useCallback(
    (id: string | null) =>
      setPaletteState((prev) => ({ ...prev, sessionId: id })),
    [setPaletteState]
  );
  const setActivityCursor = useCallback(
    (cursor: number | ((prev: number) => number)) =>
      setPaletteState((prev) => ({
        ...prev,
        activityCursor:
          typeof cursor === "function" ? cursor(prev.activityCursor) : cursor,
      })),
    [setPaletteState]
  );
  const setPendingProposal = useCallback(
    (proposal: PendingSessionProposal | null) =>
      setPaletteState((prev) => ({ ...prev, pendingProposal: proposal })),
    [setPaletteState]
  );

  // Keep a ref in sync with atom so async callbacks always see fresh value
  const controlSessionIdRef = useRef<string | null>(controlSessionId);
  useEffect(() => {
    controlSessionIdRef.current = controlSessionId;
  }, [controlSessionId]);

  const sendingRef = useRef(false);
  const activityItems = useAdeManagerActivity(controlSessionId);

  // Listen for session proposals from the manage_session tool handler
  useEffect(() => {
    function handleProposal(evt: Event) {
      const detail = (evt as CustomEvent<PendingSessionProposal>).detail;
      if (!detail?.correlationId) return;
      setPendingProposal(detail);
    }
    function handleResolved() {
      setPendingProposal(null);
    }
    window.addEventListener("ade-session-proposal", handleProposal);
    window.addEventListener("ade-session-proposal-resolved", handleResolved);
    return () => {
      window.removeEventListener("ade-session-proposal", handleProposal);
      window.removeEventListener(
        "ade-session-proposal-resolved",
        handleResolved
      );
    };
  }, [setPendingProposal]);

  const handleDismissProposal = useCallback(() => {
    setPendingProposal(null);
  }, [setPendingProposal]);

  const items = useMemo<SpotlightItem[]>(() => [], []);

  const handleSubmit = useCallback(() => {
    const text = draftText.trim();
    if (!text || sendingRef.current) return;

    sendingRef.current = true;
    setRunStatus("sending");

    void (async () => {
      try {
        const handledByHousekeeper = await tryRunHousekeeperUiControl(text);
        if (handledByHousekeeper) {
          setDraftText("");
          setRunStatus("idle");
          return;
        }

        setAdeManagerEnabled(true);
        const prompt = buildControlPrompt(text);
        const modelConfig = resolveControlModel(creatorDefaultLastModel);
        const adeContext = collectAdeContext({ expectedRepoPath: null });
        const existingSessionId = controlSessionIdRef.current;
        if (existingSessionId) {
          // Raw invoke bypasses useMessageDispatch — if the control session
          // is also open in the chat panel, the optimistic running keeps its
          // planning indicator alive (#17). Gated no-op otherwise.
          beginOptimisticTurn(existingSessionId);
          try {
            await invokeTauri("agent_send_message", {
              sessionId: existingSessionId,
              content: prompt,
              turnIntentSource: "user_submit",
              ...(modelConfig.model ? { model: modelConfig.model } : {}),
              ...(modelConfig.accountId
                ? { accountId: modelConfig.accountId }
                : {}),
              ideContext: adeContext,
            });
          } catch (sendError) {
            failOptimisticTurn(existingSessionId);
            throw sendError;
          }
        } else {
          const result = await sessionLaunch({
            category: DISPATCH_CATEGORY.RUST_AGENT,
            content: prompt,
            name: ADE_MANAGER_SESSION_NAME,
            agentDefinitionId: BUILTIN_ADE_MANAGER_DEF_ID,
            keySource: modelConfig.keySource,
            ...(modelConfig.model ? { model: modelConfig.model } : {}),
            ...(modelConfig.accountId
              ? { accountId: modelConfig.accountId }
              : {}),
            ideContext: adeContext,
          });
          controlSessionIdRef.current = result.sessionId;
          setControlSessionId(result.sessionId);
          upsertAdeManagerSession(result);
        }

        setRunStatus("running");

        window.dispatchEvent(
          new CustomEvent<AdeManagerSubmitDetail>(ADE_MANAGER_SUBMIT_EVENT, {
            detail: { text, modelSelection: creatorDefaultLastModel },
          })
        );

        setDraftText("");
      } catch (error) {
        setRunStatus("error");
        Message.error(error instanceof Error ? error.message : String(error));
      } finally {
        sendingRef.current = false;
      }
    })();
  }, [
    creatorDefaultLastModel,
    draftText,
    setControlSessionId,
    setDraftText,
    setAdeManagerEnabled,
    setRunStatus,
    tryRunHousekeeperUiControl,
  ]);

  const handleExternalKeyDown = useCallback(
    (
      event: React.KeyboardEvent<HTMLInputElement>,
      internalHandleKeyDown: (
        event: React.KeyboardEvent<HTMLInputElement>
      ) => void
    ) => {
      if (
        event.key === "Enter" &&
        !event.shiftKey &&
        (event.metaKey || event.ctrlKey)
      ) {
        event.preventDefault();
        handleSubmit();
        return;
      }
      if (
        (event.key === "Backspace" || event.key === "Delete") &&
        draftText === "" &&
        onGoBackToParent
      ) {
        event.preventDefault();
        onGoBackToParent();
        return;
      }
      internalHandleKeyDown(event);
    },
    [handleSubmit, draftText, onGoBackToParent]
  );

  const kernel = useSelectorKernel({
    isOpen,
    onClose,
    items,
    externalSearchQuery: draftText,
    externalSetSearchQuery: setDraftText,
    externalHandleKeyDown: handleExternalKeyDown,
    initialSelectedIndex: -1,
  });

  useEffect(() => {
    setActivityCursor(0);
  }, [activityItems.length, setActivityCursor]);

  const handleRefreshSession = useCallback(() => {
    controlSessionIdRef.current = null;
    setControlSessionId(null);
    setActivityCursor(0);
    setRunStatus("idle");
    kernel.focusInput();
  }, [kernel, setActivityCursor, setControlSessionId, setRunStatus]);

  const handlePreviousActivity = useCallback(() => {
    setActivityCursor((currentCursor) =>
      Math.min(currentCursor + 1, Math.max(activityItems.length - 1, 0))
    );
  }, [activityItems.length, setActivityCursor]);

  const handleNextActivity = useCallback(() => {
    setActivityCursor((currentCursor) => Math.max(currentCursor - 1, 0));
  }, [setActivityCursor]);

  const handleLatestActivity = useCallback(() => {
    setActivityCursor(0);
  }, [setActivityCursor]);

  const handleModelConfigChange = useCallback(
    (config: AdvancedConfig) => {
      setCreatorDefaultModel(extractModelPair(config));
      setSelectorState({ isOpen: false });
      kernel.focusInput();
    },
    [kernel, setCreatorDefaultModel, setSelectorState]
  );

  const handleCloseModelSelector = useCallback(() => {
    setSelectorState({ isOpen: false });
    kernel.focusInput();
  }, [kernel, setSelectorState]);

  const modePath = useMemo(
    () => [
      {
        type: "action" as const,
        id: "agent-control",
        label: "ADE Manager",
        icon: DraftingCompass,
        color: "",
      },
    ],
    []
  );

  const latestActivity = activityItems[activityCursor];
  const statusLabel =
    runStatus === "sending"
      ? t("status.sending")
      : runStatus === "error"
        ? t("status.error")
        : t("status.running");

  const statusIcon =
    latestActivity?.status === "running" ||
    (!latestActivity && runStatus === "sending")
      ? Loader2
      : latestActivity?.status === "failed" || runStatus === "error"
        ? XCircle
        : CheckCircle2;

  return {
    activityItems,
    creatorDefaultLastModel,
    draftText,
    handleCloseModelSelector,
    handleDismissProposal,
    handleLatestActivity,
    handleModelConfigChange,
    handleNextActivity,
    handlePreviousActivity,
    handleRefreshSession,
    handleSubmit,
    hasNextActivity: activityCursor > 0,
    hasPreviousActivity: activityCursor < activityItems.length - 1,
    isModelOpen: false,
    items,
    kernel,
    modePath,
    pendingProposal,
    placeholder: t("adeManager.inputPlaceholder"),
    runStatus,
    selectModelLabel: t("adeManager.selectModel"),
    shortcutId: ADE_MANAGER_TOGGLE_SHORTCUT_ID,
    statusDetail:
      latestActivity?.detail ??
      resolveControlModelLabel(creatorDefaultLastModel),
    statusIcon,
    statusIsMarkdown: latestActivity?.isMarkdown ?? false,
    statusLabel: latestActivity?.title ?? statusLabel,
    statusSpinning:
      latestActivity?.status === "running" ||
      (!latestActivity && runStatus === "sending"),
    showSessionControls: Boolean(controlSessionId),
    showStatusLine: runStatus !== "idle" || Boolean(controlSessionId),
    submitDisabled: !draftText.trim(),
    toolbarActions: {
      previousIcon: ChevronLeft,
      nextIcon: ChevronRight,
      latestIcon: ChevronsRight,
    },
  };
}
