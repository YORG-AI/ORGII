import {
  MAX_MOBILE_TRANSCRIPT_ITEMS,
  type SnapshotUpsertEvent,
  type TranscriptItem,
  reduceTranscriptFromUpserts,
} from "./transcriptReducer";

export type TranscriptLoadPhase =
  | "idle"
  | "loading"
  | "ready"
  | "empty"
  | "error";

export type TranscriptRoundBodyPhase =
  | "unloaded"
  | "loading"
  | "ready"
  | "error";

export interface TranscriptRoundSummary {
  id: string;
  /** Canonical identity of the user submission that opened this round. */
  turnIntentId?: string | null;
  nextRoundId?: string | null;
  startedAt?: string;
  endedAt?: string | null;
  durationMs?: number | null;
  userPreview?: string;
  eventCount?: number;
  bodyEventCount?: number;
  status?: string;
}

export interface TranscriptRoundIndexEnvelope {
  items: TranscriptRoundSummary[];
  complete: boolean;
}

export interface TranscriptSnapshotEnvelope {
  sessionId?: string;
  roundId?: string;
  version?: number;
  snapshotDelta?: boolean;
  streaming?: boolean;
  truncated?: boolean;
  events?: SnapshotUpsertEvent[];
  upserts?: SnapshotUpsertEvent[];
  removedIds?: string[];
}

export interface TranscriptSubscribeResult {
  sessionId?: string;
  rounds?: TranscriptRoundIndexEnvelope;
  snapshot?: TranscriptSnapshotEnvelope;
}

export interface TranscriptRoundResult {
  sessionId?: string;
  roundId?: string;
  snapshot?: TranscriptSnapshotEnvelope;
}

export interface TranscriptRoundBodyState {
  phase: TranscriptRoundBodyPhase;
  version: number;
  items: TranscriptItem[];
  requestGeneration: number;
  accessOrdinal: number;
  truncated: boolean;
  /** Live rows received before the round index confirms their ownership. */
  liveDirty: boolean;
  error?: string;
}

export interface TranscriptLoadState {
  sessionId: string | null;
  /** Guards the active session subscription/index refresh. */
  generation: number;
  indexPhase: TranscriptLoadPhase;
  indexError?: string;
  rounds: TranscriptRoundSummary[];
  roundsComplete: boolean;
  /** Null deliberately means "follow whichever round is latest". */
  selectedRoundId: string | null;
  bodies: Record<string, TranscriptRoundBodyState>;
  accessOrdinal: number;
}

export interface SelectedTranscriptView {
  roundId: string | null;
  items: TranscriptItem[];
  phase: TranscriptLoadPhase;
  error?: string;
  truncated: boolean;
}

export const MAX_READY_ROUND_BODIES = 8;
export const MAX_LOCAL_PENDING_ROUNDS = 8;
export const LEGACY_LATEST_ROUND_ID = "legacy-latest";
export const LOCAL_PENDING_ROUND_PREFIX = "local-pending:";

function isLocalPendingRoundId(roundId: string): boolean {
  return roundId.startsWith(LOCAL_PENDING_ROUND_PREFIX);
}

function createUnloadedRoundBody(): TranscriptRoundBodyState {
  return {
    phase: "unloaded",
    version: 0,
    items: [],
    requestGeneration: 0,
    accessOrdinal: 0,
    truncated: false,
    liveDirty: false,
  };
}

function isOptimisticUserItem(item: TranscriptItem): boolean {
  return item.kind === "user" && item.optimistic === true;
}

function pruneLocalPendingRounds(
  state: TranscriptLoadState
): TranscriptLoadState {
  const pendingIds = state.rounds
    .map((round) => round.id)
    .filter(isLocalPendingRoundId);
  if (pendingIds.length <= MAX_LOCAL_PENDING_ROUNDS) return state;
  const removedIds = new Set(
    pendingIds.slice(0, pendingIds.length - MAX_LOCAL_PENDING_ROUNDS)
  );
  const bodies = { ...state.bodies };
  for (const roundId of removedIds) delete bodies[roundId];
  return {
    ...state,
    rounds: state.rounds.filter((round) => !removedIds.has(round.id)),
    selectedRoundId:
      state.selectedRoundId && removedIds.has(state.selectedRoundId)
        ? null
        : state.selectedRoundId,
    bodies,
  };
}

function snapshotUpserts(
  envelope: TranscriptSnapshotEnvelope
): SnapshotUpsertEvent[] {
  if (envelope.snapshotDelta === true) {
    return Array.isArray(envelope.upserts) ? envelope.upserts : [];
  }
  if (Array.isArray(envelope.events)) return envelope.events;
  return Array.isArray(envelope.upserts) ? envelope.upserts : [];
}

