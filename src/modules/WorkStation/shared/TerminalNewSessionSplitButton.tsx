import { ChevronDown, Plus } from "lucide-react";
import React, { memo, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import { DropdownPanel } from "@src/components/Dropdown/exports";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
  DROPDOWN_WIDTHS,
} from "@src/components/Dropdown/tokens";
import { useDropdownEngine } from "@src/hooks/dropdown";
import { useAvailableShells } from "@src/hooks/terminal";
import type { ShellProfile } from "@src/types/terminal";

const SIDEBAR_ACTION_BUTTON_CLASS =
  "flex h-5 w-5 items-center justify-center rounded text-text-2 transition-colors hover:bg-surface-hover hover:text-text-1";
const SIDEBAR_SPLIT_CONTAINER_CLASS =
  "group/split flex items-center rounded transition-colors hover:bg-surface-hover";
const SIDEBAR_SPLIT_LEFT_CLASS =
  "flex h-5 w-5 items-center justify-center rounded-l text-text-2 transition-colors group-hover/split:text-text-1";
const SIDEBAR_SPLIT_RIGHT_CLASS =
  "flex h-5 items-center justify-center rounded-r px-0.5 text-text-2 transition-colors group-hover/split:text-text-1 hover:bg-fill-3";
const SIDEBAR_ICON_STROKE_WIDTH = 2.25;

export interface NewTerminalSessionOptions {
  shell?: string;
  args?: string[];
  name?: string;
  profileId?: string;
}

interface TerminalNewSessionSplitButtonProps {
  onNewTerminal: (options?: NewTerminalSessionOptions) => void;
  density?: "header" | "sidebar";
  splitMainWidth?: number;
}

const TerminalNewSessionSplitButtonComponent: React.FC<
  TerminalNewSessionSplitButtonProps
