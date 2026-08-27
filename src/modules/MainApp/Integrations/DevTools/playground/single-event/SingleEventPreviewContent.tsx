import { useTranslation } from "react-i18next";

import { Placeholder } from "@src/components/Placeholder";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import { type PlaygroundChatExtras, PlaygroundChatPanel } from "../panels";
import { InputBoxPreview } from "../previews/InputBoxPreview";
import { PinnedActionsBarPreview } from "../previews/PinnedActionsBarPreview";
import { SimulatorPreview } from "../previews/SimulatorPreview";
import type { PlaygroundVariant } from "../types";
import { CHAT_PREVIEW_TYPE } from "./chatPreviewTypes";

interface SingleEventPreviewContentProps {
  isMultiSelect: boolean;
  selectedTypesMulti: string[];
  selectedVariant: PlaygroundVariant;
  multiPreviewEvents: SessionEvent[] | null;
  multiStatusPreviewEvents: SessionEvent[] | null;
  commandPreviewEvents: SessionEvent[] | null;
  parseError: string | null;
  effectiveEventData: SessionEvent | null;
  chatExtras?: PlaygroundChatExtras;
  inputOnly?: boolean;
}

export function SingleEventPreviewContent({
  isMultiSelect,
  selectedTypesMulti,
  selectedVariant,
  multiPreviewEvents,
  multiStatusPreviewEvents,
  commandPreviewEvents,
  parseError,
  effectiveEventData,
  chatExtras,
  inputOnly = false,
}: SingleEventPreviewContentProps) {
  const { t } = useTranslation("integrations");

  if (inputOnly) {
    // Pinned-actions-only preview — render the bar in isolation
    if (
      selectedTypesMulti.length === 1 &&
      selectedTypesMulti[0] === CHAT_PREVIEW_TYPE.PINNED_ACTIONS
    ) {
      return <PinnedActionsBarPreview />;
    }
    return (
      <PlaygroundChatPanel events={[]} chatExtras={chatExtras} inputOnly />
    );
  }

  if (selectedTypesMulti.length === 0) {
    return <InputBoxPreview />;
  }

  if (isMultiSelect) {
    if (!multiPreviewEvents || selectedTypesMulti.length === 0) {
      return (
        <Placeholder variant="empty" title={t("devTools.multiPreviewEmpty")} />
      );
    }
    return (
      <PlaygroundChatPanel
        events={multiPreviewEvents}
        chatExtras={chatExtras}
        inputOnly={inputOnly}
      />
    );
  }

  if (multiStatusPreviewEvents && multiStatusPreviewEvents.length > 0) {
    return selectedVariant === "simulator" ? (
      <SimulatorPreview event={multiStatusPreviewEvents[0]} />
    ) : (
      <PlaygroundChatPanel
        events={multiStatusPreviewEvents}
        chatExtras={chatExtras}
        inputOnly={inputOnly}
      />
    );
  }

  if (commandPreviewEvents && commandPreviewEvents.length > 0) {
    return selectedVariant === "simulator" ? (
      <SimulatorPreview event={commandPreviewEvents[0]} />
    ) : (
      <PlaygroundChatPanel
        events={commandPreviewEvents}
        chatExtras={chatExtras}
        inputOnly={inputOnly}
      />
    );
  }

  if (parseError) {
    return (
      <div className="tool-event-preview-error">
        {t("devTools.jsonParseError")}: {parseError}
      </div>
    );
  }

  if (effectiveEventData) {
    return selectedVariant === "simulator" ? (
      <SimulatorPreview event={effectiveEventData} />
    ) : (
      <PlaygroundChatPanel
        events={[effectiveEventData]}
        chatExtras={chatExtras}
        inputOnly={inputOnly}
      />
    );
  }

  return <Placeholder variant="empty" title={t("devTools.noPreview")} />;
}