function isSnapshotUserEvent(event: SnapshotUpsertEvent): boolean {
  const source = event.source?.toLowerCase();
  const canonical = (
    event.uiCanonical ??
    event.functionName ??
    ""
  ).toLowerCase();
  return (
    source === "user" || canonical === "user" || canonical === "user_message"
  );
}

/**
 * Resolve a full/live snapshot to a provisional round only from the canonical
 * submit identity echoed by its opening user event. A full EventStore
 * baseline can still contain the previous loaded round, so "latest pending"
 * alone is not proof of ownership.
 */
function pendingRoundIdFromSnapshot(
  pendingRounds: TranscriptRoundSummary[],
  envelope: TranscriptSnapshotEnvelope | undefined
): string | null {
  if (!envelope || pendingRounds.length === 0) return null;
  const pendingIds = new Set(pendingRounds.map((round) => round.id));
  for (const event of [...snapshotUpserts(envelope)].reverse()) {
    if (!isSnapshotUserEvent(event) || !event.turnIntentId) continue;
    const pendingRoundId = `${LOCAL_PENDING_ROUND_PREFIX}${event.turnIntentId}`;
    if (pendingIds.has(pendingRoundId)) return pendingRoundId;
  }
  return null;
}

/**
 * A full EventStore baseline is session-window scoped, not round scoped. When
 * its user identity proves that it belongs to a provisional round, discard
 * the older loaded-round prefix before projecting it into that round.
 */
function scopeSnapshotToPendingRound(
  envelope: TranscriptSnapshotEnvelope,
  pendingRoundId: string
): TranscriptSnapshotEnvelope {
  const turnIntentId = pendingRoundId.slice(LOCAL_PENDING_ROUND_PREFIX.length);
  const events = snapshotUpserts(envelope);
  let start = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (isSnapshotUserEvent(event) && event.turnIntentId === turnIntentId) {
      start = index;
      break;
    }
  }
  if (start < 0) return envelope;
  let end = events.length;
  for (let index = start + 1; index < events.length; index += 1) {
    if (isSnapshotUserEvent(events[index])) {
      end = index;
      break;
    }
  }
  const scopedEvents = events.slice(start, end);
  if (envelope.snapshotDelta === true) {
    return { ...envelope, upserts: scopedEvents };
  }
  if (Array.isArray(envelope.events)) {
    return { ...envelope, events: scopedEvents };
  }
  return { ...envelope, upserts: scopedEvents };
}

function confirmedPendingRoundMapping(
  pendingRounds: TranscriptRoundSummary[],
  newlyIndexedRounds: TranscriptRoundSummary[],
  snapshot: TranscriptSnapshotEnvelope | undefined
): Map<string, string> {
  const pendingByIntentId = new Map(
    pendingRounds.map((round) => [
      round.id.slice(LOCAL_PENDING_ROUND_PREFIX.length),
      round,
    ])
  );
  const confirmed = new Map<string, string>();
  for (const indexedRound of newlyIndexedRounds) {
    if (!indexedRound.turnIntentId) continue;
    const pendingRound = pendingByIntentId.get(indexedRound.turnIntentId);
    if (pendingRound) confirmed.set(pendingRound.id, indexedRound.id);
  }

  // Backward-compatible confirmation for a desktop that has not yet added
  // turnIntentId to its round directory. The full latest-round snapshot still
  // carries the canonical user-event identity.
  if (!snapshot?.roundId) return confirmed;
  const indexedRound = newlyIndexedRounds.find(
    (round) => round.id === snapshot.roundId
  );
  if (!indexedRound) return confirmed;

  const snapshotUsers = reduceTranscriptFromUpserts(
    { items: [] },
    snapshotUpserts(snapshot),
    { replace: true }
  ).items.filter((item) => item.kind === "user");
  const identifiedUser = snapshotUsers.find((item) => item.turnIntentId);
  if (identifiedUser?.turnIntentId) {
    const pendingRound = pendingByIntentId.get(identifiedUser.turnIntentId);
    if (pendingRound) confirmed.set(pendingRound.id, indexedRound.id);
  }
  return confirmed;
}

