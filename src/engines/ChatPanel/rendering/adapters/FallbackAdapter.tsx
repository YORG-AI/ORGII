/**
 * FallbackAdapter — `ChatBlock::Fallback` sink.
 *
 * Renders any tool without a specialized chat view (MCP tools, `manage_lsp`,
 * `setup_repo`, browser-control actions, misc utilities) via `ToolCallBlock`.
 * Exceptions that branch to richer blocks:
 *   - `worktree` + action=list (done)  → WorktreeListBlock
 *
 * Title resolution: built-in tools use the Rust registry via
 * `useLifecycleLabels`; only unregistered tools fall back to `formatToolName()`.
 */
import React from "react";

import { getEventIcon } from "@src/config/toolIcons";
import { stripMcpPrefix } from "@src/engines/SessionCore/core/interactiveTools";
import {
  statusToLifecycle,
  useLifecycleLabels,
} from "@src/engines/SessionCore/rendering/registry";
import type { UniversalEventProps } from "@src/engines/SessionCore/rendering/types/universalProps";
import { getToolDisplayLabelFromRegistry } from "@src/util/ui/rendering/registryToolLabel";
import { deriveToolAction } from "@src/util/ui/rendering/toolAction";

import ManageAgentDefBlock, {
  type ManageAgentDefAction,
} from "../../blocks/ManageAgentDefBlock";
import ManageCodeMapBlock from "../../blocks/ManageCodeMapBlock";
import ToolCallBlock from "../../blocks/ToolCallBlock";
import WorktreeListBlock, {
  type WorktreeEntryItem,
} from "../../blocks/WorktreeListBlock";

const MCP_ICON = getEventIcon("mcp_tool");

function isWorktreeListDone(props: UniversalEventProps): boolean {
  if (props.status !== "success") return false;
  if (props.eventType !== "worktree") return false;
  return (props.args?.action as string | undefined) === "list";
}

function extractWorktreeEntries(
  props: UniversalEventProps
): WorktreeEntryItem[] {
  const raw = props.result?.entries;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (entry): entry is WorktreeEntryItem =>
      entry !== null &&
      typeof entry === "object" &&
      typeof (entry as Record<string, unknown>).path === "string" &&
      typeof (entry as Record<string, unknown>).branch === "string"
  );
}

// ============================================
// manage_agent_def helpers
// ============================================

const MANAGE_AGENT_DEF_TOOLS = new Set(["manage_agent_def"]);
const MANAGE_CODE_MAP_TOOLS = new Set(["manage_code_map"]);

function isManageAgentDefTool(props: UniversalEventProps): boolean {
  return MANAGE_AGENT_DEF_TOOLS.has(props.functionName ?? "");
}

function extractManageAgentDefProps(props: UniversalEventProps): {
  action: ManageAgentDefAction;
  agentName?: string;
  description?: string;
  resultText?: string;
} {
  const args = props.args ?? {};
  const result = props.result ?? {};
  const action = ((args.action as string | undefined) ??
    "list") as ManageAgentDefAction;

  // Try to pull the agent/team name from args first, then result content
  const agentName =
    (args.name as string | undefined) ?? (result.name as string | undefined);

  const description =
    (args.description as string | undefined) ??
    (result.description as string | undefined);

  // For list / get — show result text if no specific agent name
  const rawContent =
    (result.content as string | undefined) ??
    (result.observation as string | undefined);

  // Extract "Created agent 'X'" name from result if args.name is missing
  const nameFromResult = (() => {
    if (!rawContent) return undefined;
    const m = rawContent.match(/agent '([^']+)'/i);
    return m ? m[1] : undefined;
  })();
  const resolvedName = agentName ?? nameFromResult;

  const resultText = !resolvedName && rawContent ? rawContent : undefined;

  return {
    action,
    agentName: resolvedName,
    description,
    resultText,
  };
}

/** Plan-internal signal tools that must never surface in the chat stream. */
const PLAN_SIGNAL_TOOLS = new Set(["suggest_mode_switch"]);

export const FallbackAdapter: React.FC<UniversalEventProps> = (props) => {
  const isMcpTool = props.eventType === "mcp_tool";
  const displayToolName =
    props.functionName &&
    props.functionName !== "tool_call" &&
    props.functionName !== "unknown"
      ? props.functionName
      : props.eventType || "tool_call";
  const action = deriveToolAction(displayToolName, props.args);

  // Resolve worktree-list labels unconditionally so hook order stays stable
  // even when the branch taken changes between renders.
  const worktreeLabels = useLifecycleLabels("worktree", "list");
  const state = statusToLifecycle(props.status);

  const toolLabels = useLifecycleLabels(displayToolName, action);
  const title =
    toolLabels[state] ||
    getToolDisplayLabelFromRegistry(displayToolName, action);

  // Plan signal tools render via `CreatePlanCard` (inline in the chat
  // stream) — suppress any stale events that slipped past the pipeline
  // filter (e.g. from historical sessions).
  if (PLAN_SIGNAL_TOOLS.has(stripMcpPrefix(props.functionName ?? "")))
    return null;

  if (isWorktreeListDone(props)) {
    const entries = extractWorktreeEntries(props);
    if (entries.length > 0) {
      return (
        <WorktreeListBlock
          entries={entries}
          eventId={props.eventId}
          title={worktreeLabels[state]}
        />
      );
    }
  }

  if (isManageAgentDefTool(props)) {
    const agentDefProps = extractManageAgentDefProps(props);
    return (
      <ManageAgentDefBlock
        {...agentDefProps}
        title={title}
        isLoading={
          props.status === "running" && props.showActiveEventPainting === true
        }
        eventId={props.eventId}
      />
    );
  }

  if (MANAGE_CODE_MAP_TOOLS.has(displayToolName)) {
    return (
      <ManageCodeMapBlock
        action={action ?? "status"}
        args={props.args}
        result={props.result}
        title={title}
        isLoading={
          props.status === "running" && props.showActiveEventPainting === true
        }
        isFailed={state === "failed"}
        eventId={props.eventId}
        sessionId={props.sessionId}
        payloadRefs={props.payloadRefs}
      />
    );
  }

  return (
    <ToolCallBlock
      toolName={displayToolName}
      title={title}
      args={props.args}
      result={props.result}
      isLoading={
        props.status === "running" && props.showActiveEventPainting === true
      }
      defaultCollapsed={false}
      eventId={props.eventId}
      iconOverride={isMcpTool ? MCP_ICON : undefined}
      callId={props.callId}
      sessionId={props.sessionId}
      payloadRefs={props.payloadRefs}
    />
  );
};

FallbackAdapter.displayName = "FallbackAdapter";

export default FallbackAdapter;
