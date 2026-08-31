/**
 * UnloadedTurnBubble
 *
 * Renders in place of a turn whose body was windowed out of the initial
 * load (see PR #561 — imported sessions only materialize the newest turn
 * body plus placeholder chunks on open, to keep a 500MB+ transcript from
 * being fully loaded into memory).
 *
 * The Rust projectors (Codex app / imported-history / Cursor IDE turn
 * loaders) stamp a raw "Codex turn <id> is not loaded yet." observation
 * string onto the placeholder chunk for the chat panel's own group-header
 * affordance to intercept. The Communication ("Messages") app inside the
 * Workstation replay panel builds its own flat transcript straight from
 * `SessionEvent.result`, so without this component it rendered that raw
 * placeholder text verbatim as if it were the agent's real reply.
 *
 * Unlike the chat panel's click-to-expand `TurnCollapsePinBar`, this
 * surface has no per-turn collapse affordance to hang a manual expand
 * control on — it's a passive scrub/replay view. So the fetch fires
 * automatically once the placeholder scrolls into the app's rendered
 * window (bounded by `MAX_APP_HYDRATION_WINDOW` / `MESSAGE_INITIAL_
 * RENDERED_MESSAGE_COUNT`, so this never re-materializes the full
 * transcript — only the handful of turns currently on screen).
 *
 * Eviction-aware retry: many placeholders can mount at once (e.g.
 * "communication-load-more-messages" reveals a dozen rounds in one go).
 * `MAX_LOADED_HISTORICAL_TURN_BODIES` bounds how many turn bodies stay
 * resident, so a sibling placeholder's own load can evict this one's body
 * moments after it lands, before this bubble ever gets to render it — see
 * `mountedTurnPlaceholders.ts`. `UnloadedTurnBubbleContent` below expects to
 * unmount on its own once `../config.ts` drops this placeholder's
 * `MessageEntry` (its body merged into the stream — see
 * `findResolvedUnloadedTurnPlaceholderIds` there for why that dedup lives in
 * this surface rather than relying on the Rust `EventStore` to have removed
 * the placeholder). "Still mounted a beat after our own load resolved" is
 * only treated as real eviction when `isTurnBodyLoaded` confirms the body
 * isn't resident; otherwise retries are suppressed rather than spinning (or
 * falsely reporting "tap to retry") over content that already loaded. When
 * eviction is confirmed, retries a bounded number of times before falling
 * back to a manual "tap to retry" affordance instead of spinning forever.
 */
import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { AgentOrgRunMemberView } from "@src/api/tauri/agent";
import {
  CHAT_BUBBLE_WIDTH_TOKENS,
  ChatBubbleAvatar,
  ChatBubbleHeader,
  ChatBubbleLayout,
} from "@src/components/ChatBubble";
import { SESSION_UI_TOKENS } from "@src/engines/ChatPanel/blocks/primitives/config";
import {
  getMountedTurnPlaceholderIds,
  isTurnBodyLoaded,
  loadSessionTurnBodyIntoStore,
  pruneLoadedTurnBodies,
  registerMountedTurnPlaceholder,
  unregisterMountedTurnPlaceholder,
} from "@src/engines/SessionCore/turns";
import { createLogger } from "@src/hooks/logger";
import { HugeiconsIcon, Loading03Icon, RotateClockwiseIcon } from "@src/icons";
import {
  formatSmartDateTime,
  toIntlLocaleTag,
} from "@src/util/data/formatters/date";

import { useCommunicationAgentIdentity } from "../communicationAgentIdentity";
import type { CommunicationUnloadedTurnMeta, MessageEntry } from "../types";
import {
  UNLOADED_TURN_RETRY_DELAY_MS,
  decideUnloadedTurnRetry,
} from "./unloadedTurnRetry";

const log = createLogger("UnloadedTurnBubble");

