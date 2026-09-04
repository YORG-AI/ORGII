/**
 * ScreenPickerModal
 *
 * Lightweight "which screen to share?" chooser, used before opening
 * the Wingman floating windows when the user has multiple displays.
 *
 * Inspired by Zoom / Feishu's share-screen picker but intentionally
 * minimal — we show screen number + resolution + a highlight for the
 * primary display. No live preview: we just need the user to pick
 * which monitor the Wingman windows should appear on.
 */
import React, { memo } from "react";
import { useTranslation } from "react-i18next";

import type { WingmanMonitor } from "@src/api/tauri/agent";
import Modal from "@src/scaffold/ModalSystem";

export interface ScreenPickerModalProps {
  monitors: WingmanMonitor[];
  onSelect: (monitorIndex: number) => void;
  onClose: () => void;
}

const ScreenPickerModal: React.FC<ScreenPickerModalProps> = memo(
  ({ monitors, onSelect, onClose }) => {
    const { t } = useTranslation("sessions");
    return (
      <Modal
        visible
        onClose={onClose}
        title={t("creator.screenPicker.title")}
        width={460}
        footer={null}
      >
        <div className="p-4">
          <div className="grid grid-cols-2 gap-[12px]">
            {monitors.map((m) => {
              // Approximate aspect ratio of the real screen so the tile
              // tells ultrawide vs. portrait displays apart at a glance.
              const ratio = m.width / Math.max(m.height, 1);
              const tileHeight = 64;
              const tileWidth = Math.min(Math.max(tileHeight * ratio, 72), 112);
              const n = m.index + 1;
              return (
                <button
                  key={m.index}
                  type="button"
                  onClick={() => onSelect(m.index)}
                  className="flex flex-col items-center gap-2 rounded border border-border-2 bg-fill-2 p-3 transition-colors hover:border-primary-5"
                >
                  <div
                    className="flex items-center justify-center rounded-xs bg-bg-2 tabular-nums"
                    style={{ width: tileWidth, height: tileHeight }}
                  >
                    <span className="text-xl leading-none font-semibold text-text-2">
                      {n}
                    </span>
                  </div>
                  <div className="flex flex-col items-center text-center">
                    <span className="text-[12px] font-medium text-text-1">
                      {Math.round(m.width)} × {Math.round(m.height)}
                      {m.isPrimary
                        ? ` ${t("creator.screenPicker.primary")}`
                        : ""}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </Modal>
    );
  }
);

ScreenPickerModal.displayName = "ScreenPickerModal";

export default ScreenPickerModal;
