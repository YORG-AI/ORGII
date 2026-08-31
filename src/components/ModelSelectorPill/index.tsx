/**
 * ModelSelectorPill
 *
 * Shared model selector trigger used by the active chat input and the
 * SessionCreator input. Renders as a {@link PillGroup}: model name on
 * the left, effort/variant on the right (when editable). Each segment
 * opens its own picker — model palette vs {@link ModelPropertiesDropdown}.
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
import { AiSettingIcon, HugeiconsIcon } from "@src/icons";
import type { LastModelSelection } from "@src/store/session/creatorDefaultModelAtom";

export interface ModelSelectorPillProps {
  selection: LastModelSelection | null | undefined;
  defaultLabel: string;
  active: boolean;
  onClick: () => void;
  /** When set, an effort segment is shown and wired to variant apply. */
  onVariantApply?: (nextModelId: string) => void;
  className?: string;
  dataTestId?: string;
  effortDataTestId?: string;
  ariaLabel?: string;
  iconSize?: number;
  /** When false (browsing a historical session), skip variant resolution
   *  so the pill shows the session's original model, not a remapped variant. */
  isActiveSession?: boolean;
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
      dataTestId,
      effortDataTestId = "chat-model-pill-effort",
      ariaLabel,
      iconSize = PILL_SM_ICON_SIZE,
      isActiveSession = false,
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

    const {
      editable: effortEditable,
      effortLabel,
      effortAriaLabel,
      modelId: effortModelId,
      variantOptions,
      handleApply: handleEffortApply,
    } = useModelEffortSegment({
      selection,
      isActiveSession,
      onApply: onVariantApply,
    });

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
        label: modelLabel,
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
        danger: !hasModelSelection,
        onClick,
        dataTestId: dataTestId,
        buttonRef: modelSegmentRef,
        maxLabelWidth: 220,
      };

      if (!effortEditable || !effortModelId) {
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
      modelLabel,
      modelTitle,
      onClick,
      variantOptions,
    ]);

    return (
      <PillGroup
        segments={segments}
        className={`shrink-0 text-[13px] ${className ?? ""}`}
        segmentClassName="h-[28px]"
      />
    );
  }
);

ModelSelectorPill.displayName = "ModelSelectorPill";

export default ModelSelectorPill;
