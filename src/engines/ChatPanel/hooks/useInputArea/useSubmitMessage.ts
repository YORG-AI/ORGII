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

import { rejectQuestion, respondQuestion } from "@src/api/tauri/agent";
import Message from "@src/components/Message";
import { extractQuestionBatch } from "@src/engines/ChatPanel/InputArea/AskQuestionCard/extractQuestionBatch";
import { chatEventsAtom } from "@src/engines/SessionCore";
import { createLogger } from "@src/hooks/logger";
import { sessionByIdAtom } from "@src/store/session";
import type { ChatImageAttachment } from "@src/store/ui/chatImageAtom";
import { wpReadOnlyAtom } from "@src/store/ui/chatPanelAtom";

import { clearImageDraft } from "../../InputArea/utils/imageDraftCache";
import { resolveMcpSlashCommand } from "./mcpSlashCommand";
import type {
  CiteCodeSnapshot,
  InputAreaRefs,
  SubmitMessageOptions,
  SubmitOverrideInput,
} from "./types";

const log = createLogger("useSubmitMessage");

/**
 * Strip the `::<base64>` payload from serialized context pills
 * (`[paste:path::encoded]` → `[paste:path]`).
 *
 * `serializePillNode` embeds the pill's stored text as a base64 blob so the
 * composer can round-trip it back into an editable pill (drafts / edit mode).
 * That blob is editor-internal — the LLM must never see it. The submit flow
 * already re-attaches each context pill's *plaintext* as a fenced ```block```
 * (see `contextBlocks` below), so leaving the base64 in the agent content both
 * duplicates the payload AND feeds the model a multi-KB opaque token soup —
 * which has triggered Anthropic `stop_reason=refusal` (empty response, turn
 * ends with no output). We keep the lightweight `[paste:path]` reference so the
 * fenced block still has an anchor, but drop the blob.
 */
const CONTEXT_PILL_TYPE_ALTERNATION =
  "paste|terminal|browser|workitem|dom-element|dom-component|pr|issue";
const CONTEXT_PILL_BASE64_REGEX = new RegExp(
  `\\[(${CONTEXT_PILL_TYPE_ALTERNATION}):([^\\]]+?)::[A-Za-z0-9+/=]+\\]`,
  "g"
);
export function stripContextPillBase64(text: string): string {
  return text.replace(CONTEXT_PILL_BASE64_REGEX, "[$1:$2]");
}

// ============================================================================
// Types
// ============================================================================

export interface UseSubmitMessageOptions {
  refs: InputAreaRefs;
  draftSessionId: string;
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
  replyTargetEventId,
  flushDraft,
  clearReplyTarget,
  imageAttachment,
  citeCode,
  handleSessChatSubmit,
  onSubmitOverride,
  submitDisabled = false,
}: UseSubmitMessageOptions): (options?: SubmitMessageOptions) => Promise<void> {
  const { t } = useTranslation("sessions");
  const store = useStore();
  const wpReadOnly = useAtomValue(wpReadOnlyAtom);
  const submitInFlightKeyRef = useRef<string | null>(null);

  return useCallback(
    async (options: SubmitMessageOptions = {}) => {
      if (submitDisabled) return;

      if (wpReadOnly) {
        Message.warning(t("chat.noActiveSession"));
        return;
      }

      if (!refs.composerInputRef.current) return;

      const liveDisplayText = refs.composerInputRef.current.getTextWithPills();
      let displayText =
        liveDisplayText.trim().length > 0
          ? liveDisplayText
          : (options.capturedText ?? "");
      const hasText = displayText.trim().length > 0;
      const hasAttachedImages = imageAttachment.hasImages;

      if (!hasText && !hasAttachedImages) return;

      // ── Question intercept ────────────────────────────────────────────────
      // When the agent asked a question and the user typed a reply in the main
      // input, forward the typed text as the question answer before dispatching.
      if (hasText && draftSessionId) {
        const events = store.get(chatEventsAtom);
        for (const event of events) {
          if (event.sessionId && event.sessionId !== draftSessionId) continue;
          const batch = extractQuestionBatch(event);
          if (!batch) continue;
          const isFreeText = batch.questions.every(
            (question) => question.options.length === 0
          );
          if (isFreeText) {
            void respondQuestion(batch.sessionId, batch.questionId, [
              [displayText.trim()],
            ]).catch((err: unknown) => {
              log.warn("[useSubmitMessage] respondQuestion failed:", err);
              Message.warning(t("chat.questionExpired"));
            });
          } else {
            void rejectQuestion(batch.sessionId, batch.questionId).catch(
              (err: unknown) => {
                log.warn("[useSubmitMessage] rejectQuestion failed:", err);
                Message.warning(t("chat.questionExpired"));
              }
            );
          }
        }
      }

      // ── MCP slash-command resolution ─────────────────────────────────────
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

      // ── Skill pill expansion ──────────────────────────────────────────────
      // displayText keeps `name [skill:/<name>]` for rendering pills in
      // history. The Rust backend expects `/<name>` to expand skill content,
      // so we extract the path token (already starts with "/") directly.
      const skillExpanded = displayText.replace(
        /([^[]+?)\s*\[skill:([^\]]+)\]/g,
        (_match, _displayName, skillPath: string) => skillPath
      );
      const hasSkillPills = skillExpanded !== displayText;

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
      let agentContent: string | undefined;
      // The text the LLM sees must not carry the editor-internal `::base64`
      // pill payload. `displayText` keeps the full serialized form for history
      // rendering / re-editing; `base` is the agent-facing copy.
      const base = stripContextPillBase64(
        hasSkillPills ? skillExpanded : displayText
      );
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

      if (contextBlocks.length > 0) {
        agentContent = base + "\n\n" + contextBlocks.join("\n\n");
      } else if (hasSkillPills || base !== displayText) {
        // `base !== displayText` means base64 pill payload was stripped — send
        // the cleaned copy so the LLM never receives the raw blob even if no
        // context/skill block was produced.
        agentContent = base;
      }

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
    ]
  );
}
