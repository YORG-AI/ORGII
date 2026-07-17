/**
 * ControlButtons Component
 *
 * Control buttons for SessionCreator:
 * - Model selector pill group (model + effort segments)
 * - Agent execution mode pill for Rust and CLI sessions
 */
import { useAtom, useAtomValue } from "jotai";
import React, { memo, useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import ModelSelectorPill from "@src/components/ModelSelectorPill";
import ModePill from "@src/engines/ChatPanel/InputArea/components/ModePill";
import type { AgentExecMode } from "@src/features/SessionCreator/config";
import { UnifiedModelPalette } from "@src/scaffold/GlobalSpotlight/palettes/UnifiedModelPalette";
import { UnifiedModelDropdown } from "@src/scaffold/GlobalSpotlight/palettes/UnifiedModelPalette/UnifiedModelDropdown";
import { dispatchCategoryAtom } from "@src/store/session/creatorStateAtom";
import { modelPickerStyleAtom } from "@src/store/ui/chatPanelAtom";
import { modelSelectorAtom } from "@src/store/ui/modelSelectorAtom";

import type { ControlButtonsProps } from "./types";

export type { ControlButtonsProps, DropdownDirection } from "./types";

const ControlButtons: React.FC<ControlButtonsProps> = memo(
  ({
    advancedConfig,
    onConfigChange,
    dropdownDirection = "down",
    requestModelOpen,
    onModelOpenHandled,
    hideModelSourcePill,
    hideModePill,
  }) => {
    const { t: tSessions } = useTranslation("sessions");

    const dispatchCategory = useAtomValue(dispatchCategoryAtom);
    const usesOrgiiExecMode =
      dispatchCategory === "rust_agent" || dispatchCategory === "cli_agent";

    const [selectorState, setSelectorState] = useAtom(modelSelectorAtom);
    const isModelOpen = selectorState.isOpen;
    const modelPickerStyle = useAtomValue(modelPickerStyleAtom);
    const modelSegmentRef = useRef<HTMLButtonElement>(null);

    useEffect(() => {
      if (!requestModelOpen) return;
      const frameId = requestAnimationFrame(() => {
        setSelectorState({ isOpen: true });
        onModelOpenHandled?.();
      });
      return () => cancelAnimationFrame(frameId);
    }, [requestModelOpen, onModelOpenHandled, setSelectorState]);

    const handleOpenModelSelector = useCallback(() => {
      setSelectorState({ isOpen: true });
    }, [setSelectorState]);

    const handleCloseSelector = useCallback(() => {
      setSelectorState({ isOpen: false });
    }, [setSelectorState]);

    const handleSdeModeChange = useCallback(
      (_mode: AgentExecMode) => {
        onConfigChange({ ...advancedConfig });
      },
      [advancedConfig, onConfigChange]
    );

    const handleVariantApply = useCallback(
      (nextModelId: string) => {
        onConfigChange({ ...advancedConfig, model: nextModelId });
      },
      [advancedConfig, onConfigChange]
    );

    return (
      <div className="flex min-w-0 items-center gap-px">
        {!hideModePill && usesOrgiiExecMode && (
          <ModePill
            forceVisible
            hideWhenDefault
            resetToDefaultOnClick
            onModeChange={handleSdeModeChange}
            placement={dropdownDirection === "up" ? "top" : "bottom"}
          />
        )}

        {!hideModelSourcePill && (
          <>
            <ModelSelectorPill
              ref={modelSegmentRef}
              selection={advancedConfig}
              defaultLabel={tSessions("creator.model")}
              active={isModelOpen}
              className="max-w-[360px] shrink-0"
              onClick={handleOpenModelSelector}
              onVariantApply={handleVariantApply}
              dataTestId="session-creator-input-model-pill"
              effortDataTestId="session-creator-input-effort-pill"
              ariaLabel={tSessions("creator.selectModel")}
            />

            {isModelOpen &&
              (modelPickerStyle === "dropdown" ? (
                <UnifiedModelDropdown
                  isOpen={isModelOpen}
                  onClose={handleCloseSelector}
                  advancedConfig={advancedConfig}
                  onConfigChange={onConfigChange}
                  anchorRef={modelSegmentRef}
                  placement={dropdownDirection === "up" ? "top" : "bottom"}
                />
              ) : (
                <UnifiedModelPalette
                  isOpen={isModelOpen}
                  onClose={handleCloseSelector}
                  advancedConfig={advancedConfig}
                  onConfigChange={onConfigChange}
                />
              ))}
          </>
        )}
      </div>
    );
  }
);

ControlButtons.displayName = "ControlButtons";

export default ControlButtons;
