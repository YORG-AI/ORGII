/**
 * 0012 session turn index publish, fired after every successful events push.
 *
 * Third link of the Org2CloudSessionSync inheritance chain, and the link that
 * introduces the sync-client dependency (`client`) the two upload layers below
 * it also use.
 */
import { loadTurnIndex } from "@src/engines/SessionCore/storage/cacheAdapter";
import { createLogger } from "@src/hooks/logger";
import type { Session } from "@src/store/session/sessionAtom/types";

import {
  sha256Hex,
  stableStringify,
} from "../TeamCollaboration/collabSyncUtils";
import type { Org2CloudAuthState } from "./org2CloudAuthAtom";
import { Org2CloudSessionSyncPushEvents } from "./org2CloudSessionSync.pushEvents";
import type { Org2CloudSyncClientDeps } from "./org2CloudSessionSync.types";
import type { CloudSessionTurnSummary } from "./org2CloudSyncClient";
import type { CloudStore } from "./org2CloudSyncLifecycle";

const log = createLogger("Org2CloudSyncEngine");

/** Prompt previews published to the turn index are content-capped. */
const TURN_INDEX_PROMPT_MAX_CHARS = 240;
/**
 * Client-side publish cap: sessions with more rounds skip the index (the
 * viewer falls back to the plain progress download). Stays under whatever
 * cap the server enforces on the jsonb payload.
 */
const TURN_INDEX_MAX_ROUNDS = 2_000;

/** Mirror of Rust normalize_turn_user_preview (turn_window.rs) + truncation. */
export function normalizeTurnPromptPreview(preview: string): string {
  const trimmed = preview.trim();
  const stripped = trimmed.startsWith("user_message ")
    ? trimmed.slice("user_message ".length)
    : trimmed.startsWith("user ")
      ? trimmed.slice("user ".length)
      : trimmed;
  const normalized = stripped.trim();
  return normalized.length > TURN_INDEX_PROMPT_MAX_CHARS
    ? `${normalized.slice(0, TURN_INDEX_PROMPT_MAX_CHARS)}…`
    : normalized;
}

export class Org2CloudSessionSyncTurnIndex extends Org2CloudSessionSyncPushEvents {
  constructor(
    getStore: () => CloudStore | null,
    protected readonly client: Org2CloudSyncClientDeps
  ) {
    super(getStore);
  }

  /**
   * Best-effort 0012 turn-index publish, fired after every successful
   * events push (the index only ever changes together with events). Reads
   * the local per-round index, normalizes prompt previews, and uploads a
   * wholesale replacement for the cursor's epoch. Progressive enhancement
   * only: capability/endpoint gating lives in the client wrapper, the
   * in-memory hash gate dedups repeat passes, and every failure is logged
   * and swallowed — a push must never fail or retry-storm on this.
   */
  protected async publishTurnIndexBestEffort(
    auth: Org2CloudAuthState,
    orgId: string,
    session: Session,
    stampAtRead: number
  ): Promise<void> {
    const sessionId = session.session_id;
    try {
      const upsertTurnIndex = this.client.upsertSessionTurnIndex;
      if (!upsertTurnIndex) return;
      // The local turn index is read AFTER the events push and reflects the
      // LIVE store. If events landed since the pushed snapshot, the index
      // would advertise rounds whose bodies are not on the server yet
      // (phantom placeholders for every viewer); skip — the push those
      // events trigger republishes.
      if ((this.eventActivityStamps.get(sessionId) ?? 0) !== stampAtRead) {
        return;
      }
      // The cursor the push just committed carries the epoch this index
      // describes; without one there is nothing published to annotate.
      const cursor = this.getCursor(orgId, sessionId);
      if (!cursor) return;
      const summaries = await loadTurnIndex(sessionId);
      if (summaries.length === 0 || summaries.length > TURN_INDEX_MAX_ROUNDS) {
        return;
      }
      const turns: CloudSessionTurnSummary[] = summaries.map((turn) => ({
        turnId: turn.turnId,
        prompt: normalizeTurnPromptPreview(turn.userPreview),
        eventCount: Math.max(0, turn.eventCount),
        bodyEventCount: Math.max(0, turn.bodyEventCount),
        ...(turn.startedAt ? { startedAt: turn.startedAt } : {}),
        ...(turn.endedAt ? { endedAt: turn.endedAt } : {}),
        ...(turn.durationMs != null ? { durationMs: turn.durationMs } : {}),
        ...(turn.nextTurnId ? { nextTurnId: turn.nextTurnId } : {}),
      }));
      const key = `${orgId}:${sessionId}`;
      const hash = await sha256Hex(
        stableStringify({ epoch: cursor.epoch, turns })
      );
      if (this.lastPushedTurnIndexHashes.get(key) === hash) return;
      const published = await upsertTurnIndex(
        auth.accessToken,
        orgId,
        sessionId,
        cursor.epoch,
        turns
      );
      if (published) this.lastPushedTurnIndexHashes.set(key, hash);
    } catch (error) {
      log.warn(`turn-index publish skipped for ${sessionId}`, error);
    }
  }
}
