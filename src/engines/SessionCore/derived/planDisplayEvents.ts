import type { PendingPlanApproval } from "@src/store/session/planApprovalAtom";

import type { SessionEvent } from "../core/types";

export type PlanSurface =
  | "transcript"
  | "current"
  | "communication"
  | "preview";

export type PlanApprovalStatus =
  | "pending"
  | "archived"
  | "approved"
  | "cancelled";

export type PlanStateLabel =
  | "drafting"
  | "ready"
  | "archived"
  | "built"
  | "skipped"
  | "idle";

export interface PlanSurfaceState {
  revisionId: string | null;
  status: PlanApprovalStatus;
  readyForReview: boolean;
  ownsActions: boolean;
  actionable: boolean;
  stale: boolean;
  label: PlanStateLabel;
}

export interface PlanApprovalViewState {
  pendingPlan: PendingPlanApproval | null;
  pendingRevisionId: string | null;
  displayEvents: SessionEvent[];
  currentSurfaceVisible: boolean;
  activePendingEvent: SessionEvent | null;
  statusByRevisionId: Map<string, PlanApprovalStatus>;
  aliasesByRevisionId: Map<string, string[]>;
  latestPendingPlanIndex: number;
  getEventState: (
    event: SessionEvent,
    surface: PlanSurface
  ) => PlanSurfaceState;
  matchesPending: (event: SessionEvent) => boolean;
  aliasesForEvent: (event: SessionEvent) => string[];
}

export const PLAN_EVENT_NAME = {
  CREATE_PLAN: "create_plan",
  PLAN_APPROVAL: "plan_approval",
} as const;

const PLAN_SUBMITTED_SENTINEL = "PLAN_SUBMITTED_END_TURN:";

export interface PlanSubmittedPayload {
  path?: string;
  slug?: string;
  hash?: string;
  bytes_written?: number;
  new_plan?: boolean;
  submitted_for_review?: boolean;
}

export interface PlanEventIdentity {
  planId: string;
  planRevisionId: string;
  originToolCallId: string;
}

interface PlanGroup {
  key: string;
  anchor?: SessionEvent;
  display?: SessionEvent;
  firstIndex: number;
}

const planDisplayCache = new WeakMap<readonly SessionEvent[], SessionEvent[]>();

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function objectValue(
  value: Record<string, unknown> | null | undefined,
  key: string
): unknown {
  return value?.[key];
}

function eventName(event: SessionEvent): string {
  return event.uiCanonical || event.functionName.toLowerCase();
}

function parsePlanSubmittedPayloadString(
  raw: string
): PlanSubmittedPayload | null {
  const trimmed = raw.trim();
  const body = trimmed.startsWith(PLAN_SUBMITTED_SENTINEL)
    ? trimmed.slice(PLAN_SUBMITTED_SENTINEL.length).trim()
    : trimmed;
  if (!body.startsWith("{")) return null;

  try {
    return JSON.parse(body) as PlanSubmittedPayload;
  } catch {
    return null;
  }
}

export function getPlanSubmittedPayloadFromResult(
  result: Record<string, unknown> | undefined
): PlanSubmittedPayload | null {
  if (!result) return null;

  for (const field of ["content", "observation"] as const) {
    const raw = result[field];
    if (typeof raw !== "string") continue;
    const parsed = parsePlanSubmittedPayloadString(raw);
    if (parsed) return parsed;
  }

  return null;
}

export function getPlanSubmittedPayload(
  event: SessionEvent
): PlanSubmittedPayload | null {
  return getPlanSubmittedPayloadFromResult(event.result);
}

export function isSubmittedCreatePlanEvent(event: SessionEvent): boolean {
  if (!isCreatePlanEvent(event) || event.actionType !== "tool_call") {
    return false;
  }
  return getPlanSubmittedPayload(event)?.submitted_for_review === true;
}

export function isCreatePlanEvent(event: SessionEvent): boolean {
  const name = eventName(event);
  return (
    name === PLAN_EVENT_NAME.CREATE_PLAN ||
    event.functionName.toLowerCase() === PLAN_EVENT_NAME.CREATE_PLAN
  );
}

