import React from "react";
import { useTranslation } from "react-i18next";

import { TOOL_NAMES } from "@src/api/tauri/agent/toolNames";
import Markdown from "@src/components/MarkDown";
import {
  statusToLifecycle,
  useLifecycleLabels,
} from "@src/engines/SessionCore/rendering/registry/useToolLabel";
import type { UniversalEventProps } from "@src/engines/SessionCore/rendering/types/universalProps";
import { CheckmarkCircle01Icon, HugeiconsIcon, InboxIcon } from "@src/icons";

import AgentMessageCard from "../../blocks/ToolCallBlock/cards/AgentMessageCard";
import { parseAgentMessageCard } from "../../blocks/ToolCallBlock/helpers";

interface DeliveredRow {
  inboxId?: number;
  recipientMemberId?: string;
  kind?: string;
  orgRunId?: string;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function readObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function parseDeliveredRows(raw: string | undefined): DeliveredRow[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    const record = readObject(parsed);
    const delivered = record?.delivered;
    if (!Array.isArray(delivered)) return [];
    return delivered.map((item) => {
      const row = readObject(item);
      return {
        inboxId: typeof row?.inbox_id === "number" ? row.inbox_id : undefined,
        recipientMemberId: readString(row?.recipient_member_id),
        kind: readString(row?.kind),
        orgRunId: readString(row?.org_run_id),
      };
    });
  } catch {
    return [];
  }
}

function deliveredReceiptSource(
  props: UniversalEventProps
): string | undefined {
  const result = props.result ?? {};
  return (
    readString(result.content) ??
    readString(result.observation) ??
    readString(result.output)
  );
}

function messageContent(props: UniversalEventProps): string {
  const args = props.args ?? {};
  const title = readString(args.title);
  const content = readString(args.content) ?? readString(args.text) ?? "";

  if (props.eventType !== "send_to_inbox" || !title) {
    return content;
  }

  if (!content) {
    return title;
  }

  return `**${title}**\n\n${content}`;
}

function destinationLabel(props: UniversalEventProps): string {
  if (props.eventType === "send_to_inbox") {
    return "Inbox";
  }

  const args = props.args ?? {};
  const channel = readString(args.channel);
  const chatId = readString(args.chat_id);

  if (channel && chatId) {
    return `${channel} / ${chatId}`;
  }

  return channel ?? chatId ?? "current channel";
}

function formatKind(kind: string | undefined): string {
  return kind ? kind.replace(/_/g, " ") : "message";
}

export interface OrgSendMessageBlockProps {
  args: Record<string, unknown>;
  result: Record<string, unknown>;
  status: UniversalEventProps["status"];
  eventId?: string;
  sessionId?: string;
  /**
   * When true, the inner `AgentMessageCard` skips its own
   * `EventBlockHeader` and renders the meta + body directly. Used by the
   * simulator Messages app, where the outer chat bubble already supplies
   * the verb-phrase header.
   */
  hideHeader?: boolean;
}

/**
 * Renders an `org_send_message` invocation as an email-style card.
 *
 * Header title comes from Rust's lifecycle labels
 * (`tools.orgSendMessageRunning/Done/Failed`) with `{{recipient}}`
 * interpolated from the parsed card. Status (running / done / failed)
 * also drives the icon styling inside `AgentMessageCard`.
 *
 * Exported so the simulator Messages app can reuse the same card body
 * inside its own bubble wrapper — keeping one source of truth for the
 * email-style header + meta rendering.
 */