function reconcileOptimisticUserItems(
  previousItems: TranscriptItem[],
  projectedItems: TranscriptItem[]
): TranscriptItem[] {
  const optimisticItems = previousItems.filter(isOptimisticUserItem);
  if (optimisticItems.length === 0) return projectedItems;

  const knownAuthoritativeIds = new Set(
    previousItems
      .filter((item) => !isOptimisticUserItem(item))
      .map((item) => item.id)
  );
  const newAuthoritativeUsers = projectedItems.filter(
    (item) =>
      item.kind === "user" &&
      !isOptimisticUserItem(item) &&
      !knownAuthoritativeIds.has(item.id)
  );
  const consumedAuthoritativeIds = new Set<string>();
  const unmatchedOptimisticItems = optimisticItems.filter((optimistic) => {
    const exactIntentEcho = optimistic.turnIntentId
      ? newAuthoritativeUsers.find(
          (candidate) =>
            !consumedAuthoritativeIds.has(candidate.id) &&
            candidate.turnIntentId === optimistic.turnIntentId
        )
      : undefined;
    const echo = exactIntentEcho;
    if (!echo) return true;
    consumedAuthoritativeIds.add(echo.id);
    return false;
  });

  const authoritativeItems = projectedItems.filter(
    (item) => !isOptimisticUserItem(item)
  );
  // A response can race ahead of the durable user-message echo, and the phone
  // clock can disagree with the desktop by minutes. Reinsert each unmatched
  // optimistic question directly after the authoritative row that was the
  // tail when the user submitted it. This remains stable across later full
  // snapshots where the raced assistant row has become "known" history.
  const merged = [...authoritativeItems];
  for (const optimistic of unmatchedOptimisticItems) {
    const anchorIndex = optimistic.localAnchorId
      ? merged.findIndex((item) => item.id === optimistic.localAnchorId)
      : -1;
    let insertionIndex = anchorIndex >= 0 ? anchorIndex + 1 : 0;
    while (
      insertionIndex < merged.length &&
      isOptimisticUserItem(merged[insertionIndex]) &&
      merged[insertionIndex].localAnchorId === optimistic.localAnchorId
    ) {
      insertionIndex += 1;
    }
    merged.splice(insertionIndex, 0, optimistic);
  }
  return merged.slice(-MAX_MOBILE_TRANSCRIPT_ITEMS);
}

function normalizeRoundSummaries(
  rounds: TranscriptRoundSummary[] | undefined
): TranscriptRoundSummary[] {
  if (!Array.isArray(rounds)) return [];
  const seen = new Set<string>();
  return rounds.filter((round) => {
    if (
      !round ||
      typeof round.id !== "string" ||
      !round.id ||
      seen.has(round.id)
    ) {
      return false;
    }
    seen.add(round.id);
    return true;
  });
}

export function latestTranscriptRoundId(
  state: Pick<TranscriptLoadState, "rounds">
): string | null {
  return state.rounds.at(-1)?.id ?? null;
}

export function selectedTranscriptRoundId(
  state: Pick<TranscriptLoadState, "rounds" | "selectedRoundId">
): string | null {
  return state.selectedRoundId ?? latestTranscriptRoundId(state);
}

function applySnapshotToRoundBody(
  body: TranscriptRoundBodyState,
  envelope: TranscriptSnapshotEnvelope,
  accessOrdinal: number,
  markLiveDirty = false
): TranscriptRoundBodyState {
  const isDelta = envelope.snapshotDelta === true;
  const incomingVersion =
    typeof envelope.version === "number" ? envelope.version : body.version;
  if (isDelta && incomingVersion < body.version) return body;

  const upserts = snapshotUpserts(envelope);
  const removedIds = Array.isArray(envelope.removedIds)
    ? envelope.removedIds.filter(
        (value): value is string => typeof value === "string"
      )
    : [];
  // Full snapshots are authoritative baselines. Their version can come from
  // a different lineage (exact round loads currently start at 0) than the
  // live EventStore delta stream, so a numeric comparison must not turn a
  // baseline into an append and preserve rows from the previous round.
  const replace = !isDelta;
  const projected = reduceTranscriptFromUpserts(
    { items: body.items },
    upserts,
    { removedIds, replace }
  );
  return {
    phase: "ready",
    version: isDelta
      ? Math.max(body.version, incomingVersion)
      : incomingVersion,
    items: reconcileOptimisticUserItems(body.items, projected.items),
    requestGeneration: body.requestGeneration,
    accessOrdinal,
    truncated: isDelta
      ? body.truncated || envelope.truncated === true
      : envelope.truncated === true,
    liveDirty: markLiveDirty || (isDelta && body.liveDirty),
  };
}

