/**
 * Data hook for ONE cloud channel's message transcript.
 *
 * Same shape as its control-plane sibling `useOrgChannels`: fresh-token
 * resolution via `ensureFreshSession` + `commitRefreshedAuth`, a capability
 * probe (`orgChannelMessages`) that resolves "unsupported" instead of calling
 * a missing RPC, identity-keyed state wiped on account switch, and a monotonic
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
 *
 * Strictly event-driven; no polling.
 */
import { useAtom, useAtomValue } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  commitRefreshedAuth,
  org2CloudAuthAtom,
  org2CloudAuthIdentityKey,
} from "@src/features/Org2Cloud/org2CloudAuthAtom";
import { getCloudCapabilities } from "@src/features/Org2Cloud/org2CloudCapabilities";
import { ensureFreshSession } from "@src/features/Org2Cloud/org2CloudClient";
import { createLogger } from "@src/hooks/logger";

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
  org2CloudChannelMessagesVersionAtom,
  selectChannelMessagesVersion,
} from "./channelsAtom";

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
  incoming: readonly CloudChannelMessage[]
): CloudChannelMessage[] {
  if (incoming.length === 0) return [...current];
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) {
    const existing = byId.get(message.id);
    if (existing && existing.stateChangedAt > message.stateChangedAt) continue;
    byId.set(message.id, message);
  }
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
  const [auth, setAuth] = useAtom(org2CloudAuthAtom);
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

  // `p_since` cursor for the next delta read, and the last version a delta
  // (or page) already covers.
  const serverTimeRef = useRef<string | null>(null);
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
    lastReadSentRef.current = null;
  }, [authIdentityKey, orgId, channelId]);

  const getFreshAccessToken = useCallback(async (): Promise<string> => {
    const current = authRef.current;
    if (!current) throw new Error("signed out");
    const fresh = await ensureFreshSession(current);
    if (!fresh) throw new Error("cloud session refresh failed");
    commitRefreshedAuth(setAuth, current, fresh);
    return fresh.accessToken;
  }, [setAuth]);

  // --- Initial page (and full reloads: refresh nonce / capped delta).
  useEffect(() => {
    if (!authIdentityKey || !orgId || !channelId) return;
    let cancelled = false;
    const seq = ++requestRef.current;
    void (async () => {
      setFetching(true);
      setError(null);
      try {
        const accessToken = await getFreshAccessToken();
        const capabilities = await getCloudCapabilities(accessToken);
        const isSupported = hasOrgChannelMessagesCapability(capabilities);
        if (cancelled || seq !== requestRef.current) return;
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
        setNextCursor(page.hasMore ? page.nextCursor : null);
        setUnreadCount(page.unreadCount);
        serverTimeRef.current = page.serverTime ?? null;
        handledVersionRef.current = versionRef.current;
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
    // Nothing loaded for THIS scope yet — the page read above covers it, and
    // it will stamp `handledVersionRef` with the version it observed.
    if (messagesKey !== listKey) return;
    if (version === handledVersionRef.current) return;
    handledVersionRef.current = version;
    let cancelled = false;
    const keyAtStart = listKey;
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
        if (cancelled || listKeyRef.current !== keyAtStart) return;
        if (delta.hasMore) {
          // The delta hit the server cap: merging it would advance the cursor
          // past rows this client never saw. Reload the page instead.
          setRefreshNonce((nonce) => nonce + 1);
          return;
        }
        setMessages((current) =>
          current ? mergeChannelMessageDelta(current, delta.messages) : current
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
  }, [version, listKey, messagesKey, orgId, channelId, getFreshAccessToken]);

  const loadOlder = useCallback(() => {
    if (!orgId || !channelId || !nextCursor || loadingOlder) return;
    const keyAtStart = listKeyRef.current;
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
        if (listKeyRef.current !== keyAtStart) return;
        setMessages((current) =>
          current
            ? mergeChannelMessageDelta(current, page.messages)
            : sortChannelMessages(page.messages)
        );
        setNextCursor(page.hasMore ? page.nextCursor : null);
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
      const optimistic = createOptimisticMessage({
        channelId,
        body,
        authorUserId: authRef.current?.userId ?? "",
        authorDisplayName: authRef.current?.profile?.displayName ?? undefined,
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
          body
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
