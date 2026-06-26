import { useAtomValue } from "jotai";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import {
  browserStatusBarCallbacksAtom,
  browserStatusBarStateAtom,
} from "@src/store/ui/workStationAtom";

export interface UseBrowserAddToConversationActionReturn {
  showAddToConversation: boolean;
  addToConversationLabel: string;
  addToConversationTooltipLabel: string;
  onAddToConversation: () => void;
}

const noop = () => undefined;

export function useBrowserAddToConversationAction(): UseBrowserAddToConversationActionReturn {
  const { t } = useTranslation("common");
  const browserStatus = useAtomValue(browserStatusBarStateAtom);
  const browserCallbacks = useAtomValue(browserStatusBarCallbacksAtom);

  const addToConversationLabel = t("selectionMenu.addToChat");
  const selectedElementLabel = browserStatus.browserSelectedElementLabel;
  const onSendSelectedElementToChat =
    browserCallbacks.onSendSelectedElementToChat;
  const showAddToConversation =
    browserStatus.browserHasSelectedElement === true &&
    typeof onSendSelectedElementToChat === "function";

  return useMemo(
    () => ({
      showAddToConversation,
      addToConversationLabel,
      addToConversationTooltipLabel: selectedElementLabel
        ? `${addToConversationLabel}: ${selectedElementLabel}`
        : addToConversationLabel,
      onAddToConversation: onSendSelectedElementToChat ?? noop,
    }),
    [
      showAddToConversation,
      addToConversationLabel,
      selectedElementLabel,
      onSendSelectedElementToChat,
    ]
  );
}
