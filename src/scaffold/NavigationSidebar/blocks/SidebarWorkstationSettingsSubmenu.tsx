import { useAtom, useAtomValue, useSetAtom } from "jotai";
import React, { useCallback } from "react";
import { useTranslation } from "react-i18next";

import DropdownSelectedCheck from "@src/components/Dropdown/DropdownSelectedCheck";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_WIDTHS,
} from "@src/components/Dropdown/tokens";
import Switch from "@src/components/Switch";
import {
  type ModelPickerStyle,
  activeStationChatVisibleAtom,
  chatTurnPaginationEnabledAtom,
  modelPickerStyleAtom,
} from "@src/store/ui/chatPanelAtom";
import { stationModeAtom } from "@src/store/ui/simulatorAtom";
import {
  sessionChatPositionAtom,
  workStationChatPositionAtom,
  workStationLayoutModeAtom,
  workStationLayoutModePersistAtom,
} from "@src/store/ui/workStationAtom";

interface SidebarWorkstationSettingsSubmenuProps {
  panelRef: React.Ref<HTMLDivElement>;
  position: {
    left: number;
    bottom: number;
  };
  mode: "chatPanelLocation" | "workstation";
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  onMouseDown: (event: React.MouseEvent<HTMLDivElement>) => void;
}

type ChatPanelPosition = "left" | "right";
type WorkstationSidebarPosition = "left" | "right";

function SelectionRow<TValue extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: TValue;
  options: readonly { value: TValue; label: string }[];
  onChange: (value: TValue) => void;
}) {
  return (
    <>
      <div className={DROPDOWN_CLASSES.sectionLabel}>{label}</div>
      {options.map((option) => {
        const selected = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            className={`${DROPDOWN_CLASSES.menuActionItem} ${selected ? DROPDOWN_CLASSES.itemSelected : ""} justify-between`}
            onClick={() => onChange(option.value)}
            aria-selected={selected}
          >
            <span>{option.label}</span>
            {selected && <DropdownSelectedCheck />}
          </button>
        );
      })}
    </>
  );
}

function SwitchControlRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className={DROPDOWN_CLASSES.menuControlItem}>
      <span>{label}</span>
      <Switch checked={checked} onChange={onChange} size="small" />
    </div>
  );
}

export const SidebarWorkstationSettingsSubmenu: React.FC<SidebarWorkstationSettingsSubmenuProps> =
  React.memo(({ panelRef, position, mode, onPointerDown, onMouseDown }) => {
    const { t } = useTranslation("common");
    const stationMode = useAtomValue(stationModeAtom);
    const setStationChatVisible = useSetAtom(activeStationChatVisibleAtom);
    const layoutMode = useAtomValue(workStationLayoutModeAtom);
    const setLayoutModePersist = useSetAtom(workStationLayoutModePersistAtom);
    const [chatPosition, setChatPosition] = useAtom(
      workStationChatPositionAtom
    );
    const [agentChatPosition, setAgentChatPosition] = useAtom(
      sessionChatPositionAtom
    );
    const [modelPickerStyle, setModelPickerStyle] =
      useAtom(modelPickerStyleAtom);
    const [chatTurnPaginationEnabled, setChatTurnPaginationEnabled] = useAtom(
      chatTurnPaginationEnabledAtom
    );
    const chatPositionOptions = [
      { value: "left", label: t("layoutSettings.left") },
      { value: "right", label: t("layoutSettings.right") },
    ] as const;
    const modelPickerStyleOptions = [
      { value: "spotlight", label: t("layoutSettings.modelPickerSpotlight") },
      { value: "dropdown", label: t("layoutSettings.modelPickerMenu") },
    ] as const;

    const handleStationChatPositionChange = useCallback(
      (value: ChatPanelPosition) => {
        if (stationMode === "my-station" || stationMode === "agent-station") {
          setStationChatVisible(stationMode, true);
        }
        setChatPosition(value);
      },
      [setChatPosition, setStationChatVisible, stationMode]
    );

    const content =
      mode === "chatPanelLocation" ? (
        <>
          <SelectionRow<ChatPanelPosition>
            label={t("layoutSettings.myStation")}
            value={chatPosition}
            options={chatPositionOptions}
            onChange={handleStationChatPositionChange}
          />
          <div className={DROPDOWN_CLASSES.menuSeparator} />
          <SelectionRow<ChatPanelPosition>
            label={t("layoutSettings.agentStation")}
            value={agentChatPosition}
            options={chatPositionOptions}
            onChange={setAgentChatPosition}
          />
          <div className={DROPDOWN_CLASSES.menuSeparator} />
          <SwitchControlRow
            label={t("layoutSettings.chatPanelPagination")}
            checked={chatTurnPaginationEnabled}
            onChange={setChatTurnPaginationEnabled}
          />
        </>
      ) : (
        <>
          <SelectionRow<WorkstationSidebarPosition>
            label={t("layoutSettings.sidebarPosition")}
            value={layoutMode}
            options={chatPositionOptions}
            onChange={setLayoutModePersist}
          />
          <div className={DROPDOWN_CLASSES.menuSeparator} />
          <SelectionRow<ModelPickerStyle>
            label={t("layoutSettings.modelPickerStyle")}
            value={modelPickerStyle}
            options={modelPickerStyleOptions}
            onChange={setModelPickerStyle}
          />
        </>
      );

    return (
      <div
        ref={panelRef}
        className={`${DROPDOWN_CLASSES.menuPanelWithHeaderBase} ${DROPDOWN_WIDTHS.panelWidthClass} fixed`}
        style={{ left: position.left, bottom: position.bottom }}
        onPointerDown={onPointerDown}
        onMouseDown={onMouseDown}
      >
        <div className={DROPDOWN_CLASSES.itemsColumnPadded}>{content}</div>
      </div>
    );
  });

SidebarWorkstationSettingsSubmenu.displayName =
  "SidebarWorkstationSettingsSubmenu";
