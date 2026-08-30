/**
 * EnvironmentKindRow — the session-environment "Local / Cloud" scope row.
 * Opens a running-location style dropdown to the row's left (mirroring
 * `RunningLocationDropdownPanel`); the cloud option stays disabled until a
 * location switcher is wired up.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";

import AnyIcon from "@src/components/AnyIcon";
import Dropdown from "@src/components/Dropdown";
import DropdownSelectedCheck from "@src/components/Dropdown/DropdownSelectedCheck";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
} from "@src/components/Dropdown/tokens";
import { CloudIcon, LaptopIcon } from "@src/icons";

import { WorkspaceContextRow } from "./WorkspaceContextRow";

export type EnvironmentKind = "local" | "cloud";

const ENVIRONMENT_KIND_OPTIONS = [
  {
    id: "local",
    icon: LaptopIcon,
    labelKey: "common:workstation.sessionEnvLocal",
    disabled: false,
  },
  {
    id: "cloud",
    icon: CloudIcon,
    labelKey: "common:workstation.sessionEnvCloud",
    disabled: true,
  },
] as const;

export function EnvironmentKindRow({
  compact = false,
  kind,
}: {
  compact?: boolean;
  kind: EnvironmentKind;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const rowIcon = kind === "cloud" ? CloudIcon : LaptopIcon;
  const rowLabel = t(
    kind === "cloud"
      ? "common:workstation.sessionEnvCloud"
      : "common:workstation.sessionEnvLocal"
  );

  // The compact menu presentation keeps the row passive: nesting a second
  // dropdown inside the menu panel is not supported.
  if (compact) {
    return (
      <WorkspaceContextRow compact icon={rowIcon} label={rowLabel} chevron />
    );
  }

  return (
    <div className="[&_.dropdown-trigger-wrapper]:block [&_.dropdown-trigger-wrapper]:w-full">
      {/* Portal to the body: the trail body is an overflow container that
          would clip an absolutely-positioned panel. `left` centers the panel
          on the row, matching the shortcut tooltips. */}
      <Dropdown
        position="left"
        getPopupContainer={() => document.body}
        popupVisible={open}
        onVisibleChange={setOpen}
        className={`${DROPDOWN_CLASSES.panelAnimated} w-[180px]`}
        droplist={
          <div className={DROPDOWN_CLASSES.optionsContainer}>
            {ENVIRONMENT_KIND_OPTIONS.map((option) => {
              const isSelected = option.id === kind;
              return (
                <button
                  key={option.id}
                  type="button"
                  disabled={option.disabled}
                  className={`${DROPDOWN_CLASSES.item} ${
                    option.disabled
                      ? "cursor-not-allowed opacity-40"
                      : isSelected
                        ? DROPDOWN_CLASSES.itemSelected
                        : DROPDOWN_CLASSES.itemHover
                  } w-full justify-between`}
                  onClick={() => setOpen(false)}
                >
                  <div className="flex items-center gap-2">
                    <AnyIcon
                      icon={option.icon}
                      size={DROPDOWN_ITEM.iconSize}
                      strokeWidth={1.75}
                    />
                    <span>{t(option.labelKey)}</span>
                  </div>
                  {isSelected && <DropdownSelectedCheck />}
                </button>
              );
            })}
          </div>
        }
      >
        {/* Toggling is owned by the Dropdown trigger wrapper; the row's own
            onClick only opts it into button rendering (hover + active). */}
        <WorkspaceContextRow
          icon={rowIcon}
          label={rowLabel}
          chevron
          active={open}
          onClick={() => {}}
        />
      </Dropdown>
    </div>
  );
}
