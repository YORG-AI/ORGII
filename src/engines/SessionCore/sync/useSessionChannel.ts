/**
 * useSessionChannel — Tauri IPC Channel subscription for session events
 *
 * Subscribes to the Rust backend's ChannelRegistry for a specific session_id.
 * Events are delivered via Tauri's IPC Channel mechanism, replacing raw
 * WebSocket connections for session-scoped events.
 *
 * On mount: invokes `subscribe_session_events` with a Channel callback.
 *   The backend returns a unique `channelId` for this registration.
 * On unmount: invokes `unsubscribe_session_events` with the exact
 *   `channelId`, so only THIS channel is removed — other channels for the
 *   same session (from a concurrent re-mount) are not affected.
 *
 * ## Race-condition hardening
 *
 * Three failure shapes are explicitly defended against:
 *
 *   1. **Cleanup before subscribe resolves.** A fast session switch
 *      can fire the cleanup function before the backend has assigned a
 *      `channelId`. We chain the unsubscribe onto the subscribe promise
 *      so we always have the correct id to send, even if it arrives
 *      after the React effect is gone.
 *
 *   2. **Late events on a stale channel.** Tauri may deliver a message
 *      on the OLD channel between the time we call `unsubscribe_session_events`
 *      and the time the backend actually processes it. Without
 *      gating, those messages would be forwarded to the CURRENT
 *      `onEvent` (which is updated via a ref), so a session-A event
 *      could end up applied to session-B's adapter. We gate every
 *      message through a per-effect `destroyed` flag that is set
 *      synchronously in cleanup, so post-cleanup deliveries are
 *      dropped cleanly.
 *
 *   3. **Silent unsubscribe failures.** The previous implementation
 *      swallowed unsubscribe rejections with `.catch(() => {})`,
 *      hiding diagnostic information when the backend refused the
 *      call (registry mismatch, dead session, transport error). We
 *      log a warning so the leak — if any — is at least visible in
 *      the console.
 *
 * The race-condition logic itself is exposed as
 * {@link SessionChannelLifecycle} so it can be unit-tested without a
 * React renderer.
 */
import { Channel, invoke } from "@tauri-apps/api/core";
import { useEffect, useRef } from "react";

import { parseRawSessionEvent } from "@src/engines/SessionCore/core/schemas";
import { createLogger } from "@src/hooks/logger";
import { recordPushEvent } from "@src/util/monitoring/apiTracker";

const log = createLogger("useSessionChannel");

/**
 * Session id for the global UI-control IPC channel. Rust broadcasts
 * session-less `agent:ade_action` frames to every registered channel;
 * mounting a dedicated listener on this id keeps ADE bridge traffic on
 * the shared multiplex registry instead of a raw one-off subscribe.
 */
export const GLOBAL_UI_CHANNEL_SESSION_ID = "";

const readySessionChannels = new Set<string>();
const readySessionChannelWaiters = new Map<string, Set<() => void>>();
type SessionEventListener = (raw: string) => void;

interface SharedSessionChannel {
  channel: Channel<string>;
  lifecycle: SessionChannelLifecycle;
  listeners: Set<SessionEventListener>;
}

const sharedSessionChannels = new Map<string, SharedSessionChannel>();

function markSessionChannelReady(sessionId: string): void {
  readySessionChannels.add(sessionId);
  const waiters = readySessionChannelWaiters.get(sessionId);
  if (!waiters) return;
  readySessionChannelWaiters.delete(sessionId);
  for (const resolve of waiters) resolve();
}

/**
 * Wait until the active SessionSyncProvider has registered the per-session IPC
 * channel. New fork sessions can complete very quickly; dispatching before this
 * edge can lose the terminal event and leave only the optimistic running state.
 *
 * Resolves `true` when the channel registered, `false` on timeout. A timeout
 * means NO surface has mounted the session's channel — every lifecycle frame
 * (agent:complete, queue_status) for a dispatch made now will be dropped at
 * the bus registry and the turn will only end via the 60s planning-indicator
 * watchdog. Callers must surface this loudly instead of dispatching as if
 * ready.
 */