> = ({ onNewTerminal, density = "header", splitMainWidth }) => {
  const { t } = useTranslation("common");
  const { profiles: shellProfiles } = useAvailableShells();

  const {
    isOpen: isShellPickerOpen,
    isPositioned: isShellPickerPositioned,
    toggle: toggleShellPicker,
    close: closeShellPicker,
    triggerRef: shellPickerTriggerRef,
    panelRef: shellPickerDropdownRef,
    panelPosition: shellPickerPosition,
  } = useDropdownEngine<HTMLButtonElement>({
    gap: 4,
    align: "right",
    placement: "bottom",
  });

  const handlePickProfile = useCallback(
    (profile: ShellProfile) => {
      closeShellPicker();
      onNewTerminal({
        shell: profile.path,
        args: profile.args,
        name: profile.name,
        profileId: profile.id,
      });
    },
    [closeShellPicker, onNewTerminal]
  );

  const terminalTitle = t("controlTower.sidebar.newTerminal", "New Terminal");
  const hasProfilePicker = shellProfiles.length > 1;

  const shellPickerMenu = useMemo(() => {
    if (!isShellPickerOpen || !isShellPickerPositioned) return null;

    return createPortal(
      <DropdownPanel
        ref={shellPickerDropdownRef}
        className={DROPDOWN_WIDTHS.sidebarMenuClass}
        animated={false}
        maxHeight="none"
        style={{
          position: "fixed",
          top: shellPickerPosition.top,
          right: shellPickerPosition.right,
          zIndex: 9999,
        }}
      >
        <div className={DROPDOWN_CLASSES.optionsContainer}>
          {shellProfiles
            .filter((profile) => profile.category === "shell")
            .map((profile) => (
              <button
                key={profile.id}
                type="button"
                className={`${DROPDOWN_CLASSES.item} ${DROPDOWN_CLASSES.itemHover} w-full text-left`}
                onClick={() => handlePickProfile(profile)}
              >
                <span className="flex-1 truncate">{profile.name}</span>
                {profile.isDefault && (
                  <span className="text-xs text-text-3">
                    {t("common:common.default", "Default")}
                  </span>
                )}
              </button>
            ))}
          {shellProfiles.some((profile) => profile.category === "repl") && (
            <>
              <div className="my-1 border-t border-solid border-border-2" />
              {shellProfiles
                .filter((profile) => profile.category === "repl")
                .map((profile) => (
                  <button
                    key={profile.id}
                    type="button"
                    className={`${DROPDOWN_CLASSES.item} ${DROPDOWN_CLASSES.itemHover} w-full text-left`}
                    onClick={() => handlePickProfile(profile)}
                  >
                    <span className="flex-1 truncate">{profile.name}</span>
                  </button>
                ))}
            </>
          )}
        </div>
      </DropdownPanel>,
      document.body
    );
  }, [
    handlePickProfile,
    isShellPickerOpen,
    isShellPickerPositioned,
    shellPickerDropdownRef,
    shellPickerPosition,
    shellProfiles,
    t,
  ]);

  if (density === "sidebar") {
    if (!hasProfilePicker) {
      return (
        <button
          type="button"
          className={SIDEBAR_ACTION_BUTTON_CLASS}
          onClick={(event) => {
            event.stopPropagation();
            onNewTerminal();
          }}
          title={terminalTitle}
        >
          <Plus
            size={DROPDOWN_ITEM.iconSize}
            strokeWidth={SIDEBAR_ICON_STROKE_WIDTH}
          />
        </button>
      );
    }

    return (
      <div
        className={`${SIDEBAR_SPLIT_CONTAINER_CLASS} ${isShellPickerOpen ? "bg-fill-2" : ""}`}
      >
        <button
          type="button"
          className={`${SIDEBAR_SPLIT_LEFT_CLASS} ${isShellPickerOpen ? "text-text-1" : ""}`}
          onClick={(event) => {
            event.stopPropagation();
            onNewTerminal();
          }}
          title={terminalTitle}
        >
          <Plus
            size={DROPDOWN_ITEM.iconSize}
            strokeWidth={SIDEBAR_ICON_STROKE_WIDTH}
          />
        </button>
        <button
          ref={shellPickerTriggerRef}
          type="button"
          className={`${SIDEBAR_SPLIT_RIGHT_CLASS} ${isShellPickerOpen ? "bg-fill-3 text-text-1" : ""}`}
          onClick={(event) => {
            event.stopPropagation();
            toggleShellPicker();
          }}
          title={terminalTitle}
        >
          <ChevronDown
            size={DROPDOWN_ITEM.iconSize}
            strokeWidth={SIDEBAR_ICON_STROKE_WIDTH}
          />
        </button>
        {shellPickerMenu}
      </div>
    );
  }

  if (!hasProfilePicker) {
    return (
      <Button
        htmlType="button"
        variant="tertiary"
        size="small"
        iconOnly
        onClick={(event) => {
          event.stopPropagation();
          onNewTerminal();
        }}
        title={terminalTitle}
        icon={<Plus size={DROPDOWN_ITEM.iconSize} strokeWidth={2} />}
      />
    );
  }

  return (
    <Button
      ref={shellPickerTriggerRef}
      htmlType="button"
      variant="tertiary"
      size="small"
      iconOnly
      className={isShellPickerOpen ? "!bg-fill-2 !text-primary-6" : ""}
      onClick={(event) => {
        event.stopPropagation();
        onNewTerminal();
      }}
      title={terminalTitle}
      icon={<Plus size={DROPDOWN_ITEM.iconSize} strokeWidth={2} />}
      dropdownMenu={shellPickerMenu ?? <div />}
      onDropdownClick={(event) => {
        event.stopPropagation();
        toggleShellPicker();
      }}
      dropdownVisible={isShellPickerOpen}
      splitIconOnlyMainWidth={splitMainWidth}
    />
  );
};

export const TerminalNewSessionSplitButton = memo(
  TerminalNewSessionSplitButtonComponent
);
TerminalNewSessionSplitButton.displayName = "TerminalNewSessionSplitButton";
