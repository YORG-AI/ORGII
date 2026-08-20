/**
 * useSubmitMessage
 *
 * Extracts the message-submission logic from useInputArea so the parent hook
 * stays under the 600-line limit while keeping the full submit flow isolated
 * and independently testable.
 *
 * Responsibilities:
 *   - MCP slash-command resolution before dispatch
 *   - Question auto-respond / reject intercept
 *   - Context pill terminal-text collection
 *   - Optimistic editor clear + atomic snapshot/restore on failure
 *   - Image draft clear/restore
 *   - Draft text flush on success / restore on failure
 *   - Reply-target clear after successful send
 */
import { useAtomValue, useStore } from "jotai";
import React, { useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";

import Message from "@src/components/Message";
import { chatEventsAtom } from "@src/engines/SessionCore";
import { parseAddressCommentsSlashCommand } from "@src/features/Org2Cloud/addressCommentsSlashToken";
import { useAddressCommentsSlashCommand } from "@src/features/Org2Cloud/useAddressCommentsSlashCommand";
import { createLogger } from "@src/hooks/logger";
import { useSecretScanGuard } from "@src/hooks/security/useSecretScanGuard";
import { sessionByIdAtom } from "@src/store/session";
import type { ChatImageAttachment } from "@src/store/ui/chatImageAtom";
import { wpReadOnlyAtom } from "@src/store/ui/chatPanelAtom";
import { isCliSession } from "@src/util/session/sessionDispatch";

import { clearImageDraft } from "../../InputArea/utils/imageDraftCache";
import {
  manualCompactInFlightSessionAtom,
  parseCompactSlashCommand,
  useManualCompact,
} from "../useManualCompact";
import { resolveMcpSlashCommand } from "./mcpSlashCommand";
import { expandSkillPills } from "./outgoingTextTransforms";
import { projectOutgoingUserMessage } from "./projectOutgoingUserMessage";
import { interceptPendingQuestionBatches } from "./questionIntercept";
import type {
  CiteCodeSnapshot,
  InputAreaRefs,
  SubmitMessageOptions,
  SubmitOverrideInput,
} from "./types";

// Re-exported for existing consumers/tests; the implementation moved to the
// shared outgoing-text transform module so every projection entry point uses
// the same copy.
export { stripContextPillBase64 } from "./outgoingTextTransforms";

const log = createLogger("useSubmitMessage");

// ============================================================================
// Types
// ============================================================================

export interface UseSubmitMessageOptions {
  refs: InputAreaRefs;
  draftSessionId: string;
  /** Session whose comment threads Address Comments targets when the
   * composer dispatches elsewhere (external-history fork composer, where
   * `draftSessionId` is empty by design). */
  addressSessionId?: string | null;
  replyTargetEventId: string | undefined;
  flushDraft: (text: string) => Promise<void>;
  clearReplyTarget: () => Promise<void>;
  imageAttachment: {
    hasImages: boolean;
    images: ChatImageAttachment[];
    clearImages: () => void;
    restoreImages: (images: ChatImageAttachment[]) => void;
  };
  citeCode: {
    isCiteCode: boolean;
    clearCiteCode: () => void;
    captureCiteCode: () => CiteCodeSnapshot;
    restoreCiteCode: (snapshot: CiteCodeSnapshot) => void;
  };
  handleSessChatSubmit: (
    event: React.FormEvent | undefined,
    displayText: string,
    agentContent?: string,
    imageDataUrls?: string[]
  ) => Promise<void>;
  onSubmitOverride?: (input: SubmitOverrideInput) => Promise<boolean>;
  submitDisabled?: boolean;
  enableAgentInterceptors?: boolean;
}

// ============================================================================
// Hook
// ============================================================================

function lastSerializedPillLabel(rawLabel: string): string {
  const trimmed = rawLabel.trim();
  const lastSpaceIdx = trimmed.search(/\s[^\s]*$/);
  return lastSpaceIdx >= 0 ? trimmed.slice(lastSpaceIdx + 1).trim() : trimmed;
}

export function useSubmitMessage({
  refs,
  draftSessionId,
  addressSessionId,
  replyTargetEventId,
  flushDraft,
  clearReplyTarget,
  imageAttachment,
  citeCode,
  handleSessChatSubmit,
  onSubmitOverride,
  submitDisabled = false,
  enableAgentInterceptors = true,
}: UseSubmitMessageOptions): (options?: SubmitMessageOptions) => Promise<void> {
  const { t } = useTranslation("sessions");
  const store = useStore();
  const wpReadOnly = useAtomValue(wpReadOnlyAtom);
  const submitInFlightKeyRef = useRef<string | null>(null);
  const { runManualCompact } = useManualCompact();
  const guardAgainstSecrets = useSecretScanGuard();
  const addressComments = useAddressCommentsSlashCommand(
    draftSessionId || addressSessionId || null
  );

  return useCallback(
    async (options: SubmitMessageOptions = {}) => {
      // Imported teammate replays are intentionally read-only in the event
      // store, but their composer owns an onSubmitOverride that performs
      // fork-before-send. Let that coordinator inspect the submission before
      // applying the ordinary read-only guard; otherwise the generic
      // "No active session" toast makes the fork flow unreachable.
      if (wpReadOnly && !onSubmitOverride) {
        Message.warning(t("chat.noActiveSession"));
        return;
      }

      if (!refs.composerInputRef.current) return;

      // ── Compaction gate ──────────────────────────────────────────────────
      // While this session's durable transcript is being rewritten by a
      // manual compaction, hold new messages instead of dispatching them.
      // (The backend scheduler serializes them anyway; this keeps the UX
      // honest — the user sees why nothing is happening.)
      if (
        draftSessionId &&
        store.get(manualCompactInFlightSessionAtom) === draftSessionId
      ) {
        Message.info(t("common:contextInfo.manualCompactInProgress"));
        return;
      }

      const liveDisplayText = refs.composerInputRef.current.getTextWithPills();
      let displayText =
        liveDisplayText.trim().length > 0
          ? liveDisplayText
          : (options.capturedText ?? "");
      const hasText = displayText.trim().length > 0;
      const hasAttachedImages = imageAttachment.hasImages;

      if (!hasText && !hasAttachedImages) return;

      // ── /compact slash command ───────────────────────────────────────────
      // `/compact [instructions]` runs a manual context compaction instead
      // of dispatching a message (Claude Code parity). Only a pure text
      // command qualifies — attached images mean the user is sending real
      // content that happens to start with "/compact".
      if (enableAgentInterceptors && hasText && !hasAttachedImages) {
        const compactCommand = parseCompactSlashCommand(displayText);
        if (compactCommand) {
          refs.composerInputRef.current.clear();
          void flushDraft("").catch((err: unknown) => {
            log.warn("[useSubmitMessage] flushDraft(compact) failed:", err);
          });
          void runManualCompact(
            draftSessionId || null,
            compactCommand.instructions
          );
          return;
        }

        const addressDraft = parseAddressCommentsSlashCommand(displayText);
        if (addressDraft) {
          refs.composerInputRef.current.clear();
          if (draftSessionId) {
            void flushDraft("").catch((err: unknown) => {
              log.warn("[useSubmitMessage] flushDraft(address) failed:", err);
            });
          }
          addressComments.run({
            selectedHeadIds: addressDraft.selectedHeadIds,
            instruction: addressDraft.instruction,
          });
          return;
        }
      }

      // A running session blocks ordinary sends, but not `/compact`: manual
      // compaction is a maintenance job queued behind the active turn by the
      // backend scheduler. Parse the command first so selecting its pill never
      // becomes a silent no-op while the session is working.
      if (submitDisabled) return;

      // ── Secret scan gate ─────────────────────────────────────────────────
      // Warn before a typed API key / token / password enters the transcript
      // and reaches the model. The user can still choose to send anyway.
      if (hasText) {
        const clearedSecretScan = await guardAgainstSecrets(displayText);
        if (!clearedSecretScan) return;
      }

      // ── Question intercept ────────────────────────────────────────────────
      // When the agent asked a question and the user typed a reply in the main
      // input, forward the typed text as the question answer before dispatching.
      // Finalizes locally even when the native commands fail (no CLI bridge) —
      // see questionIntercept.ts.
      if (enableAgentInterceptors && hasText && draftSessionId) {
        interceptPendingQuestionBatches(
          store.get(chatEventsAtom),
          draftSessionId,
          displayText.trim(),
          t("chat.skippedByUser")
        );
      }

      // ── MCP slash-command resolution ─────────────────────────────────────
      if (enableAgentInterceptors) {
        try {
          const rendered = await resolveMcpSlashCommand(displayText.trim());
          if (rendered !== null) {
            displayText = rendered;
          }
        } catch (err) {
          Message.error(
            `MCP prompt failed: ${err instanceof Error ? err.message : String(err)}`
          );
          return;
        }
      }

      // ── Skill pill expansion ──────────────────────────────────────────────
      // displayText keeps `name [skill:/<name>]` for rendering pills in
      // history. The shared transform extracts the `/<name>` path token the
      // Rust backend expects; the result feeds the session-pill scan below
      // (the final agent projection re-runs the same transform internally).
      const { expanded: skillExpanded, hasSkillPills } =
        expandSkillPills(displayText);

      // ── Context pill async loads ──────────────────────────────────────────
      const { waitForPendingPills } =
        await import("@src/util/contextPillContent");
      await waitForPendingPills();

      // ── Session pill ID injection ─────────────────────────────────────────
      // Session pills carry only the session ID (no transcript). Extract them
      // from the serialized display text and append lightweight references.
      const sessionPillPattern = /([^\n[]+?)\s*\[session:([^\]]+)\]/g;
      const sessionRefs: string[] = [];
      let sessionMatch: RegExpExecArray | null;
      while (
        (sessionMatch = sessionPillPattern.exec(
          hasSkillPills ? skillExpanded : displayText
        )) !== null
      ) {
        const referencedSessionId = sessionMatch[2];
        const referencedSession = store.get(
          sessionByIdAtom(referencedSessionId)
        );
        const fallbackLabel = lastSerializedPillLabel(sessionMatch[1]);
        const label = referencedSession?.name?.trim() || fallbackLabel;
        sessionRefs.push(
          `[Session Reference: ${label} (${referencedSessionId})]`
        );
      }

      // ── Terminal/PR pill text collection ─────────────────────────────────
      const terminalTexts =
        refs.composerInputRef.current.getTerminalPillTexts();
      const terminalEntries = Object.entries(terminalTexts);
      const contextBlocks: string[] = [];

      if (terminalEntries.length > 0) {
        for (const [path, text] of terminalEntries) {
          if (path.startsWith("pr://")) {
            try {
              const prData = JSON.parse(text) as Record<string, unknown>;
              const lines: string[] = [
                `[PR Context] #${prData["prNumber"] ?? prData["number"]} ${prData["prTitle"] ?? prData["title"]}`,
                `Status: ${prData["prStatus"] ?? prData["state"]}`,
                ...(prData["sourceBranch"]
                  ? [
                      `Branch: ${prData["sourceBranch"]}${prData["targetBranch"] ? ` → ${prData["targetBranch"]}` : ""}`,
                    ]
                  : []),
                ...(prData["additions"] != null
                  ? [
                      `+${prData["additions"]} -${prData["deletions"] ?? 0} changes`,
                    ]
                  : []),
                `URL: ${prData["prUrl"] ?? prData["url"]}`,
              ];
              contextBlocks.push(lines.join("\n"));
            } catch {
              contextBlocks.push("```\n" + text + "\n```");
            }
          } else if (path.startsWith("issue://")) {
            try {
              const issueData = JSON.parse(text) as Record<string, unknown>;
              const labels = Array.isArray(issueData["labels"])
                ? issueData["labels"].join(", ")
                : "";
              const assignees = Array.isArray(issueData["assignees"])
                ? issueData["assignees"].join(", ")
                : "";
              const lines: string[] = [
                `[Issue Context] #${issueData["issueNumber"] ?? issueData["number"]} ${issueData["issueTitle"] ?? issueData["title"]}`,
                `State: ${issueData["issueState"] ?? issueData["state"]}`,
                ...(labels ? [`Labels: ${labels}`] : []),
                ...(assignees ? [`Assignees: ${assignees}`] : []),
                ...(issueData["comments"] != null
                  ? [`Comments: ${issueData["comments"]}`]
                  : []),
                `URL: ${issueData["issueUrl"] ?? issueData["url"]}`,
              ];
              contextBlocks.push(lines.join("\n"));
            } catch {
              contextBlocks.push("```\n" + text + "\n```");
            }
          } else {
            contextBlocks.push("```\n" + text + "\n```");
          }
        }
      }

      if (sessionRefs.length > 0) {
        contextBlocks.push(...sessionRefs);
      }

      // The shared projection owns the display/agent split: skill expansion,
      // `::base64` strip, and the Canvas contract. Canvas is additionally
      // gated like /compact and Address Comments above — attached images mean
      // the user is sending real content that happens to mention the command
      // — and on session capability: CLI agents have no render_inline_canvas
      // tool, so the message must pass through as ordinary text there.
      const { agentContent } = projectOutgoingUserMessage({
        displayText,
        contextBlocks,
        enableAgentInterceptors,
        allowCanvasInterception:
          !hasAttachedImages && !isCliSession(draftSessionId || null),
      });

      const imageDataUrls = imageAttachment.images.map((img) => img.dataUrl);
      const submitKey = JSON.stringify({
        draftSessionId,
        displayText,
        agentContent,
        imageDataUrls,
      });
      if (submitInFlightKeyRef.current === submitKey) return;
      submitInFlightKeyRef.current = submitKey;

      let submitSucceeded = false;
      try {
        // ── Snapshot before optimistic clear ─────────────────────────────────
        // Lets us restore the full composer state (text + images + cite-code)
        // if the outgoing request fails, preventing silent data loss.
        const editorSnapshot = refs.composerInputRef.current.getSnapshot();
        const imagesSnapshot: ChatImageAttachment[] =
          imageAttachment.images.slice();
        const citeSnapshot: CiteCodeSnapshot | null = citeCode.isCiteCode
          ? citeCode.captureCiteCode()
          : null;

        // ── Optimistic clear ──────────────────────────────────────────────────
        const editorTextBeforeClear =
          refs.composerInputRef.current.getTextWithPills();
        const editorStillContainsSubmittedText =
          editorTextBeforeClear === displayText ||
          editorTextBeforeClear.trim() === displayText.trim();
        if (editorStillContainsSubmittedText) {
          refs.composerInputRef.current.clear();
          refs.setHasContent(false);
          if (citeCode.isCiteCode) {
            citeCode.clearCiteCode();
          }
          imageAttachment.clearImages();
          clearImageDraft(draftSessionId);
        }

        if (draftSessionId && editorStillContainsSubmittedText) {
          void flushDraft("").catch((err: unknown) => {
            log.warn("[useSubmitMessage] flushDraft(clear) failed:", err);
          });
        }

        // ── Dispatch ──────────────────────────────────────────────────────────
        try {
          const dispatchImages =
            imageDataUrls.length > 0 ? imageDataUrls : undefined;
          const overrideHandled = onSubmitOverride
            ? await onSubmitOverride({
                displayText: displayText || "(image)",
                agentContent,
                imageDataUrls: dispatchImages,
              })
            : false;
          if (!overrideHandled) {
            // Queue-vs-direct is decided inside handleSessChatSubmit against
            // the turn-lifecycle FSM — no composer-side heuristics.
            await handleSessChatSubmit(
              undefined,
              displayText || "(image)",
              agentContent,
              dispatchImages
            );
          }
          submitSucceeded = true;
        } catch (err) {
          // ── Restore on failure ────────────────────────────────────────────
          // Each restore branch is independent so one failure doesn't block others.
          try {
            const editor = refs.composerInputRef.current;
            if (editor && editorSnapshot) {
              editor.setContent(editorSnapshot);
              refs.setHasContent(true);
              if (draftSessionId) {
                const restoredText = editor.getTextWithPills();
                void flushDraft(restoredText).catch((err: unknown) => {
                  log.warn(
                    "[useSubmitMessage] flushDraft(restore) failed:",
                    err
                  );
                });
              }
            }
          } catch (restoreErr) {
            log.warn(
              "[useSubmitMessage] failed to restore editor content:",
              restoreErr
            );
          }

          if (imagesSnapshot.length > 0) {
            try {
              imageAttachment.restoreImages(imagesSnapshot);
            } catch (restoreErr) {
              log.warn(
                "[useSubmitMessage] failed to restore image attachments:",
                restoreErr
              );
            }
          }

          if (citeSnapshot) {
            try {
              citeCode.restoreCiteCode(citeSnapshot);
            } catch (restoreErr) {
              log.warn(
                "[useSubmitMessage] failed to restore cite-code state:",
                restoreErr
              );
            }
          }

          const reason = err instanceof Error ? err.message : String(err);
          const baseMsg = t("chat.failedToSendMessage");
          Message.error(reason ? `${baseMsg}: ${reason}` : baseMsg);
        }
      } finally {
        submitInFlightKeyRef.current = null;
      }

      if (!submitSucceeded) return;

      // ── Post-send cleanup ─────────────────────────────────────────────────
      if (draftSessionId && replyTargetEventId) {
        void clearReplyTarget().catch((err: unknown) => {
          log.warn(
            "[useSubmitMessage] clearReplyTarget(post-send) failed:",
            err
          );
        });
      }
    },
    [
      wpReadOnly,
      store,
      guardAgainstSecrets,
      handleSessChatSubmit,
      citeCode,
      refs,
      imageAttachment,
      t,
      draftSessionId,
      flushDraft,
      replyTargetEventId,
      clearReplyTarget,
      onSubmitOverride,
      submitDisabled,
      enableAgentInterceptors,
      runManualCompact,
      addressComments,
    ]
  );
}