export async function waitForSessionChannelReady(
  sessionId: string,
  timeoutMs = 5_000
): Promise<boolean> {
  if (readySessionChannels.has(sessionId)) return true;
  return new Promise<boolean>((resolve) => {
    const waiters = readySessionChannelWaiters.get(sessionId) ?? new Set();
    readySessionChannelWaiters.set(sessionId, waiters);
    const timer = setTimeout(() => {
      waiters.delete(wrappedResolve);
      if (waiters.size === 0) readySessionChannelWaiters.delete(sessionId);
      log.warn(
        `[SessionChannel] channel for ${sessionId} not registered after ` +
          `${timeoutMs}ms — no surface mounted it; lifecycle frames for ` +
          `dispatches made now will be lost until a session view mounts`
      );
      resolve(false);
    }, timeoutMs);
    const wrappedResolve = () => {
      clearTimeout(timer);
      resolve(true);
    };
    waiters.add(wrappedResolve);
  });
}

export function validateSessionChannelMessage(message: string): string {
  parseRawSessionEvent(message);
  return message;
}

/**
 * Drivers required by {@link SessionChannelLifecycle} so the
 * lifecycle logic stays decoupled from Tauri and React. The hook
 * supplies concrete implementations backed by `invoke` / `Channel`;
 * tests supply mocks.
 */
export interface SessionChannelDrivers {
  /** Subscribe; returns the backend-assigned channel id. */
  subscribe: () => Promise<number>;
  /** Unsubscribe a previously-subscribed channel id. */
  unsubscribe: (channelId: number) => Promise<void>;
  /** Hook for warnings — typically `console.warn`. */
  warn: (message: string, error?: unknown) => void;
}

/**
 * Lifecycle state machine for a single `useSessionChannel` effect
 * invocation. Tracks the destroyed flag, queues the unsubscribe
 * behind the subscribe promise, and drops late events deterministically.
 *
 * Use:
 *   const lifecycle = new SessionChannelLifecycle("session-1", drivers);
 *   lifecycle.start();
 *   // ...
 *   lifecycle.onMessage(rawJson); // returns true if delivered, false if dropped
 *   // ...
 *   lifecycle.dispose();
 */
export class SessionChannelLifecycle {
  private readonly sessionId: string;
  private readonly drivers: SessionChannelDrivers;
  private readonly onDelivered: (raw: string) => void;
  private destroyed = false;
  private subscribePromise: Promise<number | null> | null = null;
  // For tests / diagnostics: keep the latest assigned channelId.
  private channelId: number | null = null;

  constructor(
    sessionId: string,
    drivers: SessionChannelDrivers,
    onDelivered: (raw: string) => void
  ) {
    this.sessionId = sessionId;
    this.drivers = drivers;
    this.onDelivered = onDelivered;
  }

  /**
   * Kick off the subscribe IPC. Idempotent — subsequent calls
   * return the same in-flight promise. Failure is reported via
   * `drivers.warn` (unless already destroyed) and resolves to
   * `null`, signalling "no channel id; no unsubscribe needed".
   */
  start(): Promise<number | null> {
    if (this.subscribePromise !== null) return this.subscribePromise;
    this.subscribePromise = this.drivers.subscribe().then(
      (channelId) => {
        this.channelId = channelId;
        return channelId;
      },
      (err) => {
        if (!this.destroyed) {
          this.drivers.warn(
            `[SessionChannel] Failed to subscribe (session=${this.sessionId}):`,
            err
          );
        }
        return null;
      }
    );
    return this.subscribePromise;
  }

  /**
   * Deliver a message. Returns `true` if it was forwarded to the
   * consumer, `false` if it was dropped because the lifecycle is
   * already torn down. Validation failures inside `onDelivered`
   * are caught and reported as warnings — they never bubble up.
   */
  onMessage(raw: string): boolean {
    if (this.destroyed) return false;
    try {
      this.onDelivered(validateSessionChannelMessage(raw));
      return true;
    } catch (error) {
      this.drivers.warn(
        "[SessionChannel] Dropped invalid event payload:",
        error
      );
      return false;
    }
  }

  /**
   * Final tear-down. Sets the `destroyed` flag (which blocks
   * subsequent `onMessage` deliveries) and queues an `unsubscribe`
   * IPC behind whatever the subscribe promise resolves to. Both
   * paths log on failure rather than swallowing silently.
   *
   * Returns a promise that resolves once the unsubscribe has either
   * gone out the door or been short-circuited because no channel
   * id was ever assigned. Callers don't need to await it — it's
   * exposed for tests that want to assert on the post-cleanup
   * state.
   */
  dispose(): Promise<void> {
    if (this.destroyed) return Promise.resolve();
    this.destroyed = true;
    const inFlight = this.subscribePromise;
    if (inFlight === null) return Promise.resolve();
    return inFlight
      .then((channelId) => {
        if (channelId === null) return;
        return this.drivers.unsubscribe(channelId).catch((err) => {
          this.drivers.warn(
            `[SessionChannel] Failed to unsubscribe (session=${this.sessionId}, channelId=${channelId}):`,
            err
          );
        });
      })
      .then(() => undefined);
  }