function pruneReadyRoundBodies(
  state: TranscriptLoadState
): TranscriptLoadState {
  const readyIds = Object.entries(state.bodies)
    .filter(([, body]) => body.phase === "ready")
    .map(([roundId]) => roundId);
  if (readyIds.length <= MAX_READY_ROUND_BODIES) return state;

  const selectedId = selectedTranscriptRoundId(state);
  const latestId = latestTranscriptRoundId(state);
  const removable = readyIds
    .filter((roundId) => roundId !== selectedId && roundId !== latestId)
    .sort(
      (left, right) =>
        state.bodies[left].accessOrdinal - state.bodies[right].accessOrdinal
    );
  const bodies = { ...state.bodies };
  let readyCount = readyIds.length;
  for (const roundId of removable) {
    if (readyCount <= MAX_READY_ROUND_BODIES) break;
    bodies[roundId] = createUnloadedRoundBody();
    readyCount -= 1;
  }
  return { ...state, bodies };
}

function touchReadyRound(
  state: TranscriptLoadState,
  roundId: string
): TranscriptLoadState {
  const body = state.bodies[roundId];
  if (body?.phase !== "ready") return state;
  const accessOrdinal = state.accessOrdinal + 1;
  return pruneReadyRoundBodies({
    ...state,
    accessOrdinal,
    bodies: {
      ...state.bodies,
      [roundId]: { ...body, accessOrdinal },
    },
  });
}

function resetSupersededRoundLoads(
  bodies: Record<string, TranscriptRoundBodyState>,
  selectedRoundId: string | null
): Record<string, TranscriptRoundBodyState> {
  let changed = false;
  const nextBodies = { ...bodies };
  for (const [roundId, body] of Object.entries(bodies)) {
    if (body.phase === "loading" && roundId !== selectedRoundId) {
      nextBodies[roundId] = createUnloadedRoundBody();
      changed = true;
    }
  }
  return changed ? nextBodies : bodies;
}

export function createInitialTranscriptLoadState(): TranscriptLoadState {
  return {
    sessionId: null,
    generation: 0,
    indexPhase: "idle",
    rounds: [],
    roundsComplete: false,
    selectedRoundId: null,
    bodies: {},
    accessOrdinal: 0,
  };
}

export function beginTranscriptLoad(
  state: TranscriptLoadState,
  sessionId: string,
  generation: number
): TranscriptLoadState {
  if (state.sessionId !== sessionId) {
    return {
      sessionId,
      generation,
      indexPhase: "loading",
      rounds: [],
      roundsComplete: false,
      selectedRoundId: null,
      bodies: {},
      accessOrdinal: 0,
    };
  }
  return {
    ...state,
    generation,
    indexPhase: "loading",
    indexError: undefined,
    bodies: resetSupersededRoundLoads(
      state.bodies,
      selectedTranscriptRoundId(state)
    ),
  };
}

