import { useAtom } from "jotai";
import { ListFilter } from "lucide-react";
import React, { useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import Checkbox from "@src/components/Checkbox";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_PANEL,
} from "@src/components/Dropdown/tokens";
import { SURFACE_TOKENS } from "@src/config/surfaceTokens";
import {
  SIMULATOR_EVENT_FILTER_VALUES,
  type SimulatorEventFilterValue,
} from "@src/engines/SessionCore/derived/simulatorEventFilters";
import { useDropdownEngine } from "@src/hooks/dropdown/useDropdownEngine";
import { simulatorEventFiltersAtom } from "@src/store/ui/simulatorAtom";

const FILTER_LABEL_KEYS: Record<SimulatorEventFilterValue, string> = {
  key_interactions: "simulator.replay.filters.keyInteractions",
  file_changes: "simulator.replay.filters.fileChanges",
  terminal_events: "simulator.replay.filters.terminalEvents",
  explore: "simulator.replay.filters.explore",
  other: "simulator.replay.filters.other",
};

const FILTER_LABEL_FALLBACKS: Record<SimulatorEventFilterValue, string> = {
  key_interactions: "Key interactions",
  file_changes: "File changes",
  terminal_events: "Terminal events",
  explore: "Explore",
  other: "Other",
};

interface EventFilterDropdownProps {
  variant?: "default" | "primary";
  iconOnly?: boolean;
}

export const EventFilterDropdown: React.FC<EventFilterDropdownProps> = ({
  variant = "default",
  iconOnly = false,
}) => {
  const { t } = useTranslation("sessions");
  const [selectedFilters, setSelectedFilters] = useAtom(
    simulatorEventFiltersAtom
  );
  const selectedFilterSet = useMemo(
    () => new Set(selectedFilters),
    [selectedFilters]
  );
  const isAllEvents = selectedFilters.length === 0;

  const { isOpen, isPositioned, triggerRef, panelRef, panelPosition, toggle } =
    useDropdownEngine<HTMLButtonElement>({
      placement: "top",
      align: "right",
      gap: DROPDOWN_PANEL.triggerGapTight,
    });

  const panelPositionStyle = useMemo(() => {
    const pos = panelPosition;
    return {
      ...(pos.top !== undefined
        ? { top: `${pos.top}px` }
        : { bottom: `${pos.bottom}px` }),
      ...(pos.right !== undefined
        ? { right: `${pos.right}px` }
        : { left: `${pos.left}px` }),
      ...(pos.width > 0 ? { minWidth: `${pos.width}px` } : {}),
    };
  }, [panelPosition]);

  const triggerLabel = isAllEvents
    ? t("simulator.replay.filters.allEvents", "All events")
    : selectedFilters.length === 1
      ? t(
          FILTER_LABEL_KEYS[selectedFilters[0]],
          FILTER_LABEL_FALLBACKS[selectedFilters[0]]
        )
      : t("simulator.replay.filters.selectedCount", "{{count}} filters", {
          count: selectedFilters.length,
        });

  const handleSelectAll = useCallback(() => {
    setSelectedFilters([]);
  }, [setSelectedFilters]);

  const handleToggleFilter = useCallback(
    (filter: SimulatorEventFilterValue) => {
      setSelectedFilters((current) =>
        current.includes(filter)
          ? current.filter((item) => item !== filter)
          : [...current, filter]
      );
    },
    [setSelectedFilters]
  );

  const handleOptionKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>, action: () => void) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      action();
    },
    []
  );

  const triggerToneClass =
    variant === "primary"
      ? isOpen || !isAllEvents
        ? "bg-white/15 text-white"
        : "text-white hover:bg-white/15 hover:text-white"
      : isOpen || !isAllEvents
        ? "bg-fill-3 text-primary-6"
        : `text-text-2 ${SURFACE_TOKENS.hover} hover:text-primary-6`;

  return (
    <>
      <button
        ref={triggerRef as React.Ref<HTMLButtonElement>}
        type="button"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          toggle();
        }}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        aria-label={t("simulator.replay.filters.tooltip", "Filter events")}
        title={triggerLabel}
        className={`pointer-events-auto flex h-5 shrink-0 transform-gpu items-center justify-center rounded-full ${
          iconOnly ? "w-5 px-0" : "max-w-[132px] gap-1 px-1.5"
        } ${triggerToneClass}`}
      >
        <ListFilter size={12} strokeWidth={2} className="shrink-0" />
        {!iconOnly && (
          <span className="truncate text-[11px] font-medium leading-none">
            {triggerLabel}
          </span>
        )}
      </button>
      {isOpen &&
        isPositioned &&
        createPortal(
          <div
            ref={panelRef as React.Ref<HTMLDivElement>}
            className={`${DROPDOWN_CLASSES.menuPanel} fixed min-w-[180px]`}
            style={panelPositionStyle}
          >
            <div
              className={`flex flex-col ${DROPDOWN_PANEL.itemsGapClass}`}
              role="listbox"
              aria-multiselectable="true"
            >
              <div
                role="option"
                aria-selected={isAllEvents}
                tabIndex={0}
                onClick={handleSelectAll}
                onKeyDown={(event) =>
                  handleOptionKeyDown(event, handleSelectAll)
                }
                className={`${DROPDOWN_CLASSES.menuControlItem} ${
                  isAllEvents
                    ? DROPDOWN_CLASSES.itemSelected
                    : DROPDOWN_CLASSES.itemHover
                } !justify-start !text-text-1 hover:!text-text-1`}
              >
                <Checkbox
                  checked={isAllEvents}
                  size="small"
                  className="shrink-0"
                />
                <span className="flex-1 text-left">
                  {t("simulator.replay.filters.allEvents", "All events")}
                </span>
              </div>
              <div
                className={DROPDOWN_CLASSES.menuSeparator}
                role="separator"
              />
              {SIMULATOR_EVENT_FILTER_VALUES.map((filter) => {
                const selected = isAllEvents || selectedFilterSet.has(filter);
                return (
                  <div
                    key={filter}
                    role="option"
                    aria-selected={selected}
                    tabIndex={0}
                    onClick={() => handleToggleFilter(filter)}
                    onKeyDown={(event) =>
                      handleOptionKeyDown(event, () =>
                        handleToggleFilter(filter)
                      )
                    }
                    className={`${DROPDOWN_CLASSES.menuControlItem} ${
                      selected
                        ? DROPDOWN_CLASSES.itemSelected
                        : DROPDOWN_CLASSES.itemHover
                    } !justify-start !text-text-1 hover:!text-text-1`}
                  >
                    <Checkbox
                      checked={selected}
                      size="small"
                      className="shrink-0"
                    />
                    <span className="flex-1 text-left">
                      {t(
                        FILTER_LABEL_KEYS[filter],
                        FILTER_LABEL_FALLBACKS[filter]
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>,
          document.body
        )}
    </>
  );
};