  /** Whether `dispose()` has been called. */
  isDestroyed(): boolean {
    return this.destroyed;
  }

  /** Channel id once assigned by the backend, otherwise `null`. */
  getChannelId(): number | null {
    return this.channelId;
  }
}

/**
 * Share one backend IPC channel among every mounted consumer of a session.
 *
 * Work-item previews, file lists, and the full SessionCore can coexist. A
 * subscriber adds only a callback; the first subscriber owns the backend
 * registration and the last subscriber tears it down.
 */
export function subscribeToSessionEvents(
  sessionId: string,
  listener: SessionEventListener
): () => void {
  let shared = sharedSessionChannels.get(sessionId);
  if (!shared) {
    const channel = new Channel<string>();
    const listeners = new Set<SessionEventListener>();
    const lifecycle = new SessionChannelLifecycle(
      sessionId,
      {
        subscribe: () =>
          invoke<number>("subscribe_session_events", {
            sessionId,
            onEvent: channel,
          }),
        unsubscribe: (channelId) =>
          invoke("unsubscribe_session_events", {
            sessionId,
            channelId,
          }) as Promise<void>,
        warn: (message, error) => log.warn(message, error),
      },
      (raw) => {
        if (listeners.size === 0) {
          log.warn(
            `[SessionChannel] delivered frame for ${sessionId} had no ` +
              `subscribers; the backend channel outlived every consumer`
          );
          return;
        }
        for (const subscriber of [...listeners]) {
          try {
            subscriber(raw);
          } catch (error) {
            log.warn(
              `[SessionChannel] Subscriber failed (session=${sessionId}):`,
              error
            );
          }
        }
      }
    );
    shared = { channel, lifecycle, listeners };
    listeners.add(listener);
    sharedSessionChannels.set(sessionId, shared);

    channel.onmessage = (message: string) => {
      recordPushEvent("channel", "session-events");
      if (
        message.includes('"agent:complete"') ||
        message.includes('"agent:error"')
      ) {
        log.info(
          `[SessionChannel] lifecycle frame arrived for ${sessionId} ` +
            `(destroyed=${lifecycle.isDestroyed()})`
        );
      }
      lifecycle.onMessage(message);
    };
    void lifecycle.start().then((channelId) => {
      if (
        channelId !== null &&
        !lifecycle.isDestroyed() &&
        sharedSessionChannels.get(sessionId)?.lifecycle === lifecycle
      ) {
        markSessionChannelReady(sessionId);
      }
    });
  }

  shared.listeners.add(listener);
  // Re-subscribing onto a channel that is still registered must re-assert
  // readiness: `readySessionChannels` is cleared on the last unsubscribe, and
  // without this a later consumer would wait out the full readiness timeout
  // (and dispatch believing no channel exists) even though the backend
  // registration never went away.
  if (shared.lifecycle.getChannelId() !== null) {
    markSessionChannelReady(sessionId);
  }
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const current = sharedSessionChannels.get(sessionId);
    if (!current) return;
    current.listeners.delete(listener);
    if (current.listeners.size > 0) return;

    sharedSessionChannels.delete(sessionId);
    readySessionChannels.delete(sessionId);
    current.channel.onmessage = () => undefined;
    void current.lifecycle.dispose();
  };
}

/**
 * Subscribe to Tauri IPC Channel events for a specific session.
 *
 * @param sessionId - Session to subscribe to (null = no subscription)
 * @param onEvent - Callback invoked with the raw JSON string for each event
 */
export function useSessionChannel(
  sessionId: string | null,
  onEvent: (raw: string) => void
): void {
  // Keep the latest `onEvent` reachable from the long-lived channel
  // callback without retriggering the subscribe effect every time
  // the consumer reshuffles its closure.
  const onEventRef = useRef(onEvent);
  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    if (!sessionId) return;
    return subscribeToSessionEvents(sessionId, (raw) =>
      onEventRef.current(raw)
    );
  }, [sessionId]);
}
