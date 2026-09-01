/**
 * ModelPropertiesDropdown
 *
 * Model effort and option controls apply changes immediately through the
 * caller's existing save path. Closing the popover only dismisses it.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
  DROPDOWN_PANEL,
} from "@src/components/Dropdown/exports";
import { EffortSlider } from "@src/components/ModelPropertiesDropdown/EffortSlider";
import Switch from "@src/components/Switch";
import { useDropdownEngine } from "@src/hooks/dropdown";
import { BrainIcon, FlashIcon, HugeiconsIcon } from "@src/icons";
import {
  type ModelReasoningLevel,
  getModelVariantBaseModel,
} from "@src/util/modelVariants";
import { getViewportSize } from "@src/util/ui/window/viewport";
import {
  type VariantEditOptions,
  type VariantSelection,
} from "@src/util/variantEditOptions";

const SIDE_PANEL_GAP = 8;
const MODEL_PROPERTIES_PANEL_WIDTH = 260;
const MODEL_PROPERTIES_PANEL_EST_HEIGHT = 220;
const VIEWPORT_MARGIN = 12;
const SIDE_PANEL_ANCHOR_CHANGE_EVENT = "dropdown-side-panel-anchor-change";
const MODEL_PROPERTIES_CLOSE_EVENT = "model-properties-dropdown-close";

// ============ TYPES ============

interface ModelPropertiesDropdownProps {
  /**
   * Trigger element. Receives a `ref`, click handler and `aria-expanded`
   * via render-prop so callers can use any clickable element (icon
   * button, pill, link).
   */
  renderTrigger: (props: {
    ref: React.Ref<HTMLButtonElement>;
    onClick: (event: React.MouseEvent) => void;
    isOpen: boolean;
    ariaExpanded: boolean;
  }) => React.ReactNode;
  /**
   * Output of `buildVariantEditOptions(family.modelIds)`. Drives which
   * levels appear and which `fast` toggles are enabled.
   */
  variantOptions: VariantEditOptions;
  /** Current model id; the caller owns and persists the selection. */
  value: string;
  /** Called once per completed slider interaction or option toggle. */
  onChange: (modelId: string) => void;
  /** Fires whenever the dropdown opens or closes. */
  onOpenChange?: (open: boolean) => void;
  /**
   * Optional disabled flag. When `true`, the trigger should also visibly
   * convey the disabled state (callers control that styling).
   */
  disabled?: boolean;
  /**
   * When `true`, the panel is positioned at the vertical and horizontal
   * center of the closest `[data-spotlight-container]` ancestor of the
   * trigger (falls back to the viewport). Useful for spotlight-anchored
   * dropdowns where the trigger sits near the edge.
   */
  centerInContainer?: boolean;
  /**
   * Positions the panel at the closest dropdown side-panel anchor.
   * Used by compact model dropdown rows so variant edits appear where the
   * secondary account menu appears, not attached to the inline pill.
   */
  sidePanelInContainer?: boolean;
}

// ============ COMPONENT ============

export const ModelPropertiesDropdown: React.FC<
  ModelPropertiesDropdownProps
