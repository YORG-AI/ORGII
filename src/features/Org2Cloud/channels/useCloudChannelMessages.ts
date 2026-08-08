/**
 * Data hook for ONE cloud channel's message transcript.
 *
 * Same shape as its control-plane sibling `useOrgChannels`: the slice-wide
 * `useFreshChannelAccessToken` for tokens, a per-endpoint capability probe
 * (`orgChannelMessages`) that resolves "unsupported" instead of calling a
 * missing RPC, identity-keyed state wiped on account switch, and a monotonic
 * request counter dropping late completions after a channel/org switch.
 *
 * What this hook adds over the list hook is a real reconciliation loop:
 *
 *  - **initial page** — DESCENDING keyset page, reversed for display.
 *  - **loadOlder** — the previous page's `nextCursor`, merged by id.
 *  - **delta** — a realtime `channelMessages` bump re-reads with `p_since =
 *    <last serverTime>`. That delta carries EDITS and TOMBSTONES too, so
 *    merging by id converges a body edit and a delete on rows already on
 *    screen without re-listing. A capped delta (`hasMore`) is not merged —
 *    advancing the cursor past unseen rows would lose them — it forces a full
 *    page reload instead.
 *  - **optimistic post** — the row lands immediately and is rolled back if
 *    the RPC refuses; `postMessage` RETHROWS so the composer's
 *    `onSubmitOverride` can restore the editor snapshot (see
 *    `channelPostHandler.ts`) rather than eating the user's draft.
 *  - **read cursor** — debounced `cloud_set_channel_read_cursor` once the
 *    newest row is on screen (the transcript rests scrolled to the bottom, so
 *    "newest row rendered while the document is visible" IS the visible case).
 *  - **focus catch-up** — the focus-regain edge bumps this channel's version,
 *    so a window that missed the realtime signal while backgrounded converges
 *    through the delta path above (`useOrgChannels` idiom, with cleanup).
 *
 * Strictly event-driven; no polling.
 */
import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  org2CloudAuthAtom,
  org2CloudAuthIdentityKey,
} from "@src/features/Org2Cloud/org2CloudAuthAtom";
import { getCloudCapabilities } from "@src/features/Org2Cloud/org2CloudCapabilities";
import { endpointForOrg } from "@src/features/Org2Cloud/org2CloudOrgEndpointRouter";
import { createLogger } from "@src/hooks/logger";
import { onWindowFocusRegained } from "@src/util/core/windowFocus";

import {
  deleteCloudChannelMessage,
  editCloudChannelMessage,
  listCloudChannelMessages,
  postCloudChannelMessage,
  setCloudChannelReadCursor,
} from "./channelMessagesClient";
import type { CloudChannelMessage } from "./channelMessagesTypes";
import { CHANNEL_MESSAGES_PAGE_SIZE } from "./channelMessagesTypes";
import {
  bumpOrg2CloudChannelMessagesVersionAtom,
  org2CloudChannelMessagesVersionAtom,
  selectChannelMessagesVersion,
} from "./channelsAtom";
import { useFreshChannelAccessToken } from "./components/useChannelDialogAccess";

const log = createLogger("CloudChannelMessages");

/** Quiet window before the read cursor is written. */
export const CHANNEL_READ_CURSOR_DEBOUNCE_MS = 800;

/** Optimistic rows carry this prefix so a refusal can roll exactly them back. */
export const OPTIMISTIC_MESSAGE_ID_PREFIX = "pending:";

export type CloudChannelMessagesPhase =
  | "signedOut"
  | "loading"
  | "unsupported"
  | "error"
  | "ready";

export interface CloudChannelMessagesState {
  phase: CloudChannelMessagesPhase;
  /** Ascending by `createdAt` — the transcript's render order. */
  messages: CloudChannelMessage[];
  error: string | null;
  /** An initial/refresh page read is in flight. */
  refreshing: boolean;
  loadingOlder: boolean;
  /** A previous page exists behind the current one. */
  hasOlder: boolean;
  unreadCount: number;
  loadOlder: () => void;
  /** Resolves on success; REJECTS with the RPC error so the draft survives. */
  postMessage: (body: string) => Promise<void>;
  editMessage: (messageId: string, body: string) => Promise<void>;
  deleteMessage: (messageId: string) => Promise<void>;
  /** Debounced read-cursor write; the hook also calls it on new rows. */
  markRead: () => void;
  currentUserId: string | null;
}