export function applyTranscriptSubscribeResult(
  state: TranscriptLoadState,
  result: TranscriptSubscribeResult,
  sessionId: string,
  generation: number
): TranscriptLoadState {
  if (state.sessionId !== sessionId || state.generation !== generation) {
    return state;
  }
  if (result.sessionId && result.sessionId !== sessionId) return state;

  const hasRoundIndex = Array.isArray(result.rounds?.items);
  const hasSnapshotEvents = Boolean(
    result.snapshot &&
    ((Array.isArray(result.snapshot.events) &&
      result.snapshot.events.length > 0) ||
      (Array.isArray(result.snapshot.upserts) &&
        result.snapshot.upserts.length > 0))
  );
  const authoritativeRounds = hasRoundIndex
    ? normalizeRoundSummaries(result.rounds?.items)
    : state.rounds.some((round) => !isLocalPendingRoundId(round.id))
      ? state.rounds.filter((round) => !isLocalPendingRoundId(round.id))
      : hasSnapshotEvents
        ? [
            {
              id: result.snapshot?.roundId ?? LEGACY_LATEST_ROUND_ID,
              userPreview: "",
            },
          ]
        : [];
  // A pending round is a user interaction boundary, not merely an
  // optimistic row. A live authoritative user echo can replace that row
  // before the provider's round directory advances, so keep the boundary
  // until an exact turnIntentId/roundId mapping confirms its owner.
  const pendingRounds = state.rounds.filter((round) =>
    isLocalPendingRoundId(round.id)
  );
  const snapshotPendingRoundId = pendingRoundIdFromSnapshot(
    pendingRounds,
    result.snapshot
  );
  const previousAuthoritativeLatestId = state.rounds
    .filter((round) => !isLocalPendingRoundId(round.id))
    .at(-1)?.id;
  const previousAuthoritativeIndex = previousAuthoritativeLatestId
    ? authoritativeRounds.findIndex(
        (round) => round.id === previousAuthoritativeLatestId
      )
    : -1;
  const newlyIndexedRounds = previousAuthoritativeLatestId
    ? previousAuthoritativeIndex >= 0
      ? authoritativeRounds.slice(previousAuthoritativeIndex + 1)
      : []
    : authoritativeRounds.slice(-pendingRounds.length);
  const confirmedPendingRoundIds = confirmedPendingRoundMapping(
    pendingRounds,
    newlyIndexedRounds,
    result.snapshot
  );
  const unconfirmedPendingRounds = pendingRounds.filter(
    (round) => !confirmedPendingRoundIds.has(round.id)
  );
  const rounds = [...authoritativeRounds, ...unconfirmedPendingRounds];
  const roundIds = new Set(rounds.map((round) => round.id));
  const authoritativeLatestId = authoritativeRounds.at(-1)?.id ?? null;
  const latestRoundChanged =
    previousAuthoritativeLatestId != null &&
    authoritativeLatestId != null &&
    previousAuthoritativeLatestId !== authoritativeLatestId;
  const legacyOptimisticItems = previousAuthoritativeLatestId
    ? (state.bodies[previousAuthoritativeLatestId]?.items ?? []).filter(
        isOptimisticUserItem
      )
    : [];
  const bodies: Record<string, TranscriptRoundBodyState> = {};
  for (const round of authoritativeRounds) {
    const previous = state.bodies[round.id];
    if (!previous) {
      bodies[round.id] = createUnloadedRoundBody();
    } else if (
      latestRoundChanged &&
      round.id === previousAuthoritativeLatestId &&
      previous.liveDirty
    ) {
      // Until the index advances, notifications for a newly-created round are
      // necessarily projected into the previous latest body. Do not preserve
      // those ambiguous rows as history once ownership becomes knowable;
      // selecting this round will reload its exact body via session/round.
      bodies[round.id] = createUnloadedRoundBody();
    } else if (previous.phase === "loading") {
      bodies[round.id] = {
        ...createUnloadedRoundBody(),
        version: previous.version,
        items:
          round.id === authoritativeLatestId
            ? previous.items
            : previous.items.filter((item) => !isOptimisticUserItem(item)),
        truncated: previous.truncated,
      };
    } else {
      bodies[round.id] =
        round.id === authoritativeLatestId
          ? previous
          : {
              ...previous,
              items: previous.items.filter(
                (item) => !isOptimisticUserItem(item)
              ),
            };
    }
  }

  for (const pendingRound of unconfirmedPendingRounds) {
    bodies[pendingRound.id] =
      state.bodies[pendingRound.id] ?? createUnloadedRoundBody();
  }

  for (const [
    pendingRoundId,
    authoritativeRoundId,
  ] of confirmedPendingRoundIds) {
    const pendingBody = state.bodies[pendingRoundId];
    if (!pendingBody) continue;
    const authoritativeBody =
      bodies[authoritativeRoundId] ?? createUnloadedRoundBody();
    const pendingItems = pendingBody.items.filter(
      (item) =>
        !authoritativeBody.items.some((candidate) => candidate.id === item.id)
    );
    bodies[authoritativeRoundId] = {
      ...authoritativeBody,
      phase: "ready",
      items: [...authoritativeBody.items, ...pendingItems].slice(
        -MAX_MOBILE_TRANSCRIPT_ITEMS
      ),
      truncated: authoritativeBody.truncated || pendingBody.truncated,
      liveDirty: false,
      error: undefined,
    };
  }

  let accessOrdinal = state.accessOrdinal;
  if (authoritativeLatestId) {
    const latestBody =
      bodies[authoritativeLatestId] ?? createUnloadedRoundBody();
    const migratedOptimisticItems = [
      ...latestBody.items,
      ...legacyOptimisticItems.filter(
        (item) =>
          !latestBody.items.some((candidate) => candidate.id === item.id)
      ),
    ];
    accessOrdinal += 1;
    bodies[authoritativeLatestId] = {
      ...latestBody,
      phase: "ready",
      items: migratedOptimisticItems,
      accessOrdinal,
      error: undefined,
    };
    const mappedSnapshotPendingRoundId = snapshotPendingRoundId
      ? (confirmedPendingRoundIds.get(snapshotPendingRoundId) ??
        snapshotPendingRoundId)
      : null;
    const snapshotRoundId =
      mappedSnapshotPendingRoundId && roundIds.has(mappedSnapshotPendingRoundId)
        ? mappedSnapshotPendingRoundId
        : result.snapshot?.roundId && roundIds.has(result.snapshot.roundId)
          ? result.snapshot.roundId
          : authoritativeLatestId;
    const snapshotBody = bodies[snapshotRoundId] ?? createUnloadedRoundBody();
    if (result.snapshot) {
      bodies[snapshotRoundId] = applySnapshotToRoundBody(
        snapshotBody,
        snapshotPendingRoundId
          ? scopeSnapshotToPendingRound(result.snapshot, snapshotPendingRoundId)
          : result.snapshot,
        accessOrdinal
      );
    }
  }

  const mappedSelectedRoundId = state.selectedRoundId
    ? (confirmedPendingRoundIds.get(state.selectedRoundId) ??
      state.selectedRoundId)
    : null;
  const selectedRoundId =
    mappedSelectedRoundId && roundIds.has(mappedSelectedRoundId)
      ? mappedSelectedRoundId
      : null;
  return pruneReadyRoundBodies({
    ...state,
    indexPhase: rounds.length > 0 ? "ready" : "empty",
    indexError: undefined,
    rounds,
    roundsComplete: hasRoundIndex ? result.rounds?.complete === true : false,
    selectedRoundId,
    bodies,
    accessOrdinal,
  });
}

