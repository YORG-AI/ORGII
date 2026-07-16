/**
 * ModelPill Component
 *
 * Compact model selector pill for the chat input toolbar.
 * Renders as a unified pill group: model name | effort (when editable).
 *
 * Two operating modes:
 *  - In-session (a sessionId is in scope, the typical InputArea case)
 *    — display values come from `sessionByIdAtom(sessionId)` for the
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
import React, { memo, useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";

import type { CliAgentType } from "@src/api/tauri/rpc/schemas/validation";
import {
  type DispatchCategory,
  KEY_SOURCE,
  isHostedKey,
} from "@src/api/tauri/session";
import { Message } from "@src/components/Message";
import ModelSelectorPill from "@src/components/ModelSelectorPill";
import { useSessionId } from "@src/engines/SessionCore/hooks/session";
import type { AdvancedConfig } from "@src/features/SessionCreator/types";
import { useValidatedLastPair } from "@src/hooks/models/useValidatedLastPair";
import { useSessionModelField } from "@src/hooks/session/useSessionPatch";
import { UnifiedModelPalette } from "@src/scaffold/GlobalSpotlight/palettes/UnifiedModelPalette";
import { UnifiedModelDropdown } from "@src/scaffold/GlobalSpotlight/palettes/UnifiedModelPalette/UnifiedModelDropdown";
import { sessionRuntimeStatusAtom } from "@src/store/session/cliSessionStatusAtom";
import {
  type LastModelSelection,
  creatorDefaultModelSelectionAtom,
  extractModelPair,
} from "@src/store/session/creatorDefaultModelAtom";
import { sessionByIdAtom } from "@src/store/session/sessionAtom";
import { modelPickerStyleAtom } from "@src/store/ui/chatPanelAtom";
import { modelSelectorAtom } from "@src/store/ui/modelSelectorAtom";
import { isActiveStatus } from "@src/types/session/session";
import { getDispatchCategory } from "@src/util/session/sessionDispatch";

// ============================================
// Component
// ============================================

const ModelPill: React.FC = memo(() => {
  const { t } = useTranslation();
  const modelPickerStyle = useAtomValue(modelPickerStyleAtom);
  const modelSegmentRef = useRef<HTMLButtonElement>(null);
  const [selectorState, setSelectorState] = useAtom(modelSelectorAtom);
  const isModelOpen = selectorState.isOpen;
  // Creator-default selection — also used as the display-only-fields
  // backing for in-session reads (provider label, listing display
  // strings, etc. — fields not stored on the session row).
  const creatorDefaultLastModel = useValidatedLastPair();
  const setCreatorDefaultModel = useSetAtom(creatorDefaultModelSelectionAtom);

  const { sessionId } = useSessionId();
  const isInSession = Boolean(sessionId);
  const session = useAtomValue(sessionByIdAtom(sessionId ?? ""));
  const runtimeStatus = useAtomValue(sessionRuntimeStatusAtom);
  const { setModel: setSessionModel } = useSessionModelField(sessionId ?? "");

  // When inside an active session, pass the session's own dispatchCategory and
  // cliAgentType to the palette so account filtering uses the correct agent
  // type — not whatever the SessionCreator atom last had. Without this override
  // a Claude Code session would see "No items available" because the creator
  // atom might still be pointing at a Rust-agent category.
  const sessionIdCategory = sessionId
    ? getDispatchCategory(sessionId)
    : undefined;
  const paletteCategoryOverride: DispatchCategory | undefined = isInSession
    ? (session?.category ?? sessionIdCategory)
    : undefined;
  const paletteCliAgentTypeOverride: CliAgentType | undefined = isInSession
    ? (session?.cliAgentType ?? undefined)
    : undefined;

  // The display value `lastModel` is built from the session row when
  // present. Fields the row doesn't carry (display labels, listing
  // metadata) stay undefined — the pill's `resolveDisplaySelection`
  // derives account labels from KeyVault by accountId, and historical
  // sessions skip variant remapping.
  const lastModel: LastModelSelection | null = useMemo(() => {
    if (!isInSession) return creatorDefaultLastModel;
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
  }, [isInSession, session, creatorDefaultLastModel]);

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
      selectedSourceLabel: lastModel.selectedSourceLabel,
      selectedSourceModelType: lastModel.selectedSourceModelType,
    };
  }, [lastModel]);

  const handleConfigChange = useCallback(
    (config: AdvancedConfig) => {
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
      t,
    ]
  );

  const handleOpenModelSelector = useCallback(() => {
    setSelectorState({ isOpen: true });
  }, [setSelectorState]);

  const handleCloseSelector = useCallback(() => {
    setSelectorState({ isOpen: false });
  }, [setSelectorState]);

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

  const modelPill = (
    <ModelSelectorPill
      ref={modelSegmentRef}
      selection={lastModel}
      defaultLabel={t("sessions:creator.selectModel")}
      active={isModelOpen}
      className="max-w-[360px]"
      onClick={handleOpenModelSelector}
      onVariantApply={handleVariantApply}
      dataTestId="chat-model-pill-model"
      ariaLabel={t("sessions:creator.selectModel")}
      isActiveSession={isActiveSession}
    />
  );

  return (
    <>
      {modelPill}

      {isModelOpen &&
        (modelPickerStyle === "dropdown" ? (
          <UnifiedModelDropdown
            isOpen={isModelOpen}
            onClose={handleCloseSelector}
            advancedConfig={advancedConfig}
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
            advancedConfig={advancedConfig}
            onConfigChange={handleConfigChange}
            dispatchCategoryOverride={paletteCategoryOverride}
            cliAgentTypeOverride={paletteCliAgentTypeOverride}
          />
        ))}
    </>
  );
});

ModelPill.displayName = "ModelPill";

export default ModelPill;
