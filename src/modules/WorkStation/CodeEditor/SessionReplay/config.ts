/**
 * SimulatorIDE Configuration
 *
 * App configuration for the IDE simulator, compatible with SimulatorApps framework.
 * Uses Rust registry (getAppTypeForTool) as single source of truth for event matching.
 */
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { APP_SUBTOOL } from "@src/engines/SessionCore/rendering/registry";
import {
  getAppSubtool,
  getAppTypeForTool,
} from "@src/engines/SessionCore/rendering/registry/initToolRegistry";
import { resolveToolName } from "@src/engines/SessionCore/rendering/registry/toolAliases";
import { defineSimulatorAppConfig } from "@src/engines/Simulator/apps/core/configFactory";
import { matchesByAppType } from "@src/engines/Simulator/apps/core/matchers";
import { AppType } from "@src/engines/Simulator/types/appTypes";
import { getToolDisplayLabelFromRegistry } from "@src/util/ui/rendering/registryToolLabel";

import {
  convertShellSearchOperation,
  convertToExploreOperation,
  convertToFileOperation,
  convertToShellOperation,
  isShellSearchEvent,
} from "./converters";
import { isExplorePanelTool } from "./converters/exploreTypeResolver";
import {
  dedupeExploreOperations,
  dedupeFileOperations,
  dedupeShellOperations,
} from "./deduplication";
import type {
  ExploreOperationEntry,
  FileOperationEntry,
  FilePanelViewMode,
  ShellOperationEntry,
  SimulatorIDEState,
  ToolOperationEntry,
} from "./types";
import { FILE_PANEL_VIEW_MODE } from "./types";

// ============================================
// Event Matcher
// ============================================

/**
 * Check if an event should be handled by the IDE app.
 * Uses Rust registry as single source of truth.
 */
export function matchesIDEEvent(eventFunction: string): boolean {
  return matchesByAppType(eventFunction, AppType.CODE_EDITOR);
}

export function isGenericIDEFallbackToolEvent(
  event: SessionEvent | null | undefined
): boolean {
  return (
    !!event &&
    getAppTypeForTool(event.functionName) === null &&
    event.displayVariant === "tool_call" &&
    event.source !== "user"
  );
}

export function matchesIDEEventRecord(event: SessionEvent): boolean {
  return (
    matchesIDEEvent(event.functionName) || isGenericIDEFallbackToolEvent(event)
  );
}

// ============================================
// State Derivation
// ============================================

function getEventCallId(event: SessionEvent): string | undefined {
  return (
    event.callId ||
    (event as { call_id?: string }).call_id ||
    (event.result?.call_id as string | undefined)
  );
}

function buildArgsByCallId(
  events: SessionEvent[]
): Map<string, Record<string, unknown>> {
  const argsByCallId = new Map<string, Record<string, unknown>>();
  for (const event of events) {
    const callId = getEventCallId(event);
    if (!callId || !event.args || Object.keys(event.args).length === 0) {
      continue;
    }
    argsByCallId.set(callId, event.args);
  }
  return argsByCallId;
}

function mergeArgsFromCallEvent(
  event: SessionEvent,
  argsByCallId: Map<string, Record<string, unknown>>
): SessionEvent {
  if (event.args && Object.keys(event.args).length > 0) return event;
  const callId = getEventCallId(event);
  const args = callId ? argsByCallId.get(callId) : undefined;
  return args ? { ...event, args } : event;
}

/**
 * Derive IDE state from events.
 * Processes all file, shell, and search events up to current point.
 */
export function deriveIDEState(
  events: SessionEvent[],
  currentEventId: string | null
): Omit<
  SimulatorIDEState,
  keyof import("@src/engines/Simulator/apps/core/types").SimulatorAppBaseState