> = ({
  renderTrigger,
  variantOptions,
  value,
  onChange,
  onOpenChange,
  disabled = false,
  centerInContainer = false,
  sidePanelInContainer = false,
}) => {
  const engine = useDropdownEngine<HTMLButtonElement>({
    placement: "auto",
    align: "left",
    closeOnEsc: true,
    closeOnClickOutside: true,
    // Native range and switch controls own their keyboard interactions.
    autoKeyboardNavigation: false,
    disabled,
  });

  const { isOpen, isPositioned, panelRef, panelPosition, close, toggle } =
    engine;

  const [centeredStyle, setCenteredStyle] =
    useState<React.CSSProperties | null>(null);

  // The engine optimistically flips `isPositioned` true on its first
  // synchronous compute, which uses a height *estimate* (`panelRef` is
  // null pre-mount). It then re-measures on the next animation frame
  // and may flip placement top ↔ bottom if the real height disagrees
  // with the estimate. To prevent that visible jump we render the
  // panel as soon as `isOpen`, but keep it `visibility: hidden` until
  // the engine has run its RAF re-position against the mounted panel.
  //
  // The cleanup branch resets `panelMeasured` to false (no synchronous
  // setState in the effect body — the lint rule
  // `react-hooks/set-state-in-effect` forbids that) so the next open
  // starts unmeasured.
  const [panelMeasured, setPanelMeasured] = useState(false);
  useEffect(() => {
    if (!isOpen) return;
    const frame = window.requestAnimationFrame(() => {
      setPanelMeasured(true);
    });
    return () => {
      window.cancelAnimationFrame(frame);
      setPanelMeasured(false);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleCloseRequest = (event: Event) => {
      const trigger = engine.triggerRef.current;
      const hoveredElement = (
        event as CustomEvent<{ hoveredElement?: HTMLElement }>
      ).detail?.hoveredElement;
      if (trigger && hoveredElement?.contains(trigger)) return;
      close();
    };
    window.addEventListener(MODEL_PROPERTIES_CLOSE_EVENT, handleCloseRequest);
    return () => {
      window.removeEventListener(
        MODEL_PROPERTIES_CLOSE_EVENT,
        handleCloseRequest
      );
    };
  }, [close, engine.triggerRef, isOpen]);

  useEffect(() => {
    // While the panel is closed (or custom positioning is off) the stale
    // style is never read. The effect recomputes on the next open, so there
    // is no need to clear state here.
    if ((!centerInContainer && !sidePanelInContainer) || !isOpen) {
      return;
    }
    const compute = () => {
      const trigger = engine.triggerRef.current;
      const panelHeight =
        panelRef.current?.getBoundingClientRect().height ||
        MODEL_PROPERTIES_PANEL_EST_HEIGHT;
      const centeredZ = Math.max(DROPDOWN_PANEL.zIndex, 10000);

      if (sidePanelInContainer) {
        const container =
          trigger?.closest<HTMLElement>("[data-dropdown-side-panel-anchor]") ??
          null;
        const sideLeft = Number(container?.dataset.dropdownSidePanelLeft);
        const sideTop = Number(container?.dataset.dropdownSidePanelTop);
        const sideHeight = Number(container?.dataset.dropdownSidePanelHeight);
        if (
          Number.isFinite(sideLeft) &&
          Number.isFinite(sideTop) &&
          Number.isFinite(sideHeight)
        ) {
          const belowTop = sideTop + sideHeight + SIDE_PANEL_GAP;
          const aboveTop = sideTop - panelHeight - SIDE_PANEL_GAP;
          const { height: vh } = getViewportSize();
          const fitsBelow = belowTop + panelHeight <= vh - VIEWPORT_MARGIN;
          const preferredTop = fitsBelow ? belowTop : aboveTop;
          setCenteredStyle({
            position: "fixed",
            top: Math.max(
              VIEWPORT_MARGIN,
              Math.min(preferredTop, vh - VIEWPORT_MARGIN - panelHeight)
            ),
            left: sideLeft,
            zIndex: centeredZ + 1,
          });
          return;
        }
        const modelRow = trigger?.closest<HTMLElement>(
          "[data-dropdown-model-row-anchor]"
        );
        const mainPanel = trigger?.closest<HTMLElement>(
          "[data-dropdown-main-panel-anchor]"
        );
        if (modelRow && mainPanel) {
          const rowRect = modelRow.getBoundingClientRect();
          const panelRect = mainPanel.getBoundingClientRect();
          const { width: vw, height: vh } = getViewportSize();
          const rightLeft = panelRect.right + SIDE_PANEL_GAP;
          const leftLeft =
            panelRect.left - MODEL_PROPERTIES_PANEL_WIDTH - SIDE_PANEL_GAP;
          const fitsRight =
            rightLeft + MODEL_PROPERTIES_PANEL_WIDTH <= vw - VIEWPORT_MARGIN;
          const preferredLeft = fitsRight ? rightLeft : leftLeft;
          setCenteredStyle({
            position: "fixed",
            top: Math.max(
              VIEWPORT_MARGIN,
              Math.min(rowRect.top, vh - VIEWPORT_MARGIN - panelHeight)
            ),
            left: Math.max(
              VIEWPORT_MARGIN,
              Math.min(
                preferredLeft,
                vw - VIEWPORT_MARGIN - MODEL_PROPERTIES_PANEL_WIDTH
              )
            ),
            zIndex: centeredZ + 1,
          });
          return;
        }

        setCenteredStyle(null);
      }

      const container =
        trigger?.closest<HTMLElement>("[data-spotlight-container]") ?? null;
      const rect = container?.getBoundingClientRect();
      // Lift above the spotlight container (z=9999) so the centered
      // panel sits in front of the spotlight chrome that anchors it.
      if (rect) {
        setCenteredStyle({
          position: "fixed",
          top: rect.top + rect.height / 2,
          left: rect.left + rect.width / 2,
          transform: "translate(-50%, -50%)",
          zIndex: centeredZ,
        });
      } else {
        setCenteredStyle({
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          zIndex: centeredZ,
        });
      }
    };
    compute();
    window.addEventListener("resize", compute);
    window.addEventListener("scroll", compute, true);
    window.addEventListener(SIDE_PANEL_ANCHOR_CHANGE_EVENT, compute);
    return () => {
      window.removeEventListener("resize", compute);
      window.removeEventListener("scroll", compute, true);
      window.removeEventListener(SIDE_PANEL_ANCHOR_CHANGE_EVENT, compute);
    };
  }, [
    centerInContainer,
    sidePanelInContainer,
    isOpen,
    engine.triggerRef,
    panelRef,
    value,
  ]);

  const selection = useMemo(
    () => variantOptions.parseSelection(value),
    [value, variantOptions]
  );
  const availableLevels = variantOptions.getAvailableLevels(selection.level);

  const changeSelection = useCallback(
    (next: VariantSelection) => {
      // Moving to a level without Fast support also clears Fast. Always
      // resolve the complete combination before reaching the save boundary.
      const normalized = {
        ...next,
        fast: next.fast && variantOptions.fastAvailable(next),
      };
      const modelId = variantOptions.resolveVariantId(normalized);
      if (modelId && modelId !== value) onChange(modelId);
    },
    [onChange, value, variantOptions]
  );

  const handleThinkingToggle = (thinking: boolean) =>
    changeSelection({ ...selection, thinking });
  const handleFastToggle = (fast: boolean) =>
    changeSelection({ ...selection, fast });
  const handleLevelSelect = (level: ModelReasoningLevel) =>
    changeSelection({ ...selection, level });

  useEffect(() => {
    onOpenChange?.(isOpen);
  }, [isOpen, onOpenChange]);

  // Thinking row is shown only when the family contains BOTH a
  // thinking and a non-thinking variant — i.e. the toggle is
  // meaningful. Fast row is shown only when a fast variant is
  // reachable from the current (thinking, level) selection, so users
  // never see a non-actionable switch.
  const showThinkingRow = variantOptions.thinkingToggleable;
  const showFastRow = useMemo(
    () =>
      variantOptions.fastAvailableAnywhere &&
      variantOptions.fastAvailable(selection),
    [selection, variantOptions]
  );

  const trigger = renderTrigger({
    ref: engine.triggerRef,
    onClick: (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!disabled) toggle();
    },
    isOpen,
    ariaExpanded: isOpen,
  });

  // Anchor the left edge so changes to the effort label's width do not
  // move the panel sideways. The engine still clamps it to the viewport.
  //
  // We use `position: fixed` because the panel is portaled to
  // `document.body` and the engine emits viewport-relative coordinates
  // (`getBoundingClientRect()` + `window.innerHeight`). With
  // `position: absolute` the offsets would resolve against the body,
  // so any page scroll would shift the panel away from the trigger.
  const usesCustomPosition =
    centerInContainer || (sidePanelInContainer && centeredStyle !== null);
  const positionStyle: React.CSSProperties = usesCustomPosition
    ? (centeredStyle ?? {})
    : {
        position: "fixed",
        top: panelPosition.top,
        bottom: panelPosition.bottom,
        left: panelPosition.left,
        zIndex: DROPDOWN_PANEL.zIndex,
      };

  // Render the panel as soon as the engine is open so the engine can
  // measure its real height on the next animation frame. Until both
  // the engine has computed a position AND the post-mount RAF
  // re-measurement has run, keep the panel invisible — that way
  // users never see the panel flash at the estimate-based position
  // before snapping to the measured one.
  const hasPosition = usesCustomPosition
    ? centeredStyle !== null
    : isPositioned && panelMeasured;
  const panelStyle: React.CSSProperties = hasPosition
    ? positionStyle
    : { ...positionStyle, visibility: "hidden", pointerEvents: "none" };

  const panel = isOpen && (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Model properties"
      className={`${DROPDOWN_CLASSES.panel} flex w-[260px] flex-col`}
      style={panelStyle}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      {/* Effort / Reasoning section (above Options). The lightweight
          slider keeps the same discrete model variants while making the
          choice feel faster than a menu of rows. */}
      {availableLevels.length > 0 && (
        <div className={`${DROPDOWN_CLASSES.sectionContainer} last:border-b-0`}>
          <EffortSlider
            key={getModelVariantBaseModel(value)}
            levels={availableLevels}
            value={selection.level}
            onChange={handleLevelSelect}
            fast={showFastRow && selection.fast}
            animate={hasPosition}
          />
        </div>
      )}

      {/* Thinking / Fast switches stay hidden when the family or current
          selection doesn't expose that dimension. */}
      {(showThinkingRow || showFastRow) && (
        <div className={`${DROPDOWN_CLASSES.sectionContainer} last:border-b-0`}>
          {showThinkingRow && (
            <SwitchRow
              icon={
                <HugeiconsIcon
                  icon={BrainIcon}
                  data-icon="brain"
                  size={DROPDOWN_ITEM.iconSize}
                  className="text-text-2"
                />
              }
              label="Thinking"
              checked={selection.thinking}
              onChange={handleThinkingToggle}
            />
          )}
          {showFastRow && (
            <SwitchRow
              icon={
                <HugeiconsIcon
                  icon={FlashIcon}
                  data-icon="zap"
                  size={DROPDOWN_ITEM.iconSize}
                  className="text-text-2"
                />
              }
              label="Fast"
              checked={selection.fast}
              onChange={handleFastToggle}
            />
          )}
        </div>
      )}
    </div>
  );

  return (
    <>
      {trigger}
      {panel ? createPortal(panel, document.body) : null}
    </>
  );
};

// ============ INTERNAL ============

interface SwitchRowProps {
  icon?: React.ReactNode;
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}

const SwitchRow: React.FC<SwitchRowProps> = ({
  icon,
  label,
  checked,
  onChange,
}) => (
  <div className={DROPDOWN_CLASSES.menuControlItem}>
    <span className="flex items-center gap-1.5">
      {icon}
      {label}
    </span>
    <Switch
      checked={checked}
      onCheckedChange={onChange}
      ariaLabel={label}
      size="small"
    />
  </div>
);

export default ModelPropertiesDropdown;