export function failTranscriptLoad(
  state: TranscriptLoadState,
  sessionId: string,
  generation: number,
  error: string
): TranscriptLoadState {
  if (state.sessionId !== sessionId || state.generation !== generation) {
    return state;
  }
  return { ...state, indexPhase: "error", indexError: error };
}

export function selectTranscriptRound(
  state: TranscriptLoadState,
  roundId: string | null
): TranscriptLoadState {
  const normalizedRoundId =
    roundId && state.rounds.some((round) => round.id === roundId)
      ? roundId
      : null;
  const effectiveRoundId = normalizedRoundId ?? latestTranscriptRoundId(state);
  let next: TranscriptLoadState = {
    ...state,
    selectedRoundId: normalizedRoundId,
    bodies: resetSupersededRoundLoads(state.bodies, effectiveRoundId),
  };
  if (effectiveRoundId) next = touchReadyRound(next, effectiveRoundId);
  return next;
}

export function beginTranscriptRoundLoad(
  state: TranscriptLoadState,
  sessionId: string,
  roundId: string,
  requestGeneration: number
): TranscriptLoadState {
  if (
    state.sessionId !== sessionId ||
    selectedTranscriptRoundId(state) !== roundId ||
    !state.bodies[roundId]
  ) {
    return state;
  }
  const body = state.bodies[roundId];
  if (body.phase === "ready") return state;
  return {
    ...state,
    bodies: {
      ...state.bodies,
      [roundId]: {
        ...body,
        phase: "loading",
        requestGeneration,
        error: undefined,
      },
    },
  };
}

export function applyTranscriptRoundResult(
  state: TranscriptLoadState,
  result: TranscriptRoundResult,
  sessionId: string,
  roundId: string,
  sessionGeneration: number,
  requestGeneration: number
): TranscriptLoadState {
  const body = state.bodies[roundId];
  if (
    state.sessionId !== sessionId ||
    state.generation !== sessionGeneration ||
    selectedTranscriptRoundId(state) !== roundId ||
    result.sessionId !== sessionId ||
    result.roundId !== roundId ||
    body?.phase !== "loading" ||
    body.requestGeneration !== requestGeneration
  ) {
    return state;
  }
  const accessOrdinal = state.accessOrdinal + 1;
  const loadedBody = result.snapshot
    ? applySnapshotToRoundBody(body, result.snapshot, accessOrdinal)
    : { ...body, phase: "ready" as const, items: [], accessOrdinal };
  return pruneReadyRoundBodies({
    ...state,
    accessOrdinal,
    bodies: { ...state.bodies, [roundId]: loadedBody },
  });
}

export function failTranscriptRoundLoad(
  state: TranscriptLoadState,
  sessionId: string,
  roundId: string,
  sessionGeneration: number,
  requestGeneration: number,
  error: string
): TranscriptLoadState {
  const body = state.bodies[roundId];
  if (
    state.sessionId !== sessionId ||
    state.generation !== sessionGeneration ||
    selectedTranscriptRoundId(state) !== roundId ||
    body?.phase !== "loading" ||
    body.requestGeneration !== requestGeneration
  ) {
    return state;
  }
  return {
    ...state,
    bodies: {
      ...state.bodies,
      [roundId]: { ...body, phase: "error", error },
    },
  };
}

