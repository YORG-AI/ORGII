import React, { useMemo } from "react";
import { createPortal } from "react-dom";

import DropdownSelectedCheck from "@src/components/Dropdown/DropdownSelectedCheck";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_PANEL,
} from "@src/components/Dropdown/tokens";
import { SURFACE_TOKENS } from "@src/config/surfaceTokens";
import { REPLAY_SPEED_OPTIONS } from "@src/config/workspace/replayConfig";
import { getDropdownPanelStyle } from "@src/hooks/dropdown/dropdownPanelStyle";
import { useDropdownEngine } from "@src/hooks/dropdown/useDropdownEngine";

import { STATUS_BAR_TEXT_20 } from "./tokens";

interface PlaybackSpeedInlineProps {
  value: number;
  onChange: (speed: number) => void;
  disabled: boolean;
}

export const PlaybackSpeedInline: React.FC<PlaybackSpeedInlineProps> = ({
  value,
  onChange,
  disabled,
}) => {
  const {
    isOpen,
    isPositioned,
    triggerRef,
    panelRef,
    panelPosition,
    toggle,
    close,
  } = useDropdownEngine<HTMLButtonElement>({
    placement: "top",
    align: "right",
    disabled,
    gap: DROPDOWN_PANEL.triggerGapTight,
  });

  const panelPositionStyle = useMemo(
    () => getDropdownPanelStyle(panelPosition),
    [panelPosition]
  );

  const label = `${value}x`;

  return (
    <>
      <button
        data-testid="session-replay-speed-trigger"
        ref={triggerRef as React.Ref<HTMLButtonElement>}
        type="button"
        disabled={disabled}
        onClick={toggle}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        className={`${STATUS_BAR_TEXT_20} ml-1 shrink-0 transform-gpu justify-center rounded-full px-2 tabular-nums disabled:cursor-not-allowed disabled:opacity-40 ${
          isOpen
            ? "bg-fill-3 text-primary-6"
            : `text-text-2 ${SURFACE_TOKENS.hover} hover:text-primary-6`
        }`}
      >
        {label}
      </button>
      {isOpen &&
        isPositioned &&
        createPortal(
          <div
            ref={panelRef as React.Ref<HTMLDivElement>}
            className={`${DROPDOWN_CLASSES.menuPanelBase} fixed min-w-[80px] overflow-y-auto`}
            style={panelPositionStyle}
          >
            <div
              className={`flex flex-col ${DROPDOWN_PANEL.itemsGapClass}`}
              role="listbox"
            >
              {REPLAY_SPEED_OPTIONS.map((speed) => {
                const selected = speed === value;
                return (
                  <button
                    key={speed}
                    data-testid={`session-replay-speed-${speed}`}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    className={`${DROPDOWN_CLASSES.item} ${
                      selected
                        ? DROPDOWN_CLASSES.itemSelected
                        : DROPDOWN_CLASSES.itemHover
                    } w-full justify-between tabular-nums`}
                    onClick={() => {
                      onChange(speed);
                      close();
                    }}
                  >
                    <span>{speed}x</span>
                    {selected && <DropdownSelectedCheck />}
                  </button>
                );
              })}
            </div>
          </div>,
          document.body
        )}
    </>
  );
};
