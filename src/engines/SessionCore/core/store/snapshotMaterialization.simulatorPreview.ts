/**
 * Simulator-event preview projection for `snapshotMaterialization.ts`.
 *
 * Builds the per-event `SimulatorEventPreview` used by the simulator view
 * and rebuilds/patches the preview index Records (`eventPreviewById`,
 * `createdAtById`, etc.) stored on `NormalizedSnapshotCache`. Preview
 * objects are cached by event object identity so events untouched by a
 * delta reuse their preview across materializations.
 */
import type {
  SessionEvent,
  SimulatorEventFilterValue,
  SimulatorEventPreview,
} from "../types";
import type { NormalizedSnapshotCache } from "./EventStoreProxyTypes";

function getFallbackFilterCategory(
  event: SessionEvent
): SimulatorEventFilterValue {
  if (event.source === "user") return "key_interactions";
  if (
    event.uiCanonical === "edit_file" ||
    event.uiCanonical === "delete_file"
  ) {
    return "file_changes";
  }
  if (event.command || event.uiCanonical === "run_shell") {
    return "terminal_events";
  }
  if (
    event.uiCanonical === "read_file" ||
    event.uiCanonical === "list_dir" ||
    event.uiCanonical === "code_search" ||
    event.uiCanonical === "glob" ||
    event.uiCanonical === "find_files" ||
    event.uiCanonical === "search"
  ) {
    return "explore";
  }
  if (event.filePath) return "file_changes";
  return "other";
}

function buildSimulatorEventPreview(
  event: SessionEvent
): SimulatorEventPreview {
  return {
    id: event.id,
    sessionId: event.sessionId,
    createdAt: event.createdAt,
    functionName: event.functionName,
    uiCanonical: event.uiCanonical,
    actionType: event.actionType,
    source: event.source,
    displayText: event.displayText,
    displayStatus: event.displayStatus,
    displayVariant: event.displayVariant,
    activityStatus: event.activityStatus,
    filterCategory: getFallbackFilterCategory(event),
    threadId: event.threadId,
    processId: event.processId,
    callId: event.callId,
    filePath: event.filePath,
    command: event.command,
    isDelta: event.isDelta,
    repoId: event.repoId,
    repoPath: event.repoPath,
  };
}

/**
 * Preview objects are pure projections of their event, so they are cached by
 * event object identity: events untouched by a delta keep the same object in
 * `eventsById` and therefore reuse their preview across materializations.
 */
const simulatorPreviewCache = new WeakMap<
  SessionEvent,
  SimulatorEventPreview
>();

function previewForEvent(event: SessionEvent): SimulatorEventPreview {
  const cached = simulatorPreviewCache.get(event);
  if (cached) return cached;
  const preview = buildSimulatorEventPreview(event);
  simulatorPreviewCache.set(event, preview);
  return preview;
}

export function rebuildSimulatorPreviewIndexes(
  cache: NormalizedSnapshotCache,
  simulatorEvents: SessionEvent[]
): void {
  const eventPreviewById: Record<string, SimulatorEventPreview> = {};
  const createdAtById: Record<string, string> = {};
  const threadIdById: Record<string, string> = {};
  const functionNameById: Record<string, string> = {};
  const displayStatusById: Record<string, string> = {};
  const displayVariantById: Record<string, string> = {};

  for (const event of simulatorEvents) {
    eventPreviewById[event.id] = previewForEvent(event);
    createdAtById[event.id] = event.createdAt;
    if (event.threadId) threadIdById[event.id] = event.threadId;
    functionNameById[event.id] = event.functionName;
    displayStatusById[event.id] = event.displayStatus;
    displayVariantById[event.id] = event.displayVariant;
  }

  cache.eventPreviewById = eventPreviewById;
  cache.createdAtById = createdAtById;
  cache.threadIdById = threadIdById;
  cache.functionNameById = functionNameById;
  cache.displayStatusById = displayStatusById;
  cache.displayVariantById = displayVariantById;
}

/**
 * Copy-on-write patch of the preview index Records for changed simulator
 * events: a Record whose entries are all value-identical keeps its object
 * identity (pure-render consumers bail out); a touched Record is shallow-
 * cloned exactly once. Only valid while the simulator id ordering is
 * unchanged — membership changes must go through
 * `rebuildSimulatorPreviewIndexes`.
 */
export function patchSimulatorPreviewIndexes(
  cache: NormalizedSnapshotCache,
  simulatorEvents: SessionEvent[],
  changedIds: ReadonlySet<string>
): void {
  let eventPreviewById: Record<string, SimulatorEventPreview> | null = null;
  let createdAtById: Record<string, string> | null = null;
  let threadIdById: Record<string, string> | null = null;
  let functionNameById: Record<string, string> | null = null;
  let displayStatusById: Record<string, string> | null = null;
  let displayVariantById: Record<string, string> | null = null;

  for (const event of simulatorEvents) {
    if (!changedIds.has(event.id)) continue;
    const preview = previewForEvent(event);
    if (cache.eventPreviewById[event.id] !== preview) {
      eventPreviewById ??= { ...cache.eventPreviewById };
      eventPreviewById[event.id] = preview;
    }
    if (cache.createdAtById[event.id] !== event.createdAt) {
      createdAtById ??= { ...cache.createdAtById };
      createdAtById[event.id] = event.createdAt;
    }
    if (event.threadId) {
      if (cache.threadIdById[event.id] !== event.threadId) {
        threadIdById ??= { ...cache.threadIdById };
        threadIdById[event.id] = event.threadId;
      }
    } else if (event.id in cache.threadIdById) {
      threadIdById ??= { ...cache.threadIdById };
      delete threadIdById[event.id];
    }
    if (cache.functionNameById[event.id] !== event.functionName) {
      functionNameById ??= { ...cache.functionNameById };
      functionNameById[event.id] = event.functionName;
    }
    if (cache.displayStatusById[event.id] !== event.displayStatus) {
      displayStatusById ??= { ...cache.displayStatusById };
      displayStatusById[event.id] = event.displayStatus;
    }
    if (cache.displayVariantById[event.id] !== event.displayVariant) {
      displayVariantById ??= { ...cache.displayVariantById };
      displayVariantById[event.id] = event.displayVariant;
    }
  }

  if (eventPreviewById) cache.eventPreviewById = eventPreviewById;
  if (createdAtById) cache.createdAtById = createdAtById;
  if (threadIdById) cache.threadIdById = threadIdById;
  if (functionNameById) cache.functionNameById = functionNameById;
  if (displayStatusById) cache.displayStatusById = displayStatusById;
  if (displayVariantById) cache.displayVariantById = displayVariantById;
}
