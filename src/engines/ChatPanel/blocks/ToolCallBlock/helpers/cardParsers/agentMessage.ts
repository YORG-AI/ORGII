/**
 * Agent message card parser — renders inter-agent message tool calls.
 */
import type {
  AgentMessageCardData,
  AgentMessageDeliveryRow,
} from "../../types";
import {
  asRecord,
  getBoolean,
  getString,
  parseObjectFromContent,
  truncateText,
} from "./primitives";

function parseDeliveries(value: unknown): AgentMessageDeliveryRow[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const row = asRecord(item);
    const recipientMemberId = getString(row?.recipient_member_id);
    if (!recipientMemberId) return [];
    const inboxId =
      typeof row?.inbox_id === "number" ? row.inbox_id : undefined;
    return [{ recipientMemberId, inboxId }];
  });
}

export function parseAgentMessageCard(
  args: Record<string, unknown>,
  result: Record<string, unknown>
): AgentMessageCardData {
  const resultObject = parseObjectFromContent(result) ?? result;
  const deliveries = parseDeliveries(resultObject.delivered);
  const recipientMemberId =
    getString(args.recipient_member_id) ??
    deliveries[0]?.recipientMemberId ??
    "";
  const deliveredCount = deliveries.length > 0 ? deliveries.length : undefined;
  const isBroadcast = (deliveredCount ?? 0) > 1;
  const kind = getString(args.kind) ?? getString(resultObject.kind) ?? "plain";
  const requestId =
    getString(args.request_id) ?? getString(resultObject.request_id);
  const senderMemberId =
    getString(resultObject.sender_member_id) ??
    getString(args.sender_member_id) ??
    undefined;
  const sender = senderMemberId ?? "current member";

  let recipient = "?";
  if (isBroadcast) recipient = "broadcast";
  else if (recipientMemberId) recipient = recipientMemberId;

  let summary = "";
  let fullText = "";
  switch (kind) {
    case "plain": {
      const rawText = getString(args.text)?.trim() ?? "";
      const rawSummary = getString(args.summary)?.trim() ?? "";
      fullText = rawText || rawSummary;
      summary = truncateText((rawSummary || rawText).trim(), 120);
      break;
    }
    case "shutdown_request": {
      const reason = getString(args.reason)?.trim() ?? "";
      fullText = reason;
      summary = reason ? truncateText(reason, 80) : "Shutdown requested";
      break;
    }
    case "shutdown_response": {
      const accepted = args.accepted === true;
      const note = getString(args.note)?.trim() ?? "";
      fullText = note;
      summary = note
        ? `${accepted ? "Accepted" : "Rejected"} · ${truncateText(note, 60)}`
        : accepted
          ? "Accepted shutdown"
          : "Rejected shutdown";
      break;
    }
    case "plan_approval_response": {
      const accepted = args.accepted === true;
      const feedback = getString(args.feedback)?.trim() ?? "";
      fullText = feedback;
      summary = feedback
        ? `${accepted ? "Approved plan" : "Requested revision"} · ${truncateText(feedback, 70)}`
        : accepted
          ? "Approved plan"
          : "Requested plan revision";
      break;
    }
    default: {
      const note =
        getString(args.note)?.trim() ?? getString(args.feedback)?.trim() ?? "";
      fullText = note;
      summary = note ? truncateText(note, 80) : kind;
      break;
    }
  }

  const wakeMode =
    typeof resultObject.live_channel === "boolean"
      ? resultObject.live_channel
        ? "live channel"
        : "inbox wake"
      : undefined;

  return {
    sender,
    recipient,
    recipientMemberId: recipientMemberId || undefined,
    senderMemberId,
    isBroadcast,
    kind,
    requestId,
    summary,
    fullText,
    accepted:
      kind === "shutdown_response" || kind === "plan_approval_response"
        ? getBoolean(args.accepted)
        : undefined,
    deliveredCount,
    wakeMode,
    deliveries,
  };
}