> {
  const fileOperations: FileOperationEntry[] = [];
  const shellOperations: ShellOperationEntry[] = [];
  const exploreOperations: ExploreOperationEntry[] = [];
  const toolOperations: ToolOperationEntry[] = [];

  const argsByCallId = buildArgsByCallId(events);

  // Process all events
  for (const rawEvent of events) {
    const event = mergeArgsFromCallEvent(rawEvent, argsByCallId);
    const isCurrent = event.id === currentEventId;

    if (isExplorePanelTool(event.functionName)) {
      const exploreOp = convertToExploreOperation(event, isCurrent);
      if (exploreOp) {
        exploreOperations.push(exploreOp);
      }
      continue;
    }

    const subtool = getAppSubtool(event.functionName) ?? APP_SUBTOOL.OTHER_TOOL;

    if (
      subtool === APP_SUBTOOL.FILE_READ ||
      subtool === APP_SUBTOOL.FILE_WRITE
    ) {
      const fileOp = convertToFileOperation(event, isCurrent);
      if (fileOp) {
        fileOperations.push(fileOp);
      }
    } else if (subtool === APP_SUBTOOL.SHELL) {
      const shellOp = convertToShellOperation(event, isCurrent);
      if (shellOp) {
        // A shell command that is really a grep/rg pipeline belongs in the
        // search panel, not the terminal Commands section.
        const searchOp = convertShellSearchOperation(shellOp);
        if (searchOp) {
          exploreOperations.push(searchOp);
        } else {
          shellOperations.push(shellOp);
        }
      }
    } else {
      // Unclassified CODE_EDITOR tools (MCP, etc.) → Other Tools.
      // Display name goes through the shared English-only formatter so the
      // simulator sidebar reads consistently with chat-panel headers and
      // doesn't depend on locale JSON (which tends to drift for uncommon
      // tool names). See `.cursor/rules/orgii-frontend.mdc` §Terminology.
      toolOperations.push({
        toolName: event.functionName,
        displayName: getToolDisplayLabelFromRegistry(
          resolveToolName(event.functionName)
        ),
        event,
        eventId: event.id,
        isCurrent,
      });
    }
  }

  // Dedupe file operations (keep latest per path, prefer ones with content)
  const dedupedFileOps = dedupeFileOperations(fileOperations);

  // Dedupe shell operations (group by command, keep completed over running)
  const dedupedShellOps = dedupeShellOperations(shellOperations);

  // Dedupe explore operations (group by query, keep completed over running)
  const dedupedExploreOps = dedupeExploreOperations(exploreOperations);

  // Reverse shell operations so newest is first
  const reversedShellOps = [...dedupedShellOps].reverse();

  // Reverse explore operations so newest is first
  const reversedExploreOps = [...dedupedExploreOps].reverse();

  // Determine initial file view mode based on current event
  const currentEvent = events.find((e) => e.id === currentEventId);
  let fileViewMode: FilePanelViewMode = FILE_PANEL_VIEW_MODE.EXPLORE;
  if (currentEvent) {
    const currentSubtool =
      getAppSubtool(currentEvent.functionName) ?? APP_SUBTOOL.OTHER_TOOL;
    if (currentSubtool === APP_SUBTOOL.FILE_WRITE) {
      fileViewMode = FILE_PANEL_VIEW_MODE.WRITE;
    } else if (currentSubtool === APP_SUBTOOL.SHELL) {
      // Grep-pipeline shell commands live in the explore panel (default mode).
      if (!isShellSearchEvent(currentEvent)) {
        fileViewMode = FILE_PANEL_VIEW_MODE.TERMINAL;
      }
    } else if (currentSubtool === APP_SUBTOOL.OTHER_TOOL) {
      fileViewMode = FILE_PANEL_VIEW_MODE.TOOL;
    }
  }

  // Find current selections
  // Check both eventId and relatedEventIds for consolidated operations
  const selectedFileOperation =
    dedupedFileOps.find(
      (op) =>
        op.eventId === currentEventId ||
        op.relatedEventIds?.includes(currentEventId ?? "")
    ) ||
    dedupedFileOps.find((op) => op.isCurrent) ||
    null;

  const selectedShellOperation =
    reversedShellOps.find((op) => op.eventId === currentEventId) ||
    reversedShellOps.find((op) => op.isCurrent) ||
    reversedShellOps[0] ||
    null;

  const selectedExploreOperation =
    reversedExploreOps.find((op) => op.eventId === currentEventId) ||
    reversedExploreOps.find((op) => op.isCurrent) ||
    reversedExploreOps[0] ||
    null;

  const selectedToolOperation =
    toolOperations.find((op) => op.eventId === currentEventId) || null;

  // Reverse all list-mode sections so newest is first
  const reversedToolOps = [...toolOperations].reverse();

  return {
    fileOperations: dedupedFileOps,
    shellOperations: reversedShellOps,
    exploreOperations: reversedExploreOps,
    toolOperations: reversedToolOps,
    selectedFileOperation,
    selectedShellOperation,
    selectedExploreOperation,
    selectedToolOperation,
    fileViewMode,
  };
}

// ============================================
// App Configuration
// ============================================

/**
 * IDE simulator app config.
 * Uses Rust registry for event matching.
 */
export const IDE_APP_CONFIG = defineSimulatorAppConfig<SimulatorIDEState>({
  appType: AppType.CODE_EDITOR,
  name: "IDE",
  icon: "Code2",
  deriveState: deriveIDEState,
});