interface UnloadedTurnBubbleProps {
  message: MessageEntry;
  unloadedTurn: CommunicationUnloadedTurnMeta;
  onClick?: () => void;
  orgMembers?: ReadonlyArray<AgentOrgRunMemberView>;
}

interface UnloadedTurnBubbleContentProps extends UnloadedTurnBubbleProps {
  sessionId: string | null | undefined;
  turnId: string;
}

/**
 * Owns the fetch/retry lifecycle for a single `sessionId:turnId`. Split out
 * from `UnloadedTurnBubble` and given a `key` scoped to that pair (see the
 * default export below) so a turnId change on an otherwise-still-mounted
 * placeholder gets a genuinely fresh mount — React resets all local
 * state/refs for free, which sidesteps hand-rolled reset logic (and the
 * lint rules against mutating refs or synchronously calling setState during
 * render/effects to fake that reset).
 */
const UnloadedTurnBubbleContent: React.FC<UnloadedTurnBubbleContentProps> = ({
  message,
  onClick,
  orgMembers,
  sessionId,
  turnId,
}) => {
  const { t, i18n } = useTranslation(["common", "sessions"]);
  const { rawAgentName, agentIcon } = useCommunicationAgentIdentity(
    message.event,
    orgMembers
  );

  // `retryToken` forces the fetch effect below to re-run on demand
  // (automatic retry or the manual "tap to retry" affordance);
  // `retryAttemptRef` tracks how many automatic retries have already fired
  // so `decideUnloadedTurnRetry` can cap them.
  const [retryToken, setRetryToken] = useState(0);
  const [showRetryAffordance, setShowRetryAffordance] = useState(false);
  const retryAttemptRef = useRef(0);

  useEffect(() => {
    if (!sessionId || !turnId) return;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    registerMountedTurnPlaceholder(sessionId, turnId);

    void loadSessionTurnBodyIntoStore({ sessionId, turnId })
      .then(async () => {
        if (cancelled) return;
        // Protect every placeholder currently mounted for this session (not
        // just our own turnId) — otherwise a concurrent sibling's prune call
        // can evict a body the instant it lands, and that sibling never
        // refetches on its own. See mountedTurnPlaceholders.ts.
        const protectedTurnIds = new Set(
          getMountedTurnPlaceholderIds(sessionId)
        );
        protectedTurnIds.add(turnId);
        await pruneLoadedTurnBodies(sessionId, protectedTurnIds);
        if (cancelled) return;

        // If we're still mounted a beat after our own load resolved, that
        // alone doesn't mean eviction happened — the Communication surface
        // is expected to drop this placeholder's `MessageEntry` once its
        // body is visible elsewhere in the stream (see
        // `findResolvedUnloadedTurnPlaceholderIds` in `../config.ts`), so a
        // healthy load unmounts this bubble on its own. Gate the retry
        // decision on the actual eviction signal instead of mount-state:
        // `isTurnBodyLoaded` reflects `loadedTurnRegistry`'s bookkeeping,
        // which only forgets a turn when `pruneLoadedTurnBodies` evicts it.
        // If the body is still resident, "still mounted" is a rendering lag
        // (or a bug in the surface's own dedup) rather than a lost body —
        // never spin into a retry loop or a false "tap to retry" over
        // content that already loaded successfully.
        retryTimer = setTimeout(() => {
          if (cancelled) return;
          if (isTurnBodyLoaded(sessionId, turnId)) {
            log.warn(
              `Unloaded-turn placeholder for ${turnId} is still mounted but its body is resident — suppressing retry.`
            );
            return;
          }
          const decision = decideUnloadedTurnRetry(retryAttemptRef.current);
          if (!decision.shouldRetry) {
            setShowRetryAffordance(true);
            return;
          }
          retryAttemptRef.current = decision.nextAttempt;
          setRetryToken((token) => token + 1);
        }, UNLOADED_TURN_RETRY_DELAY_MS);
      })
      .catch((error) => {
        // Fire-and-forget: a failed lazy load must never surface as an
        // unhandled rejection (GlobalErrorHandler escalates those to the
        // fatal full-screen error page). The placeholder just stays put —
        // if the user scrubs away and back, the effect retries.
        log.warn(`Unloaded-turn fetch failed for ${turnId}:`, error);
      });
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      unregisterMountedTurnPlaceholder(sessionId, turnId);
    };
  }, [sessionId, turnId, retryToken]);

  const handleManualRetry = (event: React.MouseEvent) => {
    event.stopPropagation();
    setShowRetryAffordance(false);
    retryAttemptRef.current = 0;
    setRetryToken((token) => token + 1);
  };

  const senderName = t(
    "simulator.replay.messages.bubble.senderTitle.turnLoading",
    {
      ns: "sessions",
      subject: rawAgentName,
      defaultValue: "{{subject}}'s message is loading…",
    }
  );
  const loadingBody = t("simulator.replay.messages.unloadedTurn.loadingBody", {
    ns: "sessions",
    defaultValue: "Loading message…",
  });
  const retryBody = t("simulator.replay.messages.unloadedTurn.retryBody", {
    ns: "sessions",
    defaultValue: "Message didn't load — tap to retry",
  });

  return (
    <ChatBubbleLayout
      align="left"
      onClick={onClick}
      interactive={false}
      className={CHAT_BUBBLE_WIDTH_TOKENS.row}
      avatar={
        <ChatBubbleAvatar className="h-8 w-8 bg-fill-2" icon={agentIcon} />
      }
      dataAttr={{ "data-testid": "communication-unloaded-turn-bubble" }}
    >
      <ChatBubbleHeader
        senderName={senderName}
        timestamp={formatSmartDateTime(message.timestamp, {
          yesterdayLabel: t("relativeDate.yesterday"),
          locale: toIntlLocaleTag(i18n.resolvedLanguage),
        })}
        align="left"
      />
      <div
        className={`${CHAT_BUBBLE_WIDTH_TOKENS.body} rounded-lg bg-fill-1 p-3 text-left text-text-1`}
      >
        {showRetryAffordance ? (
          <button
            type="button"
            onClick={handleManualRetry}
            data-testid="communication-unloaded-turn-retry"
            className={`flex w-full items-center gap-2 rounded border-0 bg-transparent p-0 text-left italic text-text-3 transition-colors hover:text-text-1 ${SESSION_UI_TOKENS.TEXT.BODY_BASE}`}
          >
            <HugeiconsIcon
              icon={RotateClockwiseIcon}
              data-icon="rotate-cw"
              size={13}
              strokeWidth={2}
              className="shrink-0"
            />
            {retryBody}
          </button>
        ) : (
          <div
            className={`flex items-center gap-2 italic text-text-3 ${SESSION_UI_TOKENS.TEXT.BODY_BASE}`}
          >
            <HugeiconsIcon
              icon={Loading03Icon}
              data-icon="loader-2"
              size={13}
              strokeWidth={2}
              className="shrink-0 animate-spin"
            />
            {loadingBody}
          </div>
        )}
      </div>
    </ChatBubbleLayout>
  );
};
UnloadedTurnBubbleContent.displayName = "UnloadedTurnBubbleContent";

export const UnloadedTurnBubble: React.FC<UnloadedTurnBubbleProps> = (
  props
) => {
  const sessionId = props.message.event.sessionId;
  const turnId = props.unloadedTurn.turnId;
  return (
    <UnloadedTurnBubbleContent
      // Scoping the key to session+turn means a turnId change (rare, but
      // possible across a windowed replace reload) gets a clean remount
      // instead of carrying stale retry state from a different turn.
      key={`${sessionId ?? ""}:${turnId}`}
      {...props}
      sessionId={sessionId}
      turnId={turnId}
    />
  );
};

UnloadedTurnBubble.displayName = "UnloadedTurnBubble";

export default UnloadedTurnBubble;