export const OrgSendMessageBlock: React.FC<OrgSendMessageBlockProps> = ({
  args,
  result,
  status,
  eventId,
  sessionId,
  hideHeader = false,
}) => {
  const { t } = useTranslation("sessions");
  const card = parseAgentMessageCard(args, result);
  const lifecycle = statusToLifecycle(status);

  // For broadcast / multi-recipient sends, the Rust lifecycle label is
  // bypassed: interpolating `recipient="broadcast"` reads as a literal name
  // ("Sending message to broadcast"). Use a dedicated i18n key that conveys
  // the multi-recipient intent ("multiple agents") instead.
  const broadcastTitles = {
    running: t("cards.agentMessage.broadcastTitle.running"),
    done: t("cards.agentMessage.broadcastTitle.done"),
    failed: t("cards.agentMessage.broadcastTitle.failed"),
  } as const;

  const labels = useLifecycleLabels(TOOL_NAMES.ORG_SEND_MESSAGE, undefined, {
    recipient: card.recipient,
  });
  const title = card.isBroadcast
    ? broadcastTitles[lifecycle]
    : labels[lifecycle] || undefined;

  return (
    <div
      data-tool-call-event-id={eventId}
      data-tool-call-name={TOOL_NAMES.ORG_SEND_MESSAGE}
    >
      <AgentMessageCard
        card={card}
        title={title}
        lifecycle={lifecycle}
        eventId={eventId}
        sessionId={sessionId}
        hideHeader={hideHeader}
      />
    </div>
  );
};

OrgSendMessageBlock.displayName = "OrgSendMessageBlock";

export const SentMessageAdapter: React.FC<UniversalEventProps> = (props) => {
  const { t } = useTranslation("sessions");
  const toolName = props.functionName || props.eventType;

  if (toolName === TOOL_NAMES.ORG_SEND_MESSAGE) {
    return (
      <OrgSendMessageBlock
        args={props.args ?? {}}
        result={props.result ?? {}}
        status={props.status}
        eventId={props.eventId}
        sessionId={props.sessionId}
      />
    );
  }

  const content = messageContent(props);
  const destination = destinationLabel(props);
  const deliveredRows = parseDeliveredRows(deliveredReceiptSource(props));

  return (
    <div
      className="w-full min-w-0 overflow-hidden px-2 py-1"
      data-tool-call-event-id={props.eventId}
      data-tool-call-name={props.functionName || props.eventType}
    >
      <div className="chat-text flex flex-col items-start gap-1 self-stretch text-text-1">
        {content && (
          <div className="resultBgc allow-select w-full overflow-visible break-words font-normal">
            <Markdown
              textContent={content}
              useChatCodeBlock={true}
              enableFileNavigation={true}
              skipPreprocess={false}
            />
          </div>
        )}

        {deliveredRows.length > 0 && (
          <div className="w-full overflow-hidden rounded-xl border border-success-6/20 bg-success-6/5">
            <div className="flex items-center gap-2 border-b border-success-6/10 px-3 py-2 text-xs font-medium text-text-1">
              <HugeiconsIcon
                icon={CheckmarkCircle01Icon}
                data-icon="check-circle-2"
                size={13}
                className="shrink-0 text-success-6"
              />
              <span>{t("common:status.completed")}</span>
              <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-fill-3 px-2 py-0.5 text-[10px] font-normal text-text-3">
                <HugeiconsIcon icon={InboxIcon} data-icon="inbox" size={10} />
                {destination}
              </span>
            </div>
            <div className="divide-y divide-success-6/10">
              {deliveredRows.map((row, index) => (
                <div
                  key={`${row.inboxId ?? "row"}-${index}`}
                  className="grid gap-1 px-3 py-2 text-xs"
                  data-testid="sent-message-delivery-row"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="shrink-0 rounded-full bg-fill-4 px-1.5 py-0.5 text-[10px] text-text-4">
                      {formatKind(row.kind)}
                    </span>
                    <span
                      className="min-w-0 truncate font-medium text-text-1"
                      title={row.recipientMemberId}
                    >
                      → {row.recipientMemberId ?? destination}
                    </span>
                  </div>
                  <div className="truncate text-[11px] text-text-4">
                    {row.inboxId !== undefined ? `#${row.inboxId}` : ""}
                    {row.orgRunId ? ` · ${row.orgRunId}` : ""}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {deliveredRows.length === 0 && (
          <div className="px-0.5 text-[11px] leading-4 text-text-3">
            Sent to {destination}
          </div>
        )}
      </div>
    </div>
  );
};

SentMessageAdapter.displayName = "SentMessageAdapter";

export default SentMessageAdapter;