export function isPlanApprovalEvent(event: SessionEvent): boolean {
  const name = eventName(event);
  return (
    name === PLAN_EVENT_NAME.PLAN_APPROVAL ||
    event.functionName.toLowerCase() === PLAN_EVENT_NAME.PLAN_APPROVAL ||
    event.actionType === PLAN_EVENT_NAME.PLAN_APPROVAL
  );
}

export function isRehydratedPlanApprovalEvent(event: SessionEvent): boolean {
  return (
    isPlanApprovalEvent(event) &&
    asString(objectValue(event.args, "planEventSource")) === "rehydrate"
  );
}

export function isPlanDisplayEvent(event: SessionEvent): boolean {
  if (isRehydratedPlanApprovalEvent(event)) return false;
  return isCreatePlanEvent(event) || isPlanApprovalEvent(event);
}

export function isStreamingPlanDraftEvent(event: SessionEvent): boolean {
  if (!isCreatePlanEvent(event) || event.actionType !== "tool_call") {
    return false;
  }

  const identity = getPlanEventIdentity(event);
  const hasLifecycleIdentity = Boolean(
    identity.planId && identity.planRevisionId
  );
  const isDraftStatus =
    event.displayStatus === "running" ||
    event.displayStatus === "awaiting_user";
  return isDraftStatus && !hasLifecycleIdentity;
}

export function normalizePlanCallId(value: string): string {
  return value.startsWith("tool-call-")
    ? value.slice("tool-call-".length)
    : value;
}

function normalizedOptional(value: string | undefined | null): string {
  return value ? normalizePlanCallId(value) : "";
}

function eventCallIdentity(event: SessionEvent): string {
  return normalizePlanCallId(
    asString(objectValue(event.args, "originToolCallId")) ||
      asString(objectValue(event.result, "originToolCallId")) ||
      asString(objectValue(event.args, "toolCallId")) ||
      asString(objectValue(event.result, "toolCallId")) ||
      event.callId ||
      event.chunk_id ||
      ""
  );
}

export function getPlanEventIdentity(event: SessionEvent): PlanEventIdentity {
  const planRevisionId = normalizePlanCallId(
    asString(objectValue(event.args, "planRevisionId")) ||
      asString(objectValue(event.result, "planRevisionId")) ||
      event.callId ||
      event.id
  );
  return {
    planId:
      asString(objectValue(event.args, "planId")) ||
      asString(objectValue(event.result, "planId")),
    planRevisionId,
    originToolCallId: eventCallIdentity(event),
  };
}

function uniqueStrings(
  values: readonly (string | null | undefined)[]
): string[] {
  return Array.from(
    new Set(
      values
        .map((value) => normalizedOptional(value))
        .filter((value): value is string => Boolean(value))
    )
  );
}

export function getPlanEventAliases(event: SessionEvent): string[] {
  if (!isPlanDisplayEvent(event)) return uniqueStrings([event.id]);
  const identity = getPlanEventIdentity(event);
  return uniqueStrings([
    identity.planRevisionId,
    identity.originToolCallId,
    event.callId,
    asString(objectValue(event.args, "toolCallId")),
    asString(objectValue(event.result, "toolCallId")),
    event.id,
    event.chunk_id,
  ]);
}

export function getPendingPlanAliases(
  pendingPlan: PendingPlanApproval | null | undefined
): string[] {
  if (!pendingPlan) return [];
  return uniqueStrings([
    pendingPlan.planRevisionId,
    pendingPlan.toolCallId,
    pendingPlan.originToolCallId,
    pendingPlan.planId,
  ]);
}

export function planAliasesContain(
  aliases: readonly string[],
  target: string | null | undefined
): boolean {
  const normalizedTarget = normalizedOptional(target);
  return Boolean(normalizedTarget && aliases.includes(normalizedTarget));
}