export function retrySelectedTranscriptRound(
  state: TranscriptLoadState
): TranscriptLoadState {
  const roundId = selectedTranscriptRoundId(state);
  if (!roundId || state.bodies[roundId]?.phase !== "error") return state;
  return {
    ...state,
    bodies: {
      ...state.bodies,
      [roundId]: {
        ...state.bodies[roundId],
        phase: "unloaded",
        error: undefined,
      },
    },
  };
}

export function applyLiveTranscriptSnapshot(
  state: TranscriptLoadState,
  envelope: TranscriptSnapshotEnvelope
): TranscriptLoadState {
  if (envelope.sessionId !== state.sessionId) return state;
  const pendingRounds = state.rounds.filter((round) =>
    isLocalPendingRoundId(round.id)
  );
  const matchedPendingRoundId = pendingRoundIdFromSnapshot(
    pendingRounds,
    envelope
  );
  const latestId = latestTranscriptRoundId(state);
  const envelopeRoundId = envelope.roundId?.trim();
  const targetRoundId =
    matchedPendingRoundId ??
    (envelopeRoundId &&
    state.rounds.some((round) => round.id === envelopeRoundId)
      ? envelopeRoundId
      : latestId);
  if (!targetRoundId) return state;

  // A full baseline without the provisional turn's opening user identity is
  // not safe to project into that provisional round: it may be the previous
  // loaded round emitted just before the new user event was appended.
  if (
    isLocalPendingRoundId(targetRoundId) &&
    envelope.snapshotDelta !== true &&
    matchedPendingRoundId == null
  ) {
    return state;
  }

  const scopedEnvelope = matchedPendingRoundId
    ? scopeSnapshotToPendingRound(envelope, matchedPendingRoundId)
    : envelope;
  const body = state.bodies[targetRoundId] ?? createUnloadedRoundBody();
  const accessOrdinal = state.accessOrdinal + 1;
  return pruneReadyRoundBodies({
    ...state,
    accessOrdinal,
    bodies: {
      ...state.bodies,
      [targetRoundId]: applySnapshotToRoundBody(
        body,
        scopedEnvelope,
        accessOrdinal,
        true
      ),
    },
  });
}

export function appendOptimisticUserMessage(
  state: TranscriptLoadState,
  sessionId: string,
  turnIntentId: string,
  text: string,
  createdAt = new Date().toISOString()
): TranscriptLoadState {
  if (state.sessionId !== sessionId) return state;
  const pendingRoundId = `${LOCAL_PENDING_ROUND_PREFIX}${turnIntentId}`;
  const hasPendingRound = state.rounds.some(
    (round) => round.id === pendingRoundId
  );
  const stateWithLatest = hasPendingRound
    ? state
    : {
        ...state,
        indexPhase: "ready" as const,
        indexError: undefined,
        rounds: [
          ...state.rounds,
          {
            id: pendingRoundId,
            userPreview: text,
            status: "pending",
          },
        ],
        selectedRoundId: null,
        bodies: {
          ...state.bodies,
          [pendingRoundId]: createUnloadedRoundBody(),
        },
      };
  const selectedLatest = selectTranscriptRound(
    pruneLocalPendingRounds(stateWithLatest),
    null
  );
  const body =
    selectedLatest.bodies[pendingRoundId] ?? createUnloadedRoundBody();
  const id = `mobile-user-${turnIntentId}`;
  if (body.items.some((item) => item.id === id)) return selectedLatest;
  const optimisticItem: TranscriptItem = {
    id,
    kind: "user",
    text,
    createdAt,
    optimistic: true,
    turnIntentId,
  };
  const accessOrdinal = selectedLatest.accessOrdinal + 1;
  return pruneReadyRoundBodies({
    ...selectedLatest,
    accessOrdinal,
    bodies: {
      ...selectedLatest.bodies,
      [pendingRoundId]: {
        ...body,
        phase: "ready",
        items: [...body.items, optimisticItem].slice(
          -MAX_MOBILE_TRANSCRIPT_ITEMS
        ),
        accessOrdinal,
        error: undefined,
      },
    },
  });
}

