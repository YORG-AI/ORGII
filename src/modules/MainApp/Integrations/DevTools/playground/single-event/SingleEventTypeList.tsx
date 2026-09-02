import Checkbox from "@src/components/Checkbox";
import Radio from "@src/components/Radio";
import type { RadioValue } from "@src/components/Radio";

import { getPlaygroundMockEventRowIcon } from "../shared";
import { getChatPreviewTypeLabel, isChatPreviewType } from "./chatPreviewTypes";

const EVENT_TYPE_DISPLAY_LABEL: Record<string, string> = {
  await_output_subagent: "await_output · subagent",
  await_output_multi: "await_output · multi",
  await_output_list: "await_output · list",
};

function getEventTypeDisplayLabel(eventType: string): string {
  return (
    getChatPreviewTypeLabel(eventType) ??
    EVENT_TYPE_DISPLAY_LABEL[eventType] ??
    eventType
  );
}

interface SingleEventTypeListProps {
  selectionMode: "single" | "multiple";
  selectedType: string;
  selectedTypesMulti: string[];
  chatOnly?: boolean;
  displayEventTypesSingle: string[];
  displayEventTypesMulti: string[];
  onSingleSelect: (eventType: string) => void;
  onMultiToggle: (eventType: string, checked: boolean) => void;
}

export function SingleEventTypeList({
  selectionMode,
  selectedType,
  selectedTypesMulti,
  chatOnly = false,
  displayEventTypesSingle,
  displayEventTypesMulti,
  onSingleSelect,
  onMultiToggle,
}: SingleEventTypeListProps) {
  const eventTypesSingle = chatOnly
    ? displayEventTypesSingle.filter(isChatPreviewType)
    : displayEventTypesSingle;
  const eventTypesMulti = chatOnly
    ? displayEventTypesMulti.filter(isChatPreviewType)
    : displayEventTypesMulti;

  if (selectionMode === "single") {
    if (eventTypesSingle.length === 0) return null;
    return (
      <Radio.Group
        value={selectedType}
        onChange={(value: RadioValue) => onSingleSelect(String(value))}
        direction="vertical"
        size="small"
        className="flex flex-col gap-2"
      >
        {eventTypesSingle.map((eventType) => (
          <Radio
            key={eventType}
            value={eventType}
            className="flex items-center gap-2 py-0.5"
          >
            <span className="flex min-w-0 flex-1 items-center gap-1.5">
              {getPlaygroundMockEventRowIcon(eventType)}
              <span className="text-left text-[13px] break-all text-text-2">
                {getEventTypeDisplayLabel(eventType)}
              </span>
            </span>
          </Radio>
        ))}
      </Radio.Group>
    );
  }

  if (eventTypesMulti.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {eventTypesMulti.map((eventType) => (
        <Checkbox
          key={eventType}
          checked={selectedTypesMulti.includes(eventType)}
          onCheckedChange={(checked) => onMultiToggle(eventType, checked)}
          size="small"
          className="flex items-center gap-2 py-0.5"
        >
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            {getPlaygroundMockEventRowIcon(eventType)}
            <span className="text-left text-[13px] break-all text-text-2">
              {getEventTypeDisplayLabel(eventType)}
            </span>
          </span>
        </Checkbox>
      ))}
    </div>
  );
}
