import { useAtomValue } from "jotai";
import { ArrowUp } from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";

import { KeyboardShortcutTooltipContent } from "@src/components/KeyboardShortcut";
import Tooltip from "@src/components/Tooltip";
import { INPUT_AREA_BUTTONS } from "@src/config/inputAreaTokens";
import { getShortcutKeys } from "@src/config/keyboard/shortcutDisplay";
import { chatAppearanceAtom } from "@src/store/config/configAtom";

export interface AgentControlSubmitButtonProps {
  disabled: boolean;
  onSubmit: () => void;
}

export const AgentControlSubmitButton: React.FC<
  AgentControlSubmitButtonProps
> = ({ disabled, onSubmit }) => {
  const { t } = useTranslation("common");
  const { sendOnEnter } = useAtomValue(chatAppearanceAtom);

  const button = (
    <button
      type="button"
      onClick={onSubmit}
      disabled={disabled}
      className={`flex ${INPUT_AREA_BUTTONS.iconButtonSizeClass} shrink-0 items-center justify-center rounded-full transition-colors duration-200 focus:outline-none ${
        disabled
          ? INPUT_AREA_BUTTONS.iconButtonInactive
          : INPUT_AREA_BUTTONS.iconButtonActive
      }`}
      style={{ lineHeight: 0 }}
      aria-label={t("adeManager.submit")}
    >
      <ArrowUp size={INPUT_AREA_BUTTONS.iconSize} strokeWidth={2} />
    </button>
  );

  if (disabled) return button;

  return (
    <Tooltip
      content={
        <KeyboardShortcutTooltipContent
          label={t("adeManager.submit")}
          shortcut={getShortcutKeys("chat_send", {
            chatSendOnEnter: sendOnEnter,
          })}
        />
      }
      position="top-end"
      mouseEnterDelay={200}
      framedPanel
    >
      {button}
    </Tooltip>
  );
};
