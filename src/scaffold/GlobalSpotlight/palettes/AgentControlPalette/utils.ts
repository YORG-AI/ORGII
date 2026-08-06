import { atom } from "jotai";

import type { SessionLaunchResult } from "@src/api/tauri/agent/session";
import {
  DISPATCH_CATEGORY,
  KEY_SOURCE,
  isHostedKey,
} from "@src/api/tauri/session";
import { extractArgsSummary } from "@src/engines/ChatPanel/blocks/ToolCallBlock/helpers/argsSummary";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import type { LastModelSelection } from "@src/store/session/creatorDefaultModelAtom";
import {
  buildCreatedSessionRecord,
  registerCreatedSession,
} from "@src/store/session/sessionAtom";
import { BUILTIN_ADE_MANAGER_DEF_ID } from "@src/util/session/sessionDispatch";

import {
  ADE_MANAGER_AGENT_EXEC_MODE,
  ADE_MANAGER_AGENT_ICON_ID,
  ADE_MANAGER_AGENT_NAME,
  ADE_MANAGER_SESSION_NAME,
} from "./constants";
import type { AdeManagerActivityItem, AdeManagerActivityStatus } from "./types";

export const EMPTY_ADE_MANAGER_EVENTS_ATOM = atom<SessionEvent[]>([]);

export function resolveControlModel(selection: LastModelSelection | null): {
  keySource: string;
  model?: string;
  accountId?: string;
} {
  if (!selection) return { keySource: KEY_SOURCE.OWN };
  if (isHostedKey(selection.keySource)) {
    return {
      keySource: KEY_SOURCE.HOSTED,
      model: selection.listingModel,
    };
  }
  return {
    keySource: KEY_SOURCE.OWN,
    model: selection.model,
    accountId: selection.selectedAccountId,
  };
}

export function buildControlPrompt(text: string): string {
  return text;
}

export function resolveControlModelLabel(
  selection: LastModelSelection | null
): string {
  return (
    selection?.listingModelDisplay ??
    selection?.model ??
    selection?.cliModelDisplay ??
    "default model"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getStringRecordValue(value: unknown, key: string): string | null {
  if (!isRecord(value)) return null;
  const recordValue = value[key];
  return typeof recordValue === "string" && recordValue.trim().length > 0
    ? recordValue.trim()
    : null;
}

function formatActivityText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function formatGuiAction(action: string): string {
  return action
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[._-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function getActivityStatus(event: SessionEvent): AdeManagerActivityStatus {
  if (event.displayStatus === "failed") return "failed";
  if (event.displayStatus === "running" || event.isDelta) return "running";
  return "completed";
}

export function toAdeManagerActivityItem(
  event: SessionEvent
): AdeManagerActivityItem | null {
  if (event.source === "user") return null;

  const toolName = event.uiCanonical || event.functionName;
  const status = getActivityStatus(event);

  if (toolName === "control_orgii") {
    const args = isRecord(event.args) ? event.args : {};
    const action = getStringRecordValue(args, "action") ?? "GUI action";
    const summary = extractArgsSummary(toolName, args);
    const resultText = getStringRecordValue(event.result, "content");
    return {
      id: event.id,
      title: formatGuiAction(action),
      detail: formatActivityText(resultText ?? (summary || action)),
      status,
    };
  }

  if (event.source === "assistant" && event.displayText.trim().length > 0) {
    return {
      id: event.id,
      title: "Response",
      detail: event.displayText,
      status,
      isMarkdown: true,
    };
  }

  if (
    toolName &&
    toolName !== "agent_message" &&
    event.displayText.trim().length > 0
  ) {
    return {
      id: event.id,
      title: formatGuiAction(toolName),
      detail: formatActivityText(event.displayText),
      status,
    };
  }

  return null;
}

export function registerAdeManagerSession(result: SessionLaunchResult): void {
  registerCreatedSession(
    buildCreatedSessionRecord({
      result: {
        ...result,
        name: result.name || ADE_MANAGER_SESSION_NAME,
        category: DISPATCH_CATEGORY.RUST_AGENT,
      },
      isActive: true,
      agentExecMode: ADE_MANAGER_AGENT_EXEC_MODE,
      agentDefinitionId: BUILTIN_ADE_MANAGER_DEF_ID,
      agentIconId: ADE_MANAGER_AGENT_ICON_ID,
      agentDisplayName: ADE_MANAGER_AGENT_NAME,
    })
  );
}