function planGroupKeys(event: SessionEvent): string[] {
  const identity = getPlanEventIdentity(event);
  const keys: string[] = [];
  if (identity.originToolCallId)
    keys.push(`origin:${identity.originToolCallId}`);
  if (identity.planRevisionId) keys.push(`revision:${identity.planRevisionId}`);
  keys.push(`event:${normalizePlanCallId(event.id)}`);
  return keys;
}

function planStatusRank(event: SessionEvent): number {
  const status = asString(objectValue(event.result, "status"));
  if (status === "approved") return 5;
  if (status === "archived") return 5;
  if (status === "cancelled") return 5;
  if (status === "pending") return 4;
  return event.displayStatus === "awaiting_user" ? 4 : 0;
}

function preferPlanDisplay(
  current: SessionEvent | undefined,
  next: SessionEvent
): SessionEvent {
  if (!current) return next;
  const currentRank = planStatusRank(current);
  const nextRank = planStatusRank(next);
  if (nextRank !== currentRank) {
    return nextRank > currentRank ? next : current;
  }
  return next.createdAt >= current.createdAt ? next : current;
}

function anchoredPlanDisplayEvent(group: PlanGroup): SessionEvent | undefined {
  const displayEvent = group.display ?? group.anchor;
  if (!displayEvent) return undefined;

  const anchorEvent = group.anchor ?? displayEvent;
  if (displayEvent === anchorEvent) return displayEvent;

  return {
    ...displayEvent,
    createdAt: anchorEvent.createdAt,
    args: { ...anchorEvent.args, ...displayEvent.args },
    result: { ...anchorEvent.result, ...displayEvent.result },
  };
}

function earlierEvent(left: SessionEvent, right: SessionEvent): SessionEvent {
  return left.createdAt <= right.createdAt ? left : right;
}

function needsPlanDisplayDerivation(events: readonly SessionEvent[]): boolean {
  for (const event of events) {
    if (isRehydratedPlanApprovalEvent(event) || isPlanDisplayEvent(event)) {
      return true;
    }
  }
  return false;
}

export function derivePlanDisplayEvents(
  events: readonly SessionEvent[]
): SessionEvent[] {
  const cached = planDisplayCache.get(events);
  if (cached) return cached;
  if (!needsPlanDisplayDerivation(events)) {
    const unchanged = events as SessionEvent[];
    planDisplayCache.set(events, unchanged);
    return unchanged;
  }

  const groups: PlanGroup[] = [];
  const groupByKey = new Map<string, PlanGroup>();
  const displayEvents: SessionEvent[] = [];

  events.forEach((event, index) => {
    if (isRehydratedPlanApprovalEvent(event)) return;

    if (!isPlanDisplayEvent(event)) {
      displayEvents.push(event);
      return;
    }

    if (event.actionType === "tool_result") return;

    const keys = planGroupKeys(event);
    let group = keys.map((key) => groupByKey.get(key)).find(Boolean);
    if (!group) {
      group = { key: keys[0], firstIndex: index };
      groups.push(group);
    }
    for (const key of keys) {
      groupByKey.set(key, group);
    }

    group.anchor = group.anchor ? earlierEvent(group.anchor, event) : event;

    if (isPlanApprovalEvent(event)) {
      group.display = preferPlanDisplay(group.display, event);
      return;
    }

    if (isStreamingPlanDraftEvent(event)) {
      group.display = group.display ?? event;
      return;
    }

    if (!group.display || event.createdAt >= group.display.createdAt) {
      group.display = event;
    }
  });

  const planDisplays = groups
    .map((group) => ({
      index: group.firstIndex,
      event: anchoredPlanDisplayEvent(group),
    }))
    .filter((entry): entry is { index: number; event: SessionEvent } =>
      Boolean(entry.event)
    );

  const combined = [
    ...displayEvents.map((event, index) => ({ index, event })),
    ...planDisplays,
  ];
  combined.sort((left, right) => {
    const timeOrder = left.event.createdAt.localeCompare(right.event.createdAt);
    if (timeOrder !== 0) return timeOrder;
    return left.index - right.index;
  });
  const derived = combined.map((entry) => entry.event);
  planDisplayCache.set(events, derived);
  return derived;
}

