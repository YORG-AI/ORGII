/**
 * ORG2 Cloud Realtime client (inbound-sync subscription transport).
 *
 * The rest of Org2Cloud talks to the backend over raw `fetch` to REST/RPC
 * (`org2CloudClient`, `org2CloudManagementClient`, `org2CloudBackendAdapter`).
 * This module is the ONLY place `@supabase/supabase-js` is used, and ONLY for
 * its Realtime (Postgres Changes) transport — it never replaces a data-fetch
 * path. Realtime events are treated as INVALIDATION signals: a change on a
 * subscribed table for an org tells the caller "re-pull with the existing RPC",
 * so all cursor / LWW / tombstone-absence logic stays in the sync engine.
 *
 * Endpoint + anon key come from `getCloudEndpoint()` (custom-backend aware).
 * Realtime authorization runs through the table's RLS SELECT policy, so the
 * connection must carry the signed-in user's access token; `setAuth` is called
 * on connect and again whenever the token is refreshed.
 */
import {
  type RealtimeChannel,
  type RealtimePostgresChangesPayload,
  type SupabaseClient,
  createClient,
} from "@supabase/supabase-js";

import { createLogger } from "@src/hooks/logger";
import { recordPushEvent } from "@src/util/monitoring/apiTracker";

import { getCloudEndpoint } from "./config";

const log = createLogger("Org2CloudRealtime");
const PRESENCE_TRACK_TIMEOUT_MS = 5_000;
const PRESENCE_TRACK_RETRY_MS = 1_000;
/** Ceiling for the presence-track retry backoff: a persistent server-side
 * rejection (RLS/policy) must idle near this cadence, not spin at 1 Hz. */
const PRESENCE_TRACK_RETRY_MAX_MS = 30_000;
const BROADCAST_RETRY_MS = 1_000;
/** Same ceiling rationale as presence-track: persistent broadcast failure
 * (rate limit, policy) idles near this cadence instead of spinning at 1 Hz. */
const BROADCAST_RETRY_MAX_MS = 30_000;
const MAX_PENDING_BROADCASTS = 100;
// Supabase Realtime's self-hosted/default client guard allows five Presence
// calls per WebSocket connection in a rolling 30-second window. This is
// separate from `eventsPerSecond` and covers track + untrack across ALL org
// channels on the connection. Keep the policy here so rapid navigation is
// coalesced/queued instead of silently losing the trailing truth.
const PRESENCE_CALLS_PER_WINDOW = 5;
const PRESENCE_CALL_WINDOW_MS = 30_000;
const PRESENCE_CALL_WINDOW_MARGIN_MS = 100;

/** Postgres schema every ORG2 Cloud table lives in. */
export const ORG2_CLOUD_SCHEMA = "org2_cloud";

/** Realtime change events we care about (soft-delete is an UPDATE). */
export type Org2CloudChangeEvent = "INSERT" | "UPDATE" | "DELETE";

export interface Org2CloudSubscribeOptions {
  /** Table name inside `org2_cloud` (e.g. `org_memberships`). */
  readonly table: string;
  /**
   * Postgres-changes row filter, e.g. `user_id=eq.<uuid>` or
   * `org_id=eq.<uuid>`. Omit to receive every authorized row change (RLS still
   * scopes it to what the user may SELECT).
   */
  readonly filter?: string;
  /** Fired for each matching change with the raw payload. */
  readonly onChange: (
    payload: RealtimePostgresChangesPayload<Record<string, unknown>>
  ) => void;
  /**
   * Fired when the channel's subscription status changes. `subscribed` is true
   * once the server confirms `SUBSCRIBED`; false on `CHANNEL_ERROR` /
   * `TIMED_OUT` / `CLOSED`. Callers use the true-edge to trigger a compensating
   * full re-pull (events missed while disconnected).
   */
  readonly onStatus?: (subscribed: boolean) => void;
}

/**
 * A live Realtime connection for one signed-in session/endpoint. Wraps a
 * single `SupabaseClient` (realtime-only) and the channels opened against it.
 * `dispose()` tears down every channel and the socket; create a fresh
 * connection on sign-in / endpoint switch.
 */