export interface CloudChannelMessagesOptions {
  /** Injectable for tests; defaults to `CHANNEL_READ_CURSOR_DEBOUNCE_MS`. */
  readCursorDebounceMs?: number;
}

const NO_MESSAGES: CloudChannelMessage[] = [];

/**
 * `orgChannelMessages` joins `CloudCapabilities` with the message migration;
 * read it structurally so an absent flag ⇒ unsupported against older probe
 * shapes (and so the panel keeps its honest gate on those backends).
 */
export function hasOrgChannelMessagesCapability(
  capabilities: unknown
): boolean {
  return Boolean(
    capabilities &&
    typeof capabilities === "object" &&
    (capabilities as { orgChannelMessages?: unknown }).orgChannelMessages ===
      true
  );
}

/**
 * `orgChannelMessagesIdempotency` joins with the 0016 migration: only a
 * backend that advertises it accepts `p_client_key`, so the post path must
 * gate on this flag — an older backend rejects the unknown argument.
 */
export function hasOrgChannelMessagesIdempotencyCapability(
  capabilities: unknown
): boolean {
  return Boolean(
    capabilities &&
    typeof capabilities === "object" &&
    (capabilities as { orgChannelMessagesIdempotency?: unknown })
      .orgChannelMessagesIdempotency === true
  );
}

/** Ascending by `createdAt`, id as the stable tiebreaker. */
export function sortChannelMessages(
  messages: readonly CloudChannelMessage[]
): CloudChannelMessage[] {
  return [...messages].sort((a, b) =>
    a.createdAt === b.createdAt
      ? a.id.localeCompare(b.id)
      : a.createdAt.localeCompare(b.createdAt)
  );
}

/**
 * Merge server rows into the loaded transcript by id.
 *
 * Delta rows are the SAME rows in a newer state, so an edit and a tombstone
 * both arrive as a replacement of an already-rendered id. `stateChangedAt` is
 * the LWW key: a delayed older copy of a row never overwrites a newer one
 * (the optimistic-post reply racing its own delta is exactly that case).
 */
export function mergeChannelMessageDelta(
  current: readonly CloudChannelMessage[],
  incoming: readonly CloudChannelMessage[],
  options?: {
    /**
     * Oldest `createdAt` the loaded window is contiguous down to. With older
     * pages still unloaded, an unknown id OLDER than this floor must not
     * merge: it would render above the "load earlier" boundary as if the
     * transcript were contiguous. Known ids always merge (edits/tombstones
     * of loaded rows).
     */
    windowFloor?: string | null;
  }
): CloudChannelMessage[] {
  // Same-identity no-op contract: the serverTime overlap re-ships the
  // trailing window on every delta, and an unchanged transcript must not
  // churn row identities downstream.
  if (incoming.length === 0) return current as CloudChannelMessage[];
  const byId = new Map(current.map((message) => [message.id, message]));
  let changed = false;
  for (const message of incoming) {
    const existing = byId.get(message.id);
    if (existing && existing.stateChangedAt >= message.stateChangedAt) continue;
    if (
      !existing &&
      options?.windowFloor &&
      message.createdAt < options.windowFloor
    ) {
      continue;
    }
    byId.set(message.id, message);
    // Echo of an in-flight post (0016 `clientKey`): a realtime delta can
    // deliver the server row before the post RPC resolves; without this the
    // transcript renders the same message twice until the ack lands.
    if (message.clientKey && !isOptimisticChannelMessageId(message.id)) {
      for (const [id, row] of byId) {
        if (
          isOptimisticChannelMessageId(id) &&
          row.clientKey === message.clientKey
        ) {
          byId.delete(id);
        }
      }
    }
    changed = true;
  }
  if (!changed) return current as CloudChannelMessage[];
  return sortChannelMessages([...byId.values()]);
}

export function isOptimisticChannelMessageId(id: string): boolean {
  return id.startsWith(OPTIMISTIC_MESSAGE_ID_PREFIX);
}

