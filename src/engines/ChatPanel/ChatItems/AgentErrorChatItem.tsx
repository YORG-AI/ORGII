/**
 * AgentErrorChatItem — Displays LLM/agent errors inline in the chat panel.
 *
 * Rendered as a single InlineAlert, so the error reads as one bordered card
 * instead of the split header / body / footer layout the previous block-style
 * render produced. InlineAlert has one neutral style for every type.
 *
 * IMPORTANT: This component must NOT subscribe to chatEventsAtom. It is
 * rendered inside the chat list which is itself driven by chatEventsAtom.
 * Subscribing here creates a nested Jotai listener chain that overflows the
 * call stack when the session snapshot changes (e.g. on tab switch).
 */
import { useAtomValue } from "jotai";
import React, { memo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";

import InlineAlert from "@src/components/InlineAlert";
import {
  CODEX_REAUTH_RETURN_TO_STATE_KEY,
  buildCodexReauthPath,
} from "@src/config/mainAppPaths";
import { sessionIdAtom } from "@src/engines/SessionCore/core/atoms";
import { ArrowDown01Icon, ArrowRight01Icon, HugeiconsIcon } from "@src/icons";
import { sessionByIdAtom } from "@src/store/session";

import {
  requiresCodexReauthentication,
  sanitizeAgentErrorMessage,
} from "./sanitizeAgentErrorMessage";

export interface AgentErrorChatItemProps {
  errorMessage: string;
}

const AgentErrorChatItem: React.FC<AgentErrorChatItemProps> = memo(
  ({ errorMessage }) => {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const location = useLocation();
    const sessionId = useAtomValue(sessionIdAtom);
    const session = useAtomValue(sessionByIdAtom(sessionId ?? ""));
    const [detailsExpanded, setDetailsExpanded] = useState(false);

    const cleanMessage = sanitizeAgentErrorMessage(errorMessage);
    const needsCodexReauthentication =
      requiresCodexReauthentication(errorMessage);
    const title = needsCodexReauthentication
      ? t("errors.codexLoginExpired")
      : t("errors.agentRequestFailed");
    const action = needsCodexReauthentication
      ? {
          label: t("errors.reconnectCodex"),
          onClick: () => {
            const returnTo = `${location.pathname}${location.search}${location.hash}`;
            navigate(buildCodexReauthPath(session?.accountId), {
              state: { [CODEX_REAUTH_RETURN_TO_STATE_KEY]: returnTo },
            });
          },
        }
      : undefined;

    return (
      <div className="animate-fade-in">
        <InlineAlert type="danger" title={title} action={action}>
          {needsCodexReauthentication ? (
            <>
              <div>{t("errors.codexLoginExpiredDescription")}</div>
              <button
                type="button"
                onClick={() => setDetailsExpanded((expanded) => !expanded)}
                aria-expanded={detailsExpanded}
                className="mt-2 flex select-none items-center gap-1 text-text-3 transition-colors hover:text-text-1"
              >
                {detailsExpanded ? (
                  <HugeiconsIcon
                    icon={ArrowDown01Icon}
                    data-icon="chevron-down"
                    size={12}
                    className="shrink-0"
                  />
                ) : (
                  <HugeiconsIcon
                    icon={ArrowRight01Icon}
                    data-icon="chevron-right"
                    size={12}
                    className="shrink-0"
                  />
                )}
                <span>{t("errors.technicalDetails")}</span>
              </button>
              {detailsExpanded && (
                <div className="mt-1 whitespace-pre-wrap break-words text-text-2">
                  {cleanMessage}
                </div>
              )}
            </>
          ) : (
            <div className="whitespace-pre-wrap break-words">
              {cleanMessage}
            </div>
          )}
        </InlineAlert>
      </div>
    );
  }
);

AgentErrorChatItem.displayName = "AgentErrorChatItem";

export default AgentErrorChatItem;