export function rollbackOptimisticUserMessage(
  state: TranscriptLoadState,
  sessionId: string,
  turnIntentId: string
): TranscriptLoadState {
  if (state.sessionId !== sessionId) return state;
  const id = `mobile-user-${turnIntentId}`;
  const pendingRoundId = `${LOCAL_PENDING_ROUND_PREFIX}${turnIntentId}`;
  const pendingRoundExists = state.rounds.some(
    (round) => round.id === pendingRoundId
  );
  let changed = false;
  const bodies = Object.fromEntries(
    Object.entries(state.bodies).map(([roundId, body]) => {
      const items = body.items.filter((item) => item.id !== id);
      if (items.length !== body.items.length) changed = true;
      return [
        roundId,
        items.length === body.items.length ? body : { ...body, items },
      ];
    })
  );
  if (!changed && !pendingRoundExists) return state;

  const rounds = state.rounds.filter((round) => round.id !== pendingRoundId);
  delete bodies[pendingRoundId];
  return {
    ...state,
    indexPhase: rounds.length > 0 ? state.indexPhase : "empty",
    rounds,
    selectedRoundId:
      state.selectedRoundId === pendingRoundId ? null : state.selectedRoundId,
    bodies,
  };
}

/**
 * Promote one client-created round only after the source adapter proves its
 * authoritative round identity. Positional or text-only matching is
 * intentionally forbidden because desktop and mobile can append concurrently.
 */
export function confirmOptimisticUserRound(
  state: TranscriptLoadState,
  sessionId: string,
  turnIntentId: string,
  roundId: string
): TranscriptLoadState {
  if (state.sessionId !== sessionId || !roundId.trim()) return state;
  const pendingRoundId = `${LOCAL_PENDING_ROUND_PREFIX}${turnIntentId}`;
  const pendingRound = state.rounds.find(
    (round) => round.id === pendingRoundId
  );
  if (!pendingRound) return state;

  const pendingBody = state.bodies[pendingRoundId];
  const authoritativeBody = state.bodies[roundId];
  const mergedItems = [
    ...(authoritativeBody?.items ?? []),
    ...(pendingBody?.items ?? []).filter(
      (item) =>
        !(authoritativeBody?.items ?? []).some(
          (candidate) => candidate.id === item.id
        )
    ),
  ].slice(-MAX_MOBILE_TRANSCRIPT_ITEMS);
  const replacement: TranscriptRoundSummary = {
    ...pendingRound,
    id: roundId,
    turnIntentId,
    status: "completed",
  };
  const rounds = state.rounds.some((round) => round.id === roundId)
    ? state.rounds.filter((round) => round.id !== pendingRoundId)
    : state.rounds.map((round) =>
        round.id === pendingRoundId ? replacement : round
      );
  const bodies = { ...state.bodies };
  delete bodies[pendingRoundId];
  bodies[roundId] = {
    ...(authoritativeBody ?? pendingBody ?? createUnloadedRoundBody()),
    phase: mergedItems.length > 0 ? "ready" : "unloaded",
    items: mergedItems,
    error: undefined,
  };

  return pruneReadyRoundBodies({
    ...state,
    rounds,
    selectedRoundId:
      state.selectedRoundId === pendingRoundId
        ? roundId
        : state.selectedRoundId,
    bodies,
  });
}

export function getSelectedTranscriptView(
  state: TranscriptLoadState
): SelectedTranscriptView {
  const roundId = selectedTranscriptRoundId(state);
  if (!roundId) {
    if (state.indexPhase === "error") {
      return {
        roundId: null,
        items: [],
        phase: "error",
        error: state.indexError,
        truncated: false,
      };
    }
    return {
      roundId: null,
      items: [],
      phase:
        state.indexPhase === "idle" || state.indexPhase === "loading"
          ? state.indexPhase
          : "empty",
      truncated: false,
    };
  }
  const body = state.bodies[roundId];
  if (!body || body.phase === "unloaded" || body.phase === "loading") {
    return {
      roundId,
      items: body?.items ?? [],
      phase: "loading",
      truncated: body?.truncated ?? false,
    };
  }
  if (body.phase === "error") {
    return {
      roundId,
      items: body.items,
      phase: "error",
      error: body.error,
      truncated: body.truncated,
    };
  }
  return {
    roundId,
    items: body.items,
    phase: body.items.length > 0 ? "ready" : "empty",
    truncated: body.truncated,
  };
}

export function readyTranscriptLoadState(
  sessionId: string,
  generation: number,
  items: TranscriptItem[]
): TranscriptLoadState {
  const roundId = "demo-round";
  return {
    sessionId,
    generation,
    indexPhase: "ready",
    rounds: [{ id: roundId, userPreview: items[0]?.text }],
    roundsComplete: true,
    selectedRoundId: null,
    bodies: {
      [roundId]: {
        phase: "ready",
        version: 0,
        items,
        requestGeneration: 0,
        accessOrdinal: 1,
        truncated: false,
        liveDirty: false,
      },
    },
    accessOrdinal: 1,
  };
}