export interface Org2CloudPresenceOptions {
  /** Channel scope, e.g. `org:<orgId>` — becomes `presence:<scope>`. */
  readonly scope: string;
  /** Stable presence key for this client (the signed-in userId). */
  readonly key: string;
  /**
   * Initial tracked payload (displayName, viewingSessionId, …), or null when
   * this client is merely listening on the org channel. Inactive orgs must not
   * consume the connection-wide Presence budget with meaningless null metas.
   */
  readonly payload: Record<string, unknown> | null;
  /** Fired with the full channel presence state on every roster change. */
  readonly onSync: (
    state: Record<string, Array<Record<string, unknown>>>
  ) => void;
  /** Fired for every broadcast frame on this channel (any event name). */
  readonly onBroadcast?: (
    event: string,
    payload: Record<string, unknown>
  ) => void;
  /**
   * Fired on subscription status edges, like `Org2CloudSubscribeOptions.
   * onStatus`. When the backend broadcasts change signals on this channel
   * (0005), callers use the true-edge for missed-signal recovery — the same
   * role the dedicated signal channel's edge played on legacy backends.
   */
  readonly onStatus?: (subscribed: boolean) => void;
}

export interface Org2CloudPresenceHandle {
  /** Re-track with a payload, or publish an explicit idle view when no session is open. */
  update(payload: Record<string, unknown> | null): void;
  /** Fire-and-forget broadcast to every other peer on this channel. */
  send(event: string, payload: Record<string, unknown>): void;
  /** Untrack + leave the channel. */
  leave(): void;
}

export interface Org2CloudRealtimeConnection {
  /** Open a channel subscribed to one table's changes. */
  subscribe(options: Org2CloudSubscribeOptions): () => void;
  /** Join a Presence channel (ephemeral who-is-here state; never touches Postgres). */
  joinPresence(options: Org2CloudPresenceOptions): Org2CloudPresenceHandle;
  /** Re-run the token callback and push the result to the live socket. */
  setAuth(): void;
  /** Tear down all channels and the socket. */
  dispose(): void;
}

/**
 * Build a Realtime connection for the CURRENT endpoint, authenticated
 * through `getAccessToken`. The token is a CALLBACK, not a snapshot: the
 * socket re-runs it on every heartbeat (~25s) and channel (re)join, so a
 * JWT expiry can never strand the connection. A manually pushed token
 * would disable exactly that heartbeat refresh path
 * (`_manuallySetToken` in realtime-js), which silently killed
 * postgres_changes delivery — and with it every steady-state inbound
 * pull — one hour into any session that had no other reason to rotate
 * the auth atom. The client is realtime-only: auth auto-refresh and
 * session persistence are disabled (the app owns tokens via
 * `org2CloudAuthAtom`), so this never competes with the existing auth
 * machinery.
 */