export function pendingPlanMatchesEvent(
  pendingPlan: PendingPlanApproval,
  event: SessionEvent
): boolean {
  const pendingAliases = getPendingPlanAliases(pendingPlan);
  const eventAliases = getPlanEventAliases(event);
  return pendingAliases.some((alias) => eventAliases.includes(alias));
}

export function asPlanApprovalStatus(value: unknown): PlanApprovalStatus {
  if (value === "archived") return value;
  if (value === "approved") return value;
  if (value === "cancelled") return value;
  return "pending";
}

function planEventStatus(event: SessionEvent): PlanApprovalStatus {
  return asPlanApprovalStatus(objectValue(event.result, "status"));
}

function planRevisionKey(event: SessionEvent): string | null {
  const aliases = getPlanEventAliases(event);
  return aliases[0] ?? null;
}

function planSurfaceLabel(options: {
  status: PlanApprovalStatus;
  readyForReview: boolean;
  isStreaming: boolean;
}): PlanStateLabel {
  if (options.status === "approved") return "built";
  if (options.status === "archived") return "archived";
  if (options.status === "cancelled") return "skipped";
  if (options.isStreaming) return "drafting";
  if (options.readyForReview) return "ready";
  return "idle";
}

function planSharesPendingSlot(
  pendingPlan: PendingPlanApproval,
  event: SessionEvent
): boolean {
  const eventPlanId =
    asString(objectValue(event.args, "planId")) ||
    asString(objectValue(event.result, "planId"));
  if (pendingPlan.planId && eventPlanId === pendingPlan.planId) return true;

  const eventPlanPath =
    asString(objectValue(event.args, "planPath")) ||
    asString(objectValue(event.result, "planPath"));
  return Boolean(
    pendingPlan.planPath && eventPlanPath === pendingPlan.planPath
  );
}

function isStaleSiblingPlanRevision(options: {
  currentPlanApproval: PendingPlanApproval;
  event: SessionEvent;
}): boolean {
  if (!isPlanDisplayEvent(options.event)) return false;
  if (pendingPlanMatchesEvent(options.currentPlanApproval, options.event)) {
    return false;
  }
  return planSharesPendingSlot(options.currentPlanApproval, options.event);
}

function computeCurrentSurfaceVisible(options: {
  currentPlanApproval?: PendingPlanApproval | null;
  displayEvents: readonly SessionEvent[];
}): boolean {
  if (!options.currentPlanApproval) return false;

  let matchingPlanIndex = -1;
  for (let index = options.displayEvents.length - 1; index >= 0; index -= 1) {
    const event = options.displayEvents[index];
    if (
      isPlanDisplayEvent(event) &&
      pendingPlanMatchesEvent(options.currentPlanApproval, event)
    ) {
      matchingPlanIndex = index;
      break;
    }
  }

  if (matchingPlanIndex < 0) return true;

  let hasUserEventAfterMatchingPlan = false;
  for (
    let index = matchingPlanIndex + 1;
    index < options.displayEvents.length;
    index++
  ) {
    const event = options.displayEvents[index];
    if (isPlanDisplayEvent(event)) return false;
    if (event.source === "user") {
      hasUserEventAfterMatchingPlan = true;
    }
  }

  return hasUserEventAfterMatchingPlan;
}

