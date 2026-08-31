import { useAtom, useAtomValue, useSetAtom } from "jotai";
import React, { useCallback } from "react";
import { useTranslation } from "react-i18next";

import {
  DROPDOWN_CLASSES,
  DROPDOWN_WIDTHS,
} from "@src/components/Dropdown/tokens";
import SegmentedTextPill from "@src/components/SegmentedTextPill";
import Switch from "@src/components/Switch";
import {
  type ModelPickerStyle,
  activeStationChatVisibleAtom,
  chatTurnPaginationEnabledAtom,
  modelPickerStyleAtom,
} from "@src/store/ui/chatPanelAtom";
import { stationModeAtom } from "@src/store/ui/simulatorAtom";
import {
  chatPanelPositionAtom,
  workStationLayoutModeAtom,
  workStationLayoutModePersistAtom,
} from "@src/store/ui/workStationAtom";

interface SidebarLayoutSettingsSubmenuProps {
  panelRef: React.Ref<HTMLDivElement>;
  position: {
    left: number;
    top: number;
  };
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  onMouseDown: (event: React.MouseEvent<HTMLDivElement>) => void;
}

type ChatPanelPosition = "left" | "right";
type WorkstationSidebarPosition = "left" | "right";

function SegmentedControlRow<TValue extends string>({
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
    <div className={DROPDOWN_CLASSES.menuControlItem}>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <SegmentedTextPill
        ariaLabel={label}
        size="small"
        value={value}
        options={[...options]}
        onChange={onChange}
      />
    </div>
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
      <Switch
        checked={checked}
        onCheckedChange={onChange}
        size="small"
        ariaLabel={label}
      />
    </div>
  );
}

export const SidebarLayoutSettingsSubmenu: React.FC<SidebarLayoutSettingsSubmenuProps> =
  React.memo(({ panelRef, position, onPointerDown, onMouseDown }) => {
    const { t } = useTranslation("common");
    const stationMode = useAtomValue(stationModeAtom);
    const setStationChatVisible = useSetAtom(activeStationChatVisibleAtom);
    const layoutMode = useAtomValue(workStationLayoutModeAtom);
    const setLayoutModePersist = useSetAtom(workStationLayoutModePersistAtom);
    const [chatPanelPosition, setChatPanelPosition] = useAtom(
      chatPanelPositionAtom
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

    const handleChatPanelPositionChange = useCallback(
      (value: ChatPanelPosition) => {
        if (stationMode === "my-station" || stationMode === "agent-station") {
          setStationChatVisible(stationMode, true);
        }
        setChatPanelPosition(value);
      },
      [setChatPanelPosition, setStationChatVisible, stationMode]
    );

    return (
      <div
        ref={panelRef}
        className={`${DROPDOWN_CLASSES.menuPanelWithHeaderBase} ${DROPDOWN_WIDTHS.panelWidthClass} fixed`}
        style={{ left: position.left, top: position.top }}
        onPointerDown={onPointerDown}
        onMouseDown={onMouseDown}
      >
        <div className={DROPDOWN_CLASSES.itemsColumnPadded}>
          <SegmentedControlRow<ChatPanelPosition>
            label={t("layoutSettings.chatPanelLocation")}
            value={chatPanelPosition}
            options={chatPositionOptions}
            onChange={handleChatPanelPositionChange}
          />
          <SegmentedControlRow<WorkstationSidebarPosition>
            label={t("layoutSettings.sidebarPosition")}
            value={layoutMode}
            options={chatPositionOptions}
            onChange={setLayoutModePersist}
          />
          <SegmentedControlRow<ModelPickerStyle>
            label={t("layoutSettings.modelPickerStyle")}
            value={modelPickerStyle}
            options={modelPickerStyleOptions}
            onChange={setModelPickerStyle}
          />
          <SwitchControlRow
            label={t("layoutSettings.paginateChatHistory")}
            checked={chatTurnPaginationEnabled}
            onChange={setChatTurnPaginationEnabled}
          />
        </div>
      </div>
    );
  });

SidebarLayoutSettingsSubmenu.displayName = "SidebarLayoutSettingsSubmenu";
