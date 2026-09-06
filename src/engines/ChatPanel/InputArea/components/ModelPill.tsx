/**
 * ModelPill Component
 *
 * Compact model selector pill for the chat input toolbar.
 * Renders as a unified pill group: model name | effort (when editable).
 *
 * Two operating modes:
 *  - In-session (a sessionId is in scope, the typical InputArea case)
 *    — display values come from the canonical Session row for the
 *    fields the row carries (`model`, `accountId`, `keySource`,
 *    `cliAgentType`, `tier`); display-only labels are derived from
 *    KeyVault by accountId in `resolveModelDisplaySelection`.
 *    A user pick fires `session_patch` AND updates the creator-default
 *    atom so the user's most-recent choice continues to seed new sessions
 *    — mirrors the legacy "last-used" behaviour without losing per-session truth.
 *  - Creator-default (no sessionId) — reads + writes the creator-
 *    default atom only. Used by the SessionCreator preview.
 */
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import React, { memo, useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { CliAgentType } from "@src/api/tauri/rpc/schemas/validation";
import {
  type DispatchCategory,
  KEY_SOURCE,
  isHostedKey,
} from "@src/api/tauri/session";
import AnyIcon from "@src/components/AnyIcon";
import { Message } from "@src/components/Message";
import ModelIcon from "@src/components/ModelIcon";
import ModelSelectorPill from "@src/components/ModelSelectorPill";
import SelectorPill from "@src/components/SelectorPill";
import { resolveAgentIcon } from "@src/config/agentIcons";
import { useConversationExecutionBinding } from "@src/engines/ChatPanel/ConversationExecutionBindingContext";
import { useSessionId } from "@src/engines/SessionCore/hooks/session";
import type { AdvancedConfig } from "@src/features/SessionCreator/types";
import { useValidatedLastPair } from "@src/hooks/models/useValidatedLastPair";
import { useSessionModelField } from "@src/hooks/session/useSessionPatch";
import type { AgentSelection } from "@src/scaffold/GlobalSpotlight/palettes/DispatchCategoryPalette";
import { DispatchCategoryPicker } from "@src/scaffold/GlobalSpotlight/palettes/DispatchCategoryPalette/DispatchCategoryPicker";
import { UnifiedModelPalette } from "@src/scaffold/GlobalSpotlight/palettes/UnifiedModelPalette";
import { UnifiedModelDropdown } from "@src/scaffold/GlobalSpotlight/palettes/UnifiedModelPalette/UnifiedModelDropdown";
import { sessionByIdAtom } from "@src/store/session";
import { sessionRuntimeStatusAtom } from "@src/store/session/cliSessionStatusAtom";
import {
  type LastModelSelection,
  creatorDefaultModelSelectionAtom,
  extractModelPair,
} from "@src/store/session/creatorDefaultModelAtom";
import { modelPickerStyleAtom } from "@src/store/ui/chatPanelAtom";
import { modelSelectorAtom } from "@src/store/ui/modelSelectorAtom";
import { isActiveStatus } from "@src/types/session/session";
import { getDispatchCategory } from "@src/util/session/sessionDispatch";

// ============================================
// Component
// ============================================

function isSameRuntimeSelection(
  left: AgentSelection,
  right: AgentSelection | null
): boolean {
  if (!right || left.category !== right.category) return false;
  if (left.category === "cli_agent") {
    return (
      right.category === "cli_agent" &&
      Boolean(left.cliAgentType) &&
      left.cliAgentType === right.cliAgentType
    );
  }
  return (
    left.category === "rust_agent" &&
    right.category === "rust_agent" &&
    Boolean(left.agentDefinitionId) &&
    left.agentDefinitionId === right.agentDefinitionId
  );
}

const ModelPillComponent: React.FC = () => {
  const { t } = useTranslation();
  const modelPickerStyle = useAtomValue(modelPickerStyleAtom);
  const modelSegmentRef = useRef<HTMLButtonElement>(null);
  const runtimeSegmentRef = useRef<HTMLButtonElement>(null);
  const [isRuntimeOpen, setIsRuntimeOpen] = useState(false);
  const [pendingRuntimePick, setPendingRuntimePick] = useState<{
    sessionId: string | null | undefined;
    selection: AgentSelection;
  } | null>(null);
  const [selectorState, setSelectorState] = useAtom(modelSelectorAtom);
  const isModelOpen = selectorState.isOpen;
  // Creator-default selection — also used as the display-only-fields
  // backing for in-session reads (provider label, listing display
  // strings, etc. — fields not stored on the session row).
  const creatorDefaultLastModel = useValidatedLastPair();
  const setCreatorDefaultModel = useSetAtom(creatorDefaultModelSelectionAtom);

  const { sessionId } = useSessionId();
  const [pendingRuntimeOwner, setPendingRuntimeOwner] = useState(sessionId);
  if (pendingRuntimeOwner !== sessionId) {
    // React supports guarded state adjustment while rendering. This clears an
    // unfinished runtime -> model pick before the new conversation commits,
    // without an effect flash or a second cross-session state owner.
    setPendingRuntimeOwner(sessionId);
    setPendingRuntimePick(null);
  }
  const isInSession = Boolean(sessionId);
  const session = useAtomValue(sessionByIdAtom(sessionId ?? ""));
  const runtimeStatus = useAtomValue(sessionRuntimeStatusAtom);
  const { setModel: setSessionModel } = useSessionModelField(sessionId ?? "");
  // Team-conversation composers (imported copies) execute member turns via
  // the remembered runner setup — the pill mirrors and edits THAT record
  // instead of the imported row, whose model field is deliberately empty
  // and whose patches the next family refresh would wipe anyway.
  const conversationBinding = useConversationExecutionBinding();
  const pendingRuntimeCandidate =
    pendingRuntimePick && pendingRuntimePick.sessionId === sessionId
      ? pendingRuntimePick.selection
      : null;
  // Runtime resolution can complete after the picker initially reported that
  // it still needed a model. Once the authoritative conversation binding has
  // committed that runtime, its complete target/presentation owns the footer;
  // do not let the picker-local draft keep masking ambient Claude as
  // "Select model" while turns already execute against Claude.
  const pendingRuntimeResolved = Boolean(
    pendingRuntimeCandidate &&
    conversationBinding?.target &&
    isSameRuntimeSelection(
      pendingRuntimeCandidate,
      conversationBinding.runtimeSelection
    )
  );
  const pendingRuntimeSelection = pendingRuntimeResolved
    ? null
    : pendingRuntimeCandidate;
  const clearPendingRuntimeSelection = useCallback(
    () => setPendingRuntimePick(null),
    []
  );

  // When inside an active session, pass the session's own dispatchCategory and
  // cliAgentType to the palette so account filtering uses the correct agent
  // type — not whatever the SessionCreator atom last had. Without this override
  // a Claude Code session would see "No items available" because the creator
  // atom might still be pointing at a Rust-agent category.
  const sessionIdCategory = sessionId
    ? getDispatchCategory(sessionId)
    : undefined;
  const paletteCategoryOverride: DispatchCategory | undefined = isInSession
    ? conversationBinding
      ? (pendingRuntimeSelection?.category ??
        conversationBinding.runtimeSelection?.category)
      : (session?.category ?? sessionIdCategory)
    : undefined;
  const paletteCliAgentTypeOverride: CliAgentType | undefined = isInSession
    ? conversationBinding
      ? (pendingRuntimeSelection?.cliAgentType ??
        conversationBinding.runtimeSelection?.cliAgentType)
      : (session?.cliAgentType ?? undefined)
    : undefined;

  // The display value `lastModel` is built from the session row when
  // present. Fields the row doesn't carry (display labels, listing
  // metadata) stay undefined — the pill's `resolveDisplaySelection`
  // derives account labels from KeyVault by accountId, and historical
  // sessions skip variant remapping.
  const lastModel: LastModelSelection | null = useMemo(() => {
    if (!isInSession) return creatorDefaultLastModel;
    if (conversationBinding) return conversationBinding.selection;
    if (!session) return creatorDefaultLastModel;

    const isHosted = isHostedKey(session.keySource);
    return {
      keySource: session.keySource,
      cliAgentType: session.cliAgentType,
      tier: session.tier,
      model: isHosted ? undefined : session.model,
      listingModel: isHosted ? session.model : undefined,
      selectedAccountId: session.accountId,
    };
  }, [isInSession, session, creatorDefaultLastModel, conversationBinding]);

  const isActiveSession = isInSession ? isActiveStatus(session?.status) : false;

  const advancedConfig: AdvancedConfig = useMemo(() => {
    if (!lastModel) return {};

    if (isHostedKey(lastModel.keySource)) {
      return {
        keySource: KEY_SOURCE.HOSTED,
        cliAgentType: lastModel.cliAgentType,
        tier: lastModel.tier,
        listingModel: lastModel.listingModel,
        listingModelDisplay: lastModel.listingModelDisplay,
        listingModelType: lastModel.listingModelType,
        listingName: lastModel.listingName,
        selectedSourceLabel: lastModel.selectedSourceLabel,
        selectedSourceModelType: lastModel.selectedSourceModelType,
      };
    }

    return {
      keySource: KEY_SOURCE.OWN,
      provider: lastModel.provider,
      model: lastModel.model,
      selectedAccountId: lastModel.selectedAccountId,
      cliAgentType: lastModel.cliAgentType,
      selectedSourceLabel: lastModel.selectedSourceLabel,
      selectedSourceModelType: lastModel.selectedSourceModelType,
    };
  }, [lastModel]);

  const handleConfigChange = useCallback(
    (config: AdvancedConfig) => {
      // Team-conversation composer: the pick belongs to the remembered
      // runner setup, never to the imported row (whose model field is
      // deliberately empty and whose patches a family refresh wipes).
      // Runtime has its own standard New Session picker. This picker only
      // changes the model/account source for that selected runtime.
      if (conversationBinding) {
        if (
          conversationBinding.applyModelPick(config, pendingRuntimeSelection)
        ) {
          clearPendingRuntimeSelection();
        }
        return;
      }
      // In-session: keySource / cliAgentType / tier are session-create
      // immutables (mis-billing risk + zombie CLI processes if mutated;
      // see apply_session_patch module docs). If the palette emitted a
      // change in any of these, we MUST refuse the edit AND avoid
      // contaminating the creator-default atom with the partially
      // applied selection. Surfacing a warning closes the loop the user
      // sees ("I clicked, the pill snapped back, no idea why").
      if (isInSession && session) {
        const sessionKeySource = session.keySource;
        const sessionAgent = session.cliAgentType;
        const sessionTier = session.tier;

        const incomingKeySource = config.keySource;
        const incomingAgent = config.cliAgentType;
        const incomingTier = config.tier;

        const keySourceDiffers =
          incomingKeySource !== undefined &&
          sessionKeySource !== undefined &&
          incomingKeySource !== sessionKeySource;
        const agentDiffers =
          incomingAgent !== undefined &&
          sessionAgent !== undefined &&
          incomingAgent !== sessionAgent;
        const tierDiffers =
          incomingTier !== undefined &&
          sessionTier !== undefined &&
          incomingTier !== sessionTier;

        if (keySourceDiffers || agentDiffers || tierDiffers) {
          Message.warning(t("sessions:modelPill.immutableInSession"));
          return;
        }
      }

      const pair = extractModelPair(config);
      setCreatorDefaultModel(pair);

      // For in-session model swaps, persist `(model, accountId)` to
      // the session row via session_patch. For market sessions the
      // wire `model` field is the listing model identifier (Rust
      // persists it into the same column).
      if (isInSession) {
        const market = isHostedKey(config.keySource);
        const wireModel = market ? config.listingModel : config.model;
        const wireAccount = market ? undefined : config.selectedAccountId;
        if (wireModel) {
          // Mid-stream account switch is allowed (the patch lands and the
          // NEXT turn rebuilds onto the new account), but the in-flight
          // turn keeps streaming on the old account's provider — surface
          // that so the pill's instant repaint doesn't read as "the
          // current reply switched too".
          const accountChanges =
            wireAccount !== undefined &&
            session?.accountId !== undefined &&
            wireAccount !== session.accountId;
          if (runtimeStatus === "running" && accountChanges) {
            Message.info(t("sessions:modelPill.appliesNextTurn"));
          }
          void setSessionModel(wireModel, wireAccount);
        }
      }
    },
    [
      setCreatorDefaultModel,
      isInSession,
      session,
      setSessionModel,
      runtimeStatus,
      conversationBinding,
      clearPendingRuntimeSelection,
      pendingRuntimeSelection,
      t,
    ]
  );

  const handleOpenModelSelector = useCallback(() => {
    setIsRuntimeOpen(false);
    setSelectorState({ isOpen: true });
  }, [setSelectorState]);

  const handleToggleRuntimeSelector = useCallback(() => {
    if (!isRuntimeOpen) setSelectorState({ isOpen: false });
    setIsRuntimeOpen((open) => !open);
  }, [isRuntimeOpen, setSelectorState]);

  const handleCloseSelector = useCallback(() => {
    setSelectorState({ isOpen: false });
    clearPendingRuntimeSelection();
  }, [clearPendingRuntimeSelection, setSelectorState]);

  const handleVariantApply = useCallback(
    (nextModelId: string) => {
      if (!lastModel) return;

      const updatedConfig: AdvancedConfig = isHostedKey(lastModel.keySource)
        ? advancedConfig
        : {
            ...advancedConfig,
            model: nextModelId,
          };

      handleConfigChange(updatedConfig);
    },
    [advancedConfig, handleConfigChange, lastModel]
  );

  const handleRuntimeSelect = useCallback(
    (selection: AgentSelection) => {
      if (conversationBinding?.applyRuntimePick(selection)) {
        clearPendingRuntimeSelection();
        setIsRuntimeOpen(false);
        return;
      }
      // Mirror New Session: retain the uncommitted runtime choice only in
      // this picker, then immediately hand off to the existing source/model
      // palette. No incomplete execution target reaches persisted state.
      setPendingRuntimePick({ sessionId, selection });
      setIsRuntimeOpen(false);
      setSelectorState({ isOpen: true });
    },
    [
      clearPendingRuntimeSelection,
      conversationBinding,
      sessionId,
      setSelectorState,
    ]
  );

  const pillSelection = useMemo(
    () =>
      pendingRuntimeSelection
        ? null
        : conversationBinding && lastModel
          ? { ...lastModel, cliAgentLabel: undefined }
          : lastModel,
    [conversationBinding, lastModel, pendingRuntimeSelection]
  );

  const conversationTargetReady =
    !conversationBinding ||
    (conversationBinding.readiness === "ready" &&
      (Boolean(conversationBinding.target) ||
        Boolean(pendingRuntimeSelection)));
  const modelDefaultLabel =
    conversationBinding?.readiness === "loading"
      ? t("common:actions.loading")
      : t("sessions:creator.model");
  const visiblePillSelection = conversationTargetReady ? pillSelection : null;
  const effectiveModelOpen = isModelOpen && conversationTargetReady;
  const runtimeSelection =
    pendingRuntimeSelection ?? conversationBinding?.runtimeSelection ?? null;
  const runtimeReady = conversationBinding?.readiness === "ready";
  const effectiveRuntimeOpen = isRuntimeOpen && runtimeReady;
  const runtimeLabel =
    conversationBinding?.readiness === "loading"
      ? t("common:actions.loading")
      : (runtimeSelection?.agentName ?? t("sessions:creator.selectAgent"));
  const runtimeIcon = runtimeSelection?.cliAgentType ? (
    <ModelIcon agentType={runtimeSelection.cliAgentType} size={14} />
  ) : (
    <AnyIcon
      icon={resolveAgentIcon(runtimeSelection?.agentIconId)}
      size={14}
      className="text-text-2"
    />
  );
  const paletteAdvancedConfig = pendingRuntimeSelection
    ? {
        keySource: KEY_SOURCE.OWN,
        cliAgentType: pendingRuntimeSelection.cliAgentType,
      }
    : advancedConfig;

  const modelPill = (
    <div
      className="contents"
      data-testid="chat-model-target"
      data-account-id={visiblePillSelection?.selectedAccountId}
      data-model-id={
        visiblePillSelection?.model ?? visiblePillSelection?.listingModel
      }
    >
      <ModelSelectorPill
        ref={modelSegmentRef}
        selection={visiblePillSelection}
        defaultLabel={modelDefaultLabel}
        active={effectiveModelOpen}
        className="max-w-[360px]"
        onClick={handleOpenModelSelector}
        onVariantApply={handleVariantApply}
        dataTestId="chat-model-pill-model"
        ariaLabel={t("sessions:creator.selectModel")}
        isActiveSession={isActiveSession}
        disabled={!conversationTargetReady}
      />
    </div>
  );

  // A Chat Pane can open synchronously before a cloud replay's local
  // Session row exists. Never paint the unrelated New Session defaults in
  // that gap; the loading-source binding normally resolves in the same
  // frame, and an unavailable source renders no false selection at all.
  if (isInSession && !session && !conversationBinding) return null;

  return (
    <>
      {conversationBinding && (
        <>
          <SelectorPill
            ref={runtimeSegmentRef}
            icon={runtimeIcon}
            label={runtimeLabel}
            tooltip={t("sessions:creator.switchAgent")}
            tooltipPosition="top"
            active={effectiveRuntimeOpen}
            disabled={!runtimeReady}
            onClick={handleToggleRuntimeSelector}
            size="sm"
            ariaLabel={runtimeLabel}
            dataTestId="chat-runtime-pill"
          />
          <DispatchCategoryPicker
            style={modelPickerStyle}
            isOpen={effectiveRuntimeOpen}
            onClose={() => setIsRuntimeOpen(false)}
            onSelect={handleRuntimeSelect}
            currentCategory={runtimeSelection?.category}
            currentAgentDefinitionId={runtimeSelection?.agentDefinitionId}
            currentCliAgentType={runtimeSelection?.cliAgentType}
            hideOrgs
            allowedCliAgentTypes={conversationBinding.nativeCliTargets}
            anchorRef={runtimeSegmentRef}
            placement="top"
          />
        </>
      )}
      {modelPill}

      {effectiveModelOpen &&
        (modelPickerStyle === "dropdown" ? (
          <UnifiedModelDropdown
            isOpen={isModelOpen}
            onClose={handleCloseSelector}
            advancedConfig={paletteAdvancedConfig}
            onConfigChange={handleConfigChange}
            dispatchCategoryOverride={paletteCategoryOverride}
            cliAgentTypeOverride={paletteCliAgentTypeOverride}
            anchorRef={modelSegmentRef}
            placement="top"
          />
        ) : (
          <UnifiedModelPalette
            isOpen={isModelOpen}
            onClose={handleCloseSelector}
            advancedConfig={paletteAdvancedConfig}
            onConfigChange={handleConfigChange}
            agentNameOverride={
              pendingRuntimeSelection?.agentName ??
              conversationBinding?.runtimeSelection?.agentName
            }
            dispatchCategoryOverride={paletteCategoryOverride}
            cliAgentTypeOverride={paletteCliAgentTypeOverride}
          />
        ))}
    </>
  );
};

const ModelPill = memo(ModelPillComponent);

ModelPill.displayName = "ModelPill";

export default ModelPill;