export function createOrg2CloudRealtimeConnection(
  getAccessToken: () => Promise<string | null>
): Org2CloudRealtimeConnection {
  const endpoint = getCloudEndpoint();
  const client: SupabaseClient = createClient(
    endpoint.supabaseUrl,
    endpoint.anonKey,
    {
      accessToken: getAccessToken,
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      realtime: {
        params: { eventsPerSecond: 5 },
        // realtime-js defaults to a FIXED [1s,2s,5s,10s]+flat-10s schedule,
        // which phase-locks every client's reconnect after a shared outage;
        // the random spread staggers the fleet's rejoin (and therefore the
        // SUBSCRIBED-edge recovery reads) across a few seconds.
        reconnectAfterMs: (tries: number) =>
          ([1_000, 2_000, 5_000, 10_000][tries - 1] ?? 10_000) +
          Math.floor(Math.random() * 3_000),
      },
    }
  );
  // Argument-less: resolves through the callback and clears any manual-token
  // flag a constructor-time seed may have set, keeping the heartbeat refresh
  // path armed. Channel joins gate on this settling: the callback is async,
  // and a join that races ahead of it goes out without a JWT — private
  // channels (presence) then fail authorization outright instead of joining.
  const authReady = Promise.resolve(client.realtime.setAuth()).catch(
    () => undefined
  );

  const channels = new Set<RealtimeChannel>();
  let disposed = false;
  let channelSequence = 0;
  let presenceCallTail: Promise<void> = Promise.resolve();
  const presenceCallStartedAt: number[] = [];
  const schedulePresenceCall = <T>(operation: () => Promise<T>): Promise<T> => {
    const scheduled = presenceCallTail.then(async () => {
      let now = Date.now();
      while (
        presenceCallStartedAt.length > 0 &&
        now - presenceCallStartedAt[0]! >= PRESENCE_CALL_WINDOW_MS
      ) {
        presenceCallStartedAt.shift();
      }
      const oldest = presenceCallStartedAt[0];
      const waitMs =
        presenceCallStartedAt.length >= PRESENCE_CALLS_PER_WINDOW &&
        oldest !== undefined
          ? Math.max(
              0,
              PRESENCE_CALL_WINDOW_MS -
                (now - oldest) +
                PRESENCE_CALL_WINDOW_MARGIN_MS
            )
          : 0;
      if (waitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
      now = Date.now();
      while (
        presenceCallStartedAt.length > 0 &&
        now - presenceCallStartedAt[0]! >= PRESENCE_CALL_WINDOW_MS
      ) {
        presenceCallStartedAt.shift();
      }
      presenceCallStartedAt.push(now);
      return operation();
    });
    // One channel failure must not poison the connection-wide scheduler.
    presenceCallTail = scheduled.then(
      () => undefined,
      () => undefined
    );
    return scheduled;
  };

  const subscribe = (options: Org2CloudSubscribeOptions): (() => void) => {
    if (disposed) return () => undefined;
    const { table, filter, onChange, onStatus } = options;
    // Supabase 2.106+ reuses an existing same-topic channel. React cleanup is
    // synchronous but removeChannel() is async, so a fast resubscribe could
    // receive the still-joined channel and throw while adding callbacks. The
    // topic is not an authorization boundary (table RLS is), therefore each
    // subscription generation gets a connection-local suffix.
    const channelName = `org2:${table}:${filter ?? "*"}:${++channelSequence}`;
    const channel = client.channel(channelName);
    channel.on(
      // supabase-js overload: the literal 'postgres_changes' string.
      "postgres_changes" as never,
      {
        event: "*",
        schema: ORG2_CLOUD_SCHEMA,
        table,
        ...(filter ? { filter } : {}),
      },
      (payload: RealtimePostgresChangesPayload<Record<string, unknown>>) => {
        recordPushEvent("ws", `in · org2:${table}:postgres-changes`);
        try {
          onChange(payload);
        } catch (error) {
          log.warn(`realtime onChange handler threw for ${table}:`, error);
        }
      }
    );
    let wasEverTimedOut = false;
    let intentionallyRemoved = false;
    const joinChannel = () =>
      channel.subscribe((status) => {
        const subscribed = status === "SUBSCRIBED";
        if (!subscribed && status === "CLOSED") {
          // A closed channel never rejoins on its own (phoenix `joinedOnce`),
          // so an UNEXPECTED server-side close is exactly the silent-death
          // shape worth finding in the console later — but our own
          // unsubscribe/teardown also lands here and is routine.
          if (!intentionallyRemoved && !disposed) {
            log.warn(`realtime channel ${channelName} closed`);
          }
        } else if (!subscribed) {
          wasEverTimedOut = true;
          log.warn(`realtime channel ${channelName} status: ${status}`);
        } else if (subscribed && wasEverTimedOut) {
          // Supabase rejoins with exponential backoff after TIMED_OUT /
          // CHANNEL_ERROR; log the recovery so a transient blip is
          // distinguishable from a persistent failure in the console.
          log.info(`realtime channel ${channelName} recovered (SUBSCRIBED)`);
        }
        onStatus?.(subscribed);
      });
    void authReady.then(() => {
      if (disposed || intentionallyRemoved) return;
      joinChannel();
    });
    channels.add(channel);
    return () => {
      intentionallyRemoved = true;
      channels.delete(channel);
      void client.removeChannel(channel);
    };
  };

  const joinPresence = (
    options: Org2CloudPresenceOptions
  ): Org2CloudPresenceHandle => {
    if (disposed) {
      return {
        update: () => undefined,
        send: () => undefined,
        leave: () => undefined,
      };
    }
    const { scope, key, payload, onSync, onBroadcast, onStatus } = options;
    // Private: presence roster + broadcast nudges are org-scoped, gated by the
    // RLS policy on realtime.messages for topic `presence:<scope>` (setAuth
    // carries the JWT the authorization check needs).
    //
    // CONTRACT: unlike postgres channels, the presence topic CANNOT carry a
    // connection-local sequence suffix — peers only see each other when they
    // join the exact same topic, and the RLS policy authorizes that exact
    // topic string. joinPresence therefore must not be called again for a
    // scope whose previous handle has not finished leaving ON THE SAME
    // CONNECTION; the one production caller (useOrg2CloudRealtime) satisfies
    // this by rebuilding the whole connection on every user/endpoint/org
    // change instead of rejoining in place.
    const channel = client.channel(`presence:${scope}`, {
      config: { private: true, presence: { key } },
    });
    let latestPayload: Record<string, unknown> | null = payload;
    // Keep enough identity metadata to publish an explicit "online, not
    // viewing" state. Repeated untrack -> track cycles on a private channel
    // can leave peers holding the previous meta even after untrack resolves
    // `ok`; replacing the meta is both observable and matches org Presence's
    // online/viewing dual purpose.
    let lastTrackedPayload: Record<string, unknown> | null = payload;
    let subscribed = false;
    let published = false;
    let desiredTrackVersion = 1;
    let appliedTrackVersion = 0;
    let tracking = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const pendingBroadcasts = new Map<
      string,
      { event: string; payload: Record<string, unknown> }
    >();
    let broadcasting = false;
    let broadcastRetryTimer: ReturnType<typeof setTimeout> | null = null;
    let broadcastFailureStreak = 0;
    const scheduleBroadcastRetry = () => {
      if (!subscribed || broadcastRetryTimer !== null) return;
      const delay = Math.min(
        BROADCAST_RETRY_MS * 2 ** Math.min(broadcastFailureStreak, 10),
        BROADCAST_RETRY_MAX_MS
      );
      broadcastRetryTimer = setTimeout(() => {
        broadcastRetryTimer = null;
        void flushPendingBroadcasts();
      }, delay);
    };
    const flushPendingBroadcasts = async (): Promise<void> => {
      if (!subscribed || broadcasting || pendingBroadcasts.size === 0) return;
      broadcasting = true;
      try {
        while (subscribed && pendingBroadcasts.size > 0) {
          const first = pendingBroadcasts.entries().next().value as
            | [string, { event: string; payload: Record<string, unknown> }]
            | undefined;
          if (!first) return;
          const [id, frame] = first;
          try {
            const result = await channel.send({
              type: "broadcast",
              event: frame.event,
              payload: frame.payload,
            });
            if (result !== "ok") {
              log.warn(
                `broadcast ${frame.event} failed for ${scope}: ${String(result)}`
              );
              // Schedule BEFORE bumping the streak: the first retry stays at
              // the fast base delay; only consecutive failures back off.
              scheduleBroadcastRetry();
              broadcastFailureStreak += 1;
              return;
            }
            pendingBroadcasts.delete(id);
            broadcastFailureStreak = 0;
          } catch (error) {
            log.warn(`broadcast ${frame.event} failed for ${scope}:`, error);
            scheduleBroadcastRetry();
            broadcastFailureStreak += 1;
            return;
          }
        }
      } finally {
        broadcasting = false;
      }
    };
    let trackFailureStreak = 0;
    const scheduleTrackRetry = () => {
      if (!subscribed || retryTimer !== null) return;
      // Exponential backoff, capped: transient blips retry fast, a
      // persistently rejected track (bad policy/token) settles at the
      // ceiling instead of retrying at 1 Hz for the channel's lifetime.
      const delay = Math.min(
        PRESENCE_TRACK_RETRY_MS * 2 ** Math.min(trackFailureStreak, 10),
        PRESENCE_TRACK_RETRY_MAX_MS
      );
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void flushLatestPayload();
      }, delay);
    };
    const flushLatestPayload = async (): Promise<void> => {
      if (!subscribed || tracking) return;
      tracking = true;
      try {
        // Supabase Presence does not serialize concurrent track() calls for
        // us. Coalesce rapid navigation (session → none → session) while a
        // send is in flight, then immediately publish the newest payload.
        while (subscribed && appliedTrackVersion < desiredTrackVersion) {
          const version = desiredTrackVersion;
          const nextPayload = latestPayload;
          // Listening before this client has published a view is intentionally
          // untracked. Applying null is then a local no-op and must not consume
          // one of the five server calls.
          if (nextPayload === null && !published) {
            appliedTrackVersion = version;
            continue;
          }
          const wirePayload =
            nextPayload === null
              ? {
                  ...(lastTrackedPayload ?? {}),
                  viewingSessionId: null,
                  updatedAt: Date.now(),
                }
              : nextPayload;
          try {
            const result = await schedulePresenceCall(async () => {
              if (!subscribed) return "ok" as const;
              let timeout: ReturnType<typeof setTimeout> | undefined;
              try {
                return await Promise.race([
                  channel.track(wirePayload),
                  new Promise<"timed out">((resolve) => {
                    timeout = setTimeout(
                      () => resolve("timed out"),
                      PRESENCE_TRACK_TIMEOUT_MS
                    );
                  }),
                ]);
              } finally {
                if (timeout !== undefined) clearTimeout(timeout);
              }
            });
            if (result !== "ok") {
              throw new Error(`presence call returned ${String(result)}`);
            }
            published = true;
            lastTrackedPayload = wirePayload;
            appliedTrackVersion = version;
            trackFailureStreak = 0;
          } catch (error) {
            log.warn(`presence track failed for ${scope}:`, error);
            if (desiredTrackVersion > version) {
              // A newer payload is already waiting. Retire only this failed
              // attempt and continue immediately with the current truth.
              trackFailureStreak += 1;
              appliedTrackVersion = version;
              continue;
            }
            // Schedule BEFORE bumping the streak: the first retry stays at
            // the fast base delay; only consecutive failures back off.
            scheduleTrackRetry();
            trackFailureStreak += 1;
            return;
          }
        }
      } finally {
        tracking = false;
      }
    };
    const emit = () => {
      recordPushEvent("ws", `in · org2:${scope}:presence-sync`);
      try {
        onSync(
          channel.presenceState() as Record<
            string,
            Array<Record<string, unknown>>
          >
        );
      } catch (error) {
        log.warn(`presence onSync handler threw for ${scope}:`, error);
      }
    };
    channel.on("presence", { event: "sync" }, emit);
    if (onBroadcast) {
      channel.on("broadcast", { event: "*" }, (frame) => {
        recordPushEvent("ws", `in · org2:${scope}:broadcast`);
        try {
          onBroadcast(
            String((frame as { event?: unknown }).event ?? ""),
            ((frame as { payload?: unknown }).payload ?? {}) as Record<
              string,
              unknown
            >
          );
        } catch (error) {
          log.warn(`broadcast handler threw for ${scope}:`, error);
        }
      });
    }
    let wasEverTimedOut = false;
    let intentionallyLeft = false;
    const joinChannel = () =>
      channel.subscribe((status) => {
        if (status === "SUBSCRIBED") {
          subscribed = true;
          published = false;
          // A fresh SUBSCRIBED edge means the transport recovered; retry fast
          // again instead of inheriting the previous failure streak's ceiling.
          trackFailureStreak = 0;
          broadcastFailureStreak = 0;
          if (wasEverTimedOut) {
            log.info(`presence channel ${scope} recovered (SUBSCRIBED)`);
          }
          // A reconnect has no server-side meta even if the local version was
          // previously applied, so force the latest payload onto the channel.
          desiredTrackVersion += 1;
          void flushLatestPayload();
          void flushPendingBroadcasts();
        } else if (status !== "CLOSED") {
          subscribed = false;
          published = false;
          wasEverTimedOut = true;
          log.warn(`presence channel ${scope} status: ${status}`);
        } else {
          subscribed = false;
          published = false;
        }
        onStatus?.(status === "SUBSCRIBED");
      });
    void authReady.then(() => {
      if (disposed || intentionallyLeft) return;
      joinChannel();
    });
    channels.add(channel);
    return {
      update: (nextPayload) => {
        latestPayload = nextPayload;
        desiredTrackVersion += 1;
        void flushLatestPayload();
      },
      send: (event, sendPayload) => {
        // A comment mutation can land while the private channel is briefly
        // reconnecting. Supabase accepts `send()` locally in that state but
        // the frame never reaches peers, so retain invalidation nudges until
        // SUBSCRIBED and retry transport failures. Duplicate payloads are
        // coalesced because these frames carry invalidations, not data.
        const id = JSON.stringify([event, sendPayload]);
        pendingBroadcasts.set(id, { event, payload: sendPayload });
        if (pendingBroadcasts.size > MAX_PENDING_BROADCASTS) {
          const oldest = pendingBroadcasts.keys().next().value as
            | string
            | undefined;
          if (oldest) pendingBroadcasts.delete(oldest);
        }
        void flushPendingBroadcasts();
      },
      leave: () => {
        intentionallyLeft = true;
        subscribed = false;
        published = false;
        if (retryTimer !== null) {
          clearTimeout(retryTimer);
          retryTimer = null;
        }
        if (broadcastRetryTimer !== null) {
          clearTimeout(broadcastRetryTimer);
          broadcastRetryTimer = null;
        }
        pendingBroadcasts.clear();
        channels.delete(channel);
        // Leaving/removing the channel clears its Presence meta server-side;
        // a separate untrack would waste the shared five-call budget.
        void client.removeChannel(channel);
      },
    };
  };

  const setAuth = (): void => {
    if (disposed) return;
    void client.realtime.setAuth();
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    for (const channel of channels) void client.removeChannel(channel);
    channels.clear();
    void client.removeAllChannels();
    void client.realtime.disconnect();
  };

  return { subscribe, joinPresence, setAuth, dispose };
}
