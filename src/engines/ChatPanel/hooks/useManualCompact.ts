/**
 * useManualCompact — shared manual context-compaction flow.
 *
 * Single owner of the "a compaction is in flight" state and the
 * status-to-toast mapping, consumed by both entry points:
 *   - the Compact button in the context-info popover (ContextInfoButton)
 *   - the `/compact [instructions]` slash command (useSubmitMessage)
 *
 * The in-flight session id lives in a global atom so the composer can
 * refuse to dispatch a message into a session whose durable transcript is
 * being rewritten, regardless of which surface started the compaction.
 */
import { atom, useStore } from "jotai";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";

import { manualCompactSession } from "@src/api/tauri/agent/session";
import { Message } from "@src/components/Message";
import { triggerSessionReloadAtom } from "@src/engines/SessionCore";
import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import { compactBoundaryToSessionEvent } from "@src/engines/SessionCore/ingestion/agentMessageAdapters";

import { formatTokenCount } from "../InputArea/components/useContextUsageInfo";

/** Session id with a manual compaction in flight, or `null`. */
export const manualCompactInFlightSessionAtom = atom<string | null>(null);

export interface CompactSlashCommand {
  /** Optional focus text following `/compact`. */
  instructions?: string;
}

/**
 * Parse a `/compact [instructions]` message. Returns `null` when the text
 * is not a compact command, so ordinary messages (including other slash
 * commands) pass through untouched. Mirrors Claude Code's `/compact
 * [instructions for summarization]` shape; the command is case-insensitive
 * and everything after the token becomes the summarization focus.
 */
export function parseCompactSlashCommand(
  text: string
): CompactSlashCommand | null {
  const trimmed = text.trim();

  // Pill form ("compact [skill:/compact]", see serializePillNode) counts
  // anywhere in the draft — the pill only exists because the user picked
  // the command, so surrounding text on either side is the summarization
  // focus. The plain typed form stays start-anchored below (mid-sentence
  // "/compact" is ordinary prose, mirroring Claude Code).
  const pillMatch = /compact\s*\[skill:\/compact\]/i.exec(trimmed);
  if (pillMatch) {
    const instructions = (
      trimmed.slice(0, pillMatch.index) +
      " " +
      trimmed.slice(pillMatch.index + pillMatch[0].length)
    ).trim();
    return instructions ? { instructions } : {};
  }

  const match = /^\/compact(?:\s+([\s\S]+))?$/i.exec(trimmed);
  if (!match) return null;
  const instructions = match[1]?.trim();
  return instructions ? { instructions } : {};
}

export interface UseManualCompactReturn {
  /**
   * Run a manual compaction for `sessionId`. Resolves `true` when the
   * backend actually compacted (callers can clear their inputs), `false`
   * for every informational/failure outcome (a toast has already been
   * shown either way).
   */
  runManualCompact: (
    sessionId: string | null | undefined,
    instructions?: string
  ) => Promise<boolean>;
}

export function useManualCompact(): UseManualCompactReturn {
  const { t } = useTranslation();
  const store = useStore();

  const runManualCompact = useCallback(
    async (
      sessionId: string | null | undefined,
      instructions?: string
    ): Promise<boolean> => {
      if (store.get(manualCompactInFlightSessionAtom) !== null) {
        Message.info(t("contextInfo.manualCompactInProgress"));
        return false;
      }
      if (!sessionId) {
        Message.info(t("contextInfo.manualCompactNoRuntime"));
        return false;
      }

      store.set(manualCompactInFlightSessionAtom, sessionId);
      try {
        const trimmed = instructions?.trim();
        const result = await manualCompactSession(
          sessionId,
          trimmed || undefined
        );

        switch (result.status) {
          case "compacted":
            // Append the boundary marker in place. The load path dedups on
            // the row id, so the next full hydrate won't duplicate it. Only
            // fall back to evict + reload (which flashes the whole history)
            // when the backend didn't return the persisted row.
            if (result.boundary) {
              await eventStoreProxy.append(
                [
                  compactBoundaryToSessionEvent(
                    {
                      id: result.boundary.id,
                      sessionId,
                      role: "system",
                      content: result.boundary.content,
                      toolName: null,
                      toolCallId: null,
                      toolInput: null,
                      toolOutput: null,
                      model: null,
                      sequence: 0,
                      createdAt: result.boundary.createdAt,
                      images: null,
                      compactFromSequence: 0,
                      compactTokensBefore: result.tokensBefore ?? null,
                      compactTokensAfter: result.tokensAfter ?? null,
                    },
                    sessionId
                  ),
                ],
                sessionId
              );
            } else {
              await eventStoreProxy.evictSession(sessionId);
              store.set(triggerSessionReloadAtom, sessionId);
            }
            Message.success(
              t("contextInfo.manualCompactSuccess", {
                messagesBefore: result.messagesBefore ?? 0,
                messagesAfter: result.messagesAfter ?? 0,
                tokensBefore: formatTokenCount(result.tokensBefore ?? 0),
                tokensAfter: formatTokenCount(result.tokensAfter ?? 0),
              }),
              { duration: 2600 }
            );
            return true;
          case "too_short":
            Message.info(t("contextInfo.manualCompactTooShort"));
            return false;
          case "already_compact":
            Message.info(t("contextInfo.manualCompactAlreadyCompact"));
            return false;
          case "busy":
            Message.info(t("contextInfo.manualCompactBusy"));
            return false;
          case "no_runtime":
            Message.info(t("contextInfo.manualCompactNoRuntime"));
            return false;
          case "channel_attached":
            Message.info(t("contextInfo.manualCompactChannelAttached"));
            return false;
          case "failed":
          default:
            Message.error(
              t("contextInfo.manualCompactFailed", {
                message: result.message ?? t("common:errors.unknown"),
              }),
              { duration: 3200 }
            );
            return false;
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error ?? "");
        Message.error(
          t("contextInfo.manualCompactFailed", {
            message: message || t("common:errors.unknown"),
          }),
          { duration: 3200 }
        );
        return false;
      } finally {
        store.set(manualCompactInFlightSessionAtom, null);
      }
    },
    [store, t]
  );

  return { runManualCompact };
}
