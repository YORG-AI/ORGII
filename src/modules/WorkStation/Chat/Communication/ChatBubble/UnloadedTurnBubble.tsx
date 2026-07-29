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
 */
import { Loader2 } from "lucide-react";
import React, { useEffect } from "react";
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
  loadSessionTurnBodyIntoStore,
  pruneLoadedTurnBodies,
} from "@src/engines/SessionCore/turns";
import { createLogger } from "@src/hooks/logger";
import {
  formatSmartDateTime,
  toIntlLocaleTag,
} from "@src/util/data/formatters/date";

import { useCommunicationAgentIdentity } from "../communicationAgentIdentity";
import type { CommunicationUnloadedTurnMeta, MessageEntry } from "../types";

const log = createLogger("UnloadedTurnBubble");

interface UnloadedTurnBubbleProps {
  message: MessageEntry;
  unloadedTurn: CommunicationUnloadedTurnMeta;
  onClick?: () => void;
  orgMembers?: ReadonlyArray<AgentOrgRunMemberView>;
}

export const UnloadedTurnBubble: React.FC<UnloadedTurnBubbleProps> = ({
  message,
  unloadedTurn,
  onClick,
  orgMembers,
}) => {
  const { t, i18n } = useTranslation(["common", "sessions"]);
  const { rawAgentName, agentIcon } = useCommunicationAgentIdentity(
    message.event,
    orgMembers
  );
  const sessionId = message.event.sessionId;
  const turnId = unloadedTurn.turnId;

  useEffect(() => {
    if (!sessionId || !turnId) return;
    let cancelled = false;
    void loadSessionTurnBodyIntoStore({ sessionId, turnId })
      .then(async () => {
        if (cancelled) return;
        await pruneLoadedTurnBodies(sessionId, [turnId]);
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
    };
  }, [sessionId, turnId]);

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
        <div
          className={`flex items-center gap-2 italic text-text-3 ${SESSION_UI_TOKENS.TEXT.BODY_BASE}`}
        >
          <Loader2
            size={13}
            strokeWidth={2}
            className="shrink-0 animate-spin"
          />
          {loadingBody}
        </div>
      </div>
    </ChatBubbleLayout>
  );
};

UnloadedTurnBubble.displayName = "UnloadedTurnBubble";

export default UnloadedTurnBubble;