export function derivePlanApprovalViewState(options: {
  pendingPlan?: PendingPlanApproval | null;
  chatEvents: readonly SessionEvent[];
  displayEvents?: readonly SessionEvent[];
}): PlanApprovalViewState {
  const pendingPlan = options.pendingPlan ?? null;
  const displayEvents = options.displayEvents
    ? (options.displayEvents as SessionEvent[])
    : derivePlanDisplayEvents(options.chatEvents);
  const currentSurfaceVisible = computeCurrentSurfaceVisible({
    currentPlanApproval: pendingPlan,
    displayEvents,
  });
  const pendingRevisionId = getPendingPlanAliases(pendingPlan)[0] ?? null;
  const statusByRevisionId = new Map<string, PlanApprovalStatus>();
  const aliasesByRevisionId = new Map<string, string[]>();
  let activePendingEvent: SessionEvent | null = null;
  let latestPendingPlanIndex = -1;

  for (const [index, event] of displayEvents.entries()) {
    if (!isPlanDisplayEvent(event)) continue;
    const aliases = getPlanEventAliases(event);
    const revisionKey = planRevisionKey(event);
    if (!revisionKey) continue;
    const status = planEventStatus(event);
    statusByRevisionId.set(revisionKey, status);
    aliasesByRevisionId.set(revisionKey, aliases);
    if (pendingPlan && pendingPlanMatchesEvent(pendingPlan, event)) {
      activePendingEvent = event;
      latestPendingPlanIndex = index;
    }
  }

  const eventIndexById = new Map<string, number>();
  displayEvents.forEach((event, index) => {
    eventIndexById.set(event.id, index);
  });

  const matchesPending = (event: SessionEvent): boolean =>
    Boolean(pendingPlan && pendingPlanMatchesEvent(pendingPlan, event));

  const getEventState = (
    event: SessionEvent,
    surface: PlanSurface
  ): PlanSurfaceState => {
    const revisionId = planRevisionKey(event);
    const rawStatus = planEventStatus(event);
    const matchesCurrent = matchesPending(event);
    const isStreaming = isStreamingPlanDraftEvent(event);
    const eventIndex = eventIndexById.get(event.id) ?? -1;
    const archivedByNewerPendingPlan = Boolean(
      pendingPlan &&
      rawStatus === "pending" &&
      !isStreaming &&
      !matchesCurrent &&
      latestPendingPlanIndex >= 0 &&
      eventIndex >= 0 &&
      eventIndex < latestPendingPlanIndex
    );
    const stale = Boolean(
      pendingPlan &&
      rawStatus === "pending" &&
      !isStreaming &&
      (isStaleSiblingPlanRevision({
        currentPlanApproval: pendingPlan,
        event,
      }) ||
        archivedByNewerPendingPlan)
    );
    const status = stale ? "archived" : rawStatus;
    const readyForReview =
      matchesCurrent && !isStreaming && status === "pending";
    const ownsActions =
      readyForReview &&
      (surface === "current" || surface === "preview"
        ? currentSurfaceVisible
        : surface === "transcript"
          ? !currentSurfaceVisible
          : false);
    const actionable = ownsActions && readyForReview;
    return {
      revisionId,
      status,
      readyForReview,
      ownsActions,
      actionable,
      stale,
      label: planSurfaceLabel({ status, readyForReview, isStreaming }),
    };
  };

  return {
    pendingPlan,
    pendingRevisionId,
    displayEvents,
    currentSurfaceVisible,
    activePendingEvent,
    statusByRevisionId,
    aliasesByRevisionId,
    latestPendingPlanIndex,
    getEventState,
    matchesPending,
    aliasesForEvent: getPlanEventAliases,
  };
}

export function shouldRenderCurrentPlanSurface(options: {
  currentPlanApproval?: PendingPlanApproval | null;
  chatEvents: readonly SessionEvent[];
}): boolean {
  return derivePlanApprovalViewState({
    pendingPlan: options.currentPlanApproval,
    chatEvents: options.chatEvents,
  }).currentSurfaceVisible;
}

export function shouldDefaultCollapsePlanCard(options: {
  surface: PlanSurface;
  isStreaming: boolean;
}): boolean {
  if (options.isStreaming) return false;
  return options.surface === "current";
}

export function planEventContentSignature(event: SessionEvent): string {
  if (!isPlanDisplayEvent(event)) return "";
  return [
    asString(objectValue(event.args, "title")),
    asString(objectValue(event.args, "streamContent")),
    asString(objectValue(event.args, "content")),
    asString(objectValue(event.args, "planRevisionId")),
    asString(objectValue(event.result, "status")),
  ].join("\u0000");
}