function createOptimisticMessage(input: {
  channelId: string;
  body: string;
  authorUserId: string;
  authorDisplayName?: string;
  authorAvatarUrl?: string;
  clientKey?: string;
}): CloudChannelMessage {
  const now = new Date().toISOString();
  return {
    id: `${OPTIMISTIC_MESSAGE_ID_PREFIX}${crypto.randomUUID()}`,
    channelId: input.channelId,
    authorUserId: input.authorUserId,
    authorDisplayName: input.authorDisplayName,
    authorAvatarUrl: input.authorAvatarUrl,
    body: input.body,
    createdAt: now,
    editedAt: null,
    deletedAt: null,
    clientKey: input.clientKey ?? null,
    stateChangedAt: now,
    mentionedUserIds: [],
  };
}

/** Newest SERVER-acknowledged row; optimistic rows are not read receipts. */
function newestServerMessageAt(
  messages: readonly CloudChannelMessage[]
): string | null {
  let newest: string | null = null;
  for (const message of messages) {
    if (isOptimisticChannelMessageId(message.id)) continue;
    if (newest === null || message.createdAt > newest) {
      newest = message.createdAt;
    }
  }
  return newest;
}

export function useCloudChannelMessages(
  orgId: string | null,
  channelId: string | null,
  options?: CloudChannelMessagesOptions
): CloudChannelMessagesState {
  const auth = useAtomValue(org2CloudAuthAtom);
  const bumpMessagesVersion = useSetAtom(
    bumpOrg2CloudChannelMessagesVersionAtom
  );
  const versions = useAtomValue(org2CloudChannelMessagesVersionAtom);
  const version =
    orgId && channelId
      ? selectChannelMessagesVersion(versions, orgId, channelId)
      : 0;
  const readCursorDebounceMs =
    options?.readCursorDebounceMs ?? CHANNEL_READ_CURSOR_DEBOUNCE_MS;

  // null = probe not answered yet for this sign-in.
  const [supported, setSupported] = useState<boolean | null>(null);
  const [messages, setMessages] = useState<CloudChannelMessage[] | null>(null);
  const [messagesKey, setMessagesKey] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);

  const authIdentityKey = auth ? org2CloudAuthIdentityKey(auth) : null;
  const listKey =
    authIdentityKey && orgId && channelId
      ? `${authIdentityKey}|${orgId}|${channelId}`
      : null;

  // Latest auth via ref (panel idiom): token-refresh writes must not
  // retrigger the fetch effect.
  const authRef = useRef(auth);
  useEffect(() => {
    authRef.current = auth;
  }, [auth]);

  // Cloud reads may settle after a channel/account switch; a monotonic
  // counter drops late completions.
  const requestRef = useRef(0);
  useEffect(
    () => () => {
      requestRef.current += 1;
    },
    []
  );

  // Scope guard for callbacks that resolve outside the fetch effect.
  const listKeyRef = useRef(listKey);
  useEffect(() => {
    listKeyRef.current = listKey;
  }, [listKey]);

  const messagesRef = useRef(messages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const nextCursorRef = useRef(nextCursor);
  useEffect(() => {
    nextCursorRef.current = nextCursor;
  }, [nextCursor]);

  // `p_since` cursor for the next delta read, and the last version a delta
  // (or page) already covers.
  const serverTimeRef = useRef<string | null>(null);
  // Whether the org's home endpoint advertised `orgChannelMessagesIdempotency`
  // (stamped by the page effect's probe); posts only send `p_client_key` when
  // it did, since an older backend rejects the unknown argument.
  const idempotencyRef = useRef(false);
  const versionRef = useRef(version);
  useEffect(() => {
    versionRef.current = version;
  }, [version]);
  const handledVersionRef = useRef(0);

  const readTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastReadSentRef = useRef<string | null>(null);

  // Identity switches are a hard visibility boundary (orgs-atom idiom).
  useEffect(() => {
    setSupported(null);
  }, [authIdentityKey]);

  // A channel switch drops the previous transcript outright: the surface must
  // never show one channel's rows under another's header, not even for a frame.
  useEffect(() => {
    setMessages(null);
    setMessagesKey(null);
    setNextCursor(null);
    setUnreadCount(0);
    setError(null);
    serverTimeRef.current = null;
    idempotencyRef.current = false;
    lastReadSentRef.current = null;
  }, [authIdentityKey, orgId, channelId]);

  // One token helper for the whole channels slice (the dialogs' hook), the
  // same source `useOrgChannels` reads — a second byte-equivalent copy here
  // would keep the drift risk #610 removed alive.
  const getFreshAccessToken = useFreshChannelAccessToken();

  // --- Initial page (and full reloads: refresh nonce / capped delta).
  useEffect(() => {
    if (!authIdentityKey || !orgId || !channelId) return;
    let cancelled = false;
    const seq = ++requestRef.current;
    // Stamp the version observed at START: a bump that lands while the page
    // request is in flight names a write the page snapshot may predate, and
    // stamping the completion-time version would swallow it.
    const versionAtStart = versionRef.current;
    void (async () => {
      setFetching(true);
      setError(null);
      try {
        const accessToken = await getFreshAccessToken();
        // Per-endpoint probe: a home-endpoint org answers for its OWN backend,
        // so the message gate is read off the server that would serve it.
        const capabilities = await getCloudCapabilities(
          accessToken,
          endpointForOrg(orgId)
        );
        const isSupported = hasOrgChannelMessagesCapability(capabilities);
        if (cancelled || seq !== requestRef.current) return;
        idempotencyRef.current =
          hasOrgChannelMessagesIdempotencyCapability(capabilities);
        setSupported(isSupported);
        if (!isSupported) return;
        const page = await listCloudChannelMessages(
          accessToken,
          orgId,
          channelId,
          { limit: CHANNEL_MESSAGES_PAGE_SIZE }
        );
        if (cancelled || seq !== requestRef.current) return;
        // Page mode is DESCENDING keyset; the transcript renders ascending.
        setMessages(sortChannelMessages(page.messages));
        setMessagesKey(`${authIdentityKey}|${orgId}|${channelId}`);
        // Page mode signals "older rows exist" via nextCursor itself; the
        // hasMore field only exists in delta mode (schema defaults it false
        // here), so gating on it silently disabled pagination end to end.
        setNextCursor(page.nextCursor ?? null);
        setUnreadCount(page.unreadCount);
        serverTimeRef.current = page.serverTime ?? null;
        handledVersionRef.current = versionAtStart;
      } catch (err) {
        log.warn("cloud channel messages fetch failed:", err);
        if (!cancelled && seq === requestRef.current) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled && seq === requestRef.current) setFetching(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authIdentityKey, orgId, channelId, refreshNonce, getFreshAccessToken]);

  // --- Delta reconciliation on a realtime `channelMessages` bump.
  useEffect(() => {
    if (!orgId || !channelId || !listKey) return;
    if (messagesKey !== listKey) {
      // Nothing loaded for THIS scope. A version bump arriving here names a
      // failed (or transiently mis-probed) page load: without a retry the
      // panel would sit in its error/gated state until the tab is closed —
      // no signal, focus edge, or reconnect would ever recover it. Bump the
      // nonce so the FULL page effect (probe included) re-runs; retries stay
      // strictly event-driven.
      if (version !== handledVersionRef.current) {
        handledVersionRef.current = version;
        if (!fetching) setRefreshNonce((nonce) => nonce + 1);
      }
      return;
    }
    if (version === handledVersionRef.current) return;
    handledVersionRef.current = version;
    let cancelled = false;
    const keyAtStart = listKey;
    const seqAtStart = requestRef.current;
    void (async () => {
      const since = serverTimeRef.current;
      if (!since) {
        // No cursor to delta from (older backend omitted `serverTime`):
        // a full page reload is the only correct convergence.
        setRefreshNonce((nonce) => nonce + 1);
        return;
      }
      try {
        const accessToken = await getFreshAccessToken();
        const delta = await listCloudChannelMessages(
          accessToken,
          orgId,
          channelId,
          { since }
        );
        if (
          cancelled ||
          listKeyRef.current !== keyAtStart ||
          seqAtStart !== requestRef.current
        ) {
          return;
        }
        if (delta.hasMore) {
          // The delta hit the server cap: merging it would advance the cursor
          // past rows this client never saw. Reload the page instead.
          setRefreshNonce((nonce) => nonce + 1);
          return;
        }
        setMessages((current) =>
          current
            ? mergeChannelMessageDelta(current, delta.messages, {
                windowFloor: nextCursorRef.current
                  ? current[0]?.createdAt
                  : null,
              })
            : current
        );
        setUnreadCount(delta.unreadCount);
        serverTimeRef.current = delta.serverTime ?? since;
      } catch (err) {
        // A failed delta is not a broken transcript: keep the rows on screen
        // and let the next signal (or the reconnect edge) converge.
        log.warn("cloud channel messages delta failed:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    version,
    listKey,
    messagesKey,
    orgId,
    channelId,
    fetching,
    getFreshAccessToken,
  ]);

  // A background window can release its Realtime lease without going hidden,
  // so the `channelMessages` bump that drives the delta above may never
  // arrive. Bumping the version on the focus-regain edge routes the catch-up
  // through that SAME delta path — a full page reload here would throw away
  // any older pages the reader had already loaded.
  useEffect(() => {
    if (!authIdentityKey || !orgId || !channelId) return;
    return onWindowFocusRegained(() => {
      bumpMessagesVersion({ orgId, channelId });
    });
  }, [authIdentityKey, orgId, channelId, bumpMessagesVersion]);

  const loadOlder = useCallback(() => {
    if (!orgId || !channelId || !nextCursor || loadingOlder) return;
    const keyAtStart = listKeyRef.current;
    // A capped-delta full reload replaces the window AND the cursor while
    // this page is in flight; letting the stale completion land would merge
    // a discontiguous island and clobber the fresh cursor with the stale one
    // — pagination would then permanently skip the rows in between.
    const seqAtStart = requestRef.current;
    void (async () => {
      setLoadingOlder(true);
      try {
        const accessToken = await getFreshAccessToken();
        const page = await listCloudChannelMessages(
          accessToken,
          orgId,
          channelId,
          { cursor: nextCursor, limit: CHANNEL_MESSAGES_PAGE_SIZE }
        );
        if (
          listKeyRef.current !== keyAtStart ||
          seqAtStart !== requestRef.current
        ) {
          return;
        }
        setMessages((current) =>
          current
            ? mergeChannelMessageDelta(current, page.messages)
            : sortChannelMessages(page.messages)
        );
        // Page mode signals "older rows exist" via nextCursor itself; the
        // hasMore field only exists in delta mode (schema defaults it false
        // here), so gating on it silently disabled pagination end to end.
        setNextCursor(page.nextCursor ?? null);
      } catch (err) {
        log.warn("cloud channel older page failed:", err);
      } finally {
        if (listKeyRef.current === keyAtStart) setLoadingOlder(false);
      }
    })();
  }, [channelId, getFreshAccessToken, loadingOlder, nextCursor, orgId]);

  const postMessage = useCallback(
    async (body: string): Promise<void> => {
      if (!orgId || !channelId) throw new Error("no channel");
      const keyAtStart = listKeyRef.current;
      const clientKey = idempotencyRef.current ? crypto.randomUUID() : null;
      const optimistic = createOptimisticMessage({
        channelId,
        body,
        authorUserId: authRef.current?.userId ?? "",
        authorDisplayName: authRef.current?.profile?.displayName ?? undefined,
        clientKey: clientKey ?? undefined,
      });
      setMessages((current) =>
        current ? [...current, optimistic] : [optimistic]
      );
      try {
        const accessToken = await getFreshAccessToken();
        const message = await postCloudChannelMessage(
          accessToken,
          orgId,
          channelId,
          body,
          clientKey ? { clientKey } : undefined
        );
        if (listKeyRef.current !== keyAtStart) return;
        setMessages((current) =>
          mergeChannelMessageDelta(
            (current ?? []).filter((row) => row.id !== optimistic.id),
            [message]
          )
        );
      } catch (err) {
        if (listKeyRef.current === keyAtStart) {
          setMessages((current) =>
            current
              ? current.filter((row) => row.id !== optimistic.id)
              : current
          );
        }
        // Rethrow: `useSubmitMessage` restores the editor snapshot only on a
        // rejected override, so swallowing this would destroy the draft.
        throw err;
      }
    },
    [channelId, getFreshAccessToken, orgId]
  );

  const editMessage = useCallback(
    async (messageId: string, body: string): Promise<void> => {
      if (!orgId) throw new Error("no org");
      const keyAtStart = listKeyRef.current;
      const accessToken = await getFreshAccessToken();
      const message = await editCloudChannelMessage(
        accessToken,
        orgId,
        messageId,
        body
      );
      if (listKeyRef.current !== keyAtStart) return;
      setMessages((current) =>
        current ? mergeChannelMessageDelta(current, [message]) : current
      );
    },
    [getFreshAccessToken, orgId]
  );

  const deleteMessage = useCallback(
    async (messageId: string): Promise<void> => {
      if (!orgId) throw new Error("no org");
      const keyAtStart = listKeyRef.current;
      const accessToken = await getFreshAccessToken();
      await deleteCloudChannelMessage(accessToken, orgId, messageId);
      if (listKeyRef.current !== keyAtStart) return;
      // The server answers `{ok}`, so stamp the tombstone locally; the row
      // keeps its slot exactly like the local plane's delete.
      const deletedAt = new Date().toISOString();
      setMessages((current) =>
        current
          ? current.map((row) =>
              row.id === messageId
                ? {
                    ...row,
                    body: "",
                    deletedAt,
                    mentionedUserIds: [],
                    stateChangedAt: deletedAt,
                  }
                : row
            )
          : current
      );
    },
    [getFreshAccessToken, orgId]
  );

  const writeReadCursor = useCallback(async (): Promise<void> => {
    const keyAtStart = listKeyRef.current;
    if (!orgId || !channelId || !keyAtStart) return;
    const lastReadAt = newestServerMessageAt(messagesRef.current ?? []);
    if (!lastReadAt || lastReadSentRef.current === lastReadAt) return;
    lastReadSentRef.current = lastReadAt;
    try {
      const accessToken = await getFreshAccessToken();
      const result = await setCloudChannelReadCursor(
        accessToken,
        orgId,
        channelId,
        lastReadAt
      );
      if (listKeyRef.current !== keyAtStart) return;
      setUnreadCount(result.unreadCount);
    } catch (err) {
      // Let the next new row retry instead of pinning the cursor forward.
      lastReadSentRef.current = null;
      log.warn("cloud channel read cursor failed:", err);
    }
  }, [channelId, getFreshAccessToken, orgId]);

  const markRead = useCallback(() => {
    if (readTimerRef.current) clearTimeout(readTimerRef.current);
    readTimerRef.current = setTimeout(() => {
      readTimerRef.current = null;
      // Re-check at fire: a timer armed <debounce before the window hid
      // would otherwise write a read cursor for rows nobody is seeing.
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "hidden"
      ) {
        return;
      }
      void writeReadCursor();
    }, readCursorDebounceMs);
  }, [readCursorDebounceMs, writeReadCursor]);

  useEffect(
    () => () => {
      if (readTimerRef.current) clearTimeout(readTimerRef.current);
    },
    []
  );

  const visibleMessages =
    messagesKey !== null && messagesKey === listKey ? messages : null;
  const newestMessageId =
    visibleMessages && visibleMessages.length > 0
      ? visibleMessages[visibleMessages.length - 1].id
      : null;

  // The transcript rests scrolled to its newest row, so a rendered newest row
  // in a visible document IS "the newest message is visible". A hidden
  // document (background window) must not consume the unread badge.
  useEffect(() => {
    if (!newestMessageId) return;
    if (
      typeof document !== "undefined" &&
      document.visibilityState === "hidden"
    ) {
      return;
    }
    markRead();
  }, [newestMessageId, markRead]);

  let phase: CloudChannelMessagesPhase;
  if (!auth) {
    phase = "signedOut";
  } else if (!orgId || !channelId) {
    phase = "loading";
  } else if (visibleMessages === null && error !== null) {
    phase = "error";
  } else if (supported === false) {
    phase = "unsupported";
  } else if (supported === null || visibleMessages === null) {
    phase = "loading";
  } else {
    phase = "ready";
  }

  const messageList = visibleMessages ?? NO_MESSAGES;
  return useMemo(
    () => ({
      phase,
      messages: messageList,
      error,
      refreshing: fetching,
      loadingOlder,
      hasOlder: nextCursor !== null,
      unreadCount,
      loadOlder,
      postMessage,
      editMessage,
      deleteMessage,
      markRead,
      currentUserId: auth?.userId ?? null,
    }),
    [
      auth?.userId,
      deleteMessage,
      editMessage,
      error,
      fetching,
      loadOlder,
      loadingOlder,
      markRead,
      messageList,
      nextCursor,
      phase,
      postMessage,
      unreadCount,
    ]
  );
}
