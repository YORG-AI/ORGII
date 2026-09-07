/**
 * ModelSelectorPill
 *
 * Shared model selector trigger used by the active chat input and the
 * SessionCreator input. Models with selectable effort use one combined pill
 * and settings menu. Other models retain their existing PillGroup control.
 */
import React, {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";

import { PILL_SM_ICON_SIZE } from "@src/components/CompoundPill/config";
import ModelIcon from "@src/components/ModelIcon";
import ModelPillTooltipContent from "@src/components/ModelPillTooltipContent";
import ModelPropertiesDropdown from "@src/components/ModelPropertiesDropdown";
import PillGroup, { type PillGroupSegment } from "@src/components/PillGroup";
import SelectorPill from "@src/components/SelectorPill";
import { getShortcutKeys } from "@src/config/keyboard/shortcutDisplay";
import {
  resolveModelDisplaySelection,
  useModelAccountLookup,
  useModelEffortSegment,
  useModelPillLabel,
} from "@src/hooks/models";
import type { ModelEffortSegmentState } from "@src/hooks/models/useModelEffortSegment";
import { AiSettingIcon, FlashIcon, HugeiconsIcon } from "@src/icons";
import type { LastModelSelection } from "@src/store/session/creatorDefaultModelAtom";
import { formatModelNameFull } from "@src/util/formatModelName";
import {
  MODEL_REASONING_LEVEL,
  formatReasoningLevel,
} from "@src/util/modelVariants";

import ModelSettingsMenu from "./ModelSettingsMenu";

interface ModelSelectorPillProps {
  selection: LastModelSelection | null | undefined;
  defaultLabel: string;
  active: boolean;
  onClick: () => void;
  /** When set, an effort segment is shown and wired to variant apply. */
  onVariantApply?: (nextModelId: string) => void;
  className?: string;
  /** Classes applied to the trigger button (not the PillGroup wrapper). */
  triggerClassName?: string;
  /** Drop left padding on the trigger so the icon lines up with editor text. */
  triggerLeadingFlush?: boolean;
  dataTestId?: string;
  effortDataTestId?: string;
  ariaLabel?: string;
  iconSize?: number;
  /** When false (browsing a historical session), skip variant resolution
   *  so the pill shows the session's original model, not a remapped variant. */
  isActiveSession?: boolean;
  /** Remote/mobile callers without KeyVault can supply effort state derived
   *  from their own model catalog instead of the internal KeyVault hook. */
  effortSegmentOverride?: ModelEffortSegmentState;
  /** Mobile opens the detailed Effort/Speed menu instead of the slider. */
  settingsMenuDefaultAdvanced?: boolean;
  /** Mobile uses the combined settings menu whenever variant rows exist. */
  preferCombinedSettingsMenu?: boolean;
  /** Prevent opening a picker while its execution inventory is unresolved. */
  disabled?: boolean;
}

const ModelSelectorPill = forwardRef<HTMLButtonElement, ModelSelectorPillProps>(
  (
    {
      selection,
      defaultLabel,
      active,
      onClick,
      onVariantApply,
      className,
      triggerClassName,
      triggerLeadingFlush = false,
      dataTestId,
      effortDataTestId = "chat-model-pill-effort",
      ariaLabel,
      iconSize = PILL_SM_ICON_SIZE,
      isActiveSession = false,
      effortSegmentOverride,
      settingsMenuDefaultAdvanced = false,
      preferCombinedSettingsMenu = false,
      disabled = false,
    },
    ref
  ) => {
    const modelSegmentRef = useRef<HTMLButtonElement>(null);
    useImperativeHandle(
      ref,
      () => modelSegmentRef.current as HTMLButtonElement
    );

    const [effortOpen, setEffortOpen] = useState(false);

    const { accounts } = useModelAccountLookup();
    const displaySelection = useMemo(
      () => resolveModelDisplaySelection(selection, accounts, isActiveSession),
      [accounts, selection, isActiveSession]
    );

    const {
      label: modelLabel,
      title: modelTitle,
      accountName,
      displayParts,
    } = useModelPillLabel(displaySelection, defaultLabel);

    const modelIconName = useMemo(
      () =>
        displaySelection?.listingModel || displaySelection?.model || undefined,
      [displaySelection]
    );
    const modelIconAgent = useMemo(
      () =>
        displaySelection?.listingModelType ??
        displaySelection?.selectedSourceModelType,
      [displaySelection]
    );
    const hasModelSelection = Boolean(modelIconName);

    const resolvedModelLabel = useMemo(() => {
      if (!modelIconName) return modelLabel;
      if (modelLabel && modelLabel !== modelIconName) return modelLabel;
      return formatModelNameFull(modelIconName) || modelLabel || defaultLabel;
    }, [defaultLabel, modelIconName, modelLabel]);

    const internalEffortSegment = useModelEffortSegment({
      selection,
      isActiveSession,
      onApply: onVariantApply,
    });
    const {
      editable: effortEditable,
      effortLabel,
      effortAriaLabel,
      modelId: effortModelId,
      variantOptions,
      handleApply: handleEffortApply,
    } = effortSegmentOverride ?? internalEffortSegment;

    const handleEffortOpenChange = useCallback((open: boolean) => {
      setEffortOpen(open);
    }, []);

    const segments = useMemo((): PillGroupSegment[] => {
      const modelSegment: PillGroupSegment = {
        id: "model",
        icon: hasModelSelection ? (
          <ModelIcon
            modelName={modelIconName}
            agentType={modelIconAgent}
            size={iconSize}
          />
        ) : (
          <HugeiconsIcon
            icon={AiSettingIcon}
            data-icon="ai-setting"
            size={iconSize}
            strokeWidth={1.75}
            className="text-primary-6"
          />
        ),
        label: resolvedModelLabel,
        title: modelTitle,
        tooltip: (
          <ModelPillTooltipContent
            accountName={accountName}
            modelLabel={displayParts.rawValue ?? displayParts.label}
            modelId={modelIconName}
            modelType={modelIconAgent}
            variantInfo={
              displayParts.rawValue ? undefined : displayParts.variantInfo
            }
            thinking={displayParts.rawValue ? false : displayParts.thinking}
            shortcut={getShortcutKeys("open_model_selector")}
          />
        ),
        tooltipFramed: true,
        tooltipFramedWide: true,
        ariaLabel: ariaLabel ?? defaultLabel,
        active,
        danger: !disabled && !hasModelSelection,
        disabled,
        onClick,
        dataTestId: dataTestId,
        buttonRef: modelSegmentRef,
        maxLabelWidth: 220,
        leadingFlush: triggerLeadingFlush,
      };

      if (disabled || !effortEditable || !effortModelId) {
        return [modelSegment];
      }

      const effortSegment: PillGroupSegment = {
        id: "effort",
        icon: null,
        label: effortLabel,
        title: effortLabel,
        tooltip: effortAriaLabel,
        ariaLabel: effortAriaLabel,
        active: effortOpen,
        dataTestId: effortDataTestId,
        maxLabelWidth: 140,
        renderButton: (buttonProps) => (
          <ModelPropertiesDropdown
            variantOptions={variantOptions}
            value={effortModelId}
            onChange={handleEffortApply}
            onOpenChange={handleEffortOpenChange}
            renderTrigger={({
              ref: triggerRef,
              onClick: openEffort,
              ariaExpanded,
            }) => (
              <SelectorPill
                ref={triggerRef}
                icon={null}
                textOnly
                label={effortLabel}
                title={effortLabel}
                tooltip={effortAriaLabel}
                active={buttonProps.active || ariaExpanded}
                className={buttonProps.segmentClassName}
                labelClassName="text-[11px] font-normal text-text-2"
                onClick={openEffort}
                onMouseDown={buttonProps.onMouseDown}
                onMouseEnter={buttonProps.onMouseEnter}
                onMouseLeave={buttonProps.onMouseLeave}
                onFocus={buttonProps.onFocus}
                onBlur={buttonProps.onBlur}
                dataTestId={effortDataTestId}
                ariaLabel={effortAriaLabel}
                labelStyle={{ maxWidth: 140 }}
                size="sm"
              />
            )}
          />
        ),
      };

      return [modelSegment, effortSegment];
    }, [
      accountName,
      active,
      ariaLabel,
      dataTestId,
      defaultLabel,
      disabled,
      displayParts.label,
      displayParts.rawValue,
      displayParts.thinking,
      displayParts.variantInfo,
      effortAriaLabel,
      effortDataTestId,
      effortEditable,
      effortLabel,
      effortModelId,
      effortOpen,
      handleEffortApply,
      handleEffortOpenChange,
      hasModelSelection,
      iconSize,
      modelIconAgent,
      modelIconName,
      modelTitle,
      onClick,
      resolvedModelLabel,
      triggerLeadingFlush,
      variantOptions,
    ]);

    const variant = effortModelId
      ? variantOptions.parseSelection(effortModelId)
      : undefined;
    const canEditVariants =
      variantOptions.availableLevels.length > 1 ||
      variantOptions.fastAvailableAnywhere ||
      variantOptions.thinkingToggleable;
    const useCombinedSettingsMenu =
      !disabled &&
      preferCombinedSettingsMenu &&
      Boolean(effortModelId) &&
      canEditVariants;
    const useSliderSettingsMenu =
      !disabled &&
      !preferCombinedSettingsMenu &&
      effortEditable &&
      Boolean(effortModelId) &&
      Boolean(variant) &&
      variantOptions.availableLevels.length > 1;
    if ((useCombinedSettingsMenu || useSliderSettingsMenu) && effortModelId) {
      return (
        <ModelSettingsMenu
          anchorRef={modelSegmentRef}
          modelLabel={resolvedModelLabel}
          value={effortModelId}
          variantOptions={variantOptions}
          onModelClick={onClick}
          onChange={handleEffortApply}
          defaultAdvanced={settingsMenuDefaultAdvanced}
          renderTrigger={({ open, onClick: openMenu, previewLevel }) => {
            // While the effort slider is dragged the pill reports the level
            // under the thumb, so the panel is not the only place showing
            // where the gesture has landed. It falls back to the saved level
            // the moment the gesture ends.
            const shownLevel = previewLevel ?? variant?.level;
            const levelLabel = shownLevel
              ? formatReasoningLevel(shownLevel)
              : effortLabel;
            const combinedLabel = `${resolvedModelLabel} ${levelLabel}`;
            const levelToneClass =
              shownLevel === MODEL_REASONING_LEVEL.ULTRA
                ? "text-purple-6"
                : open
                  ? "text-primary-6"
                  : "text-text-3";
            return (
              <SelectorPill
                ref={modelSegmentRef}
                icon={
                  variant?.fast ? (
                    <HugeiconsIcon
                      icon={FlashIcon}
                      data-icon="fast"
                      size={iconSize}
                    />
                  ) : (
                    segments[0].icon
                  )
                }
                label={combinedLabel}
                labelContent={
                  <>
                    <span className="truncate font-medium">
                      {resolvedModelLabel}
                    </span>
                    <span
                      className={`ml-1 shrink-0 font-normal ${levelToneClass}`}
                    >
                      {levelLabel}
                    </span>
                  </>
                }
                title={modelTitle}
                tooltip={segments[0].tooltip}
                tooltipFramed
                tooltipFramedWide
                active={active || open}
                activeTone="neutral"
                ariaExpanded={open}
                ariaLabel={`${ariaLabel ?? defaultLabel}: ${combinedLabel}${variant?.fast ? " · Fast" : ""}`}
                dataTestId={dataTestId}
                className={`shrink-0 ${triggerClassName ?? ""} ${className ?? ""}`}
                leadingFlush={triggerLeadingFlush}
                onClick={openMenu}
              />
            );
          }}
        />
      );
    }

    return (
      <PillGroup
        segments={segments}
        className={`shrink-0 text-[13px] ${className ?? ""}`}
        segmentClassName={`h-[28px] ${triggerClassName ?? ""}`.trim()}
      />
    );
  }
);

ModelSelectorPill.displayName = "ModelSelectorPill";

export default ModelSelectorPill;
