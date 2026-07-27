/**
 * Native `input` event handling for ComposerInput.
 *
 * Wraps the contenteditable host's `input` event: reconciles the pill
 * registry with the live DOM, commits a history boundary, notifies
 * `onContentChange`, and detects/updates the inline `@` mention and `/`
 * slash-command trigger state as the caret moves through the text.
 *
 * All callbacks/state are accessed via getters (and mutated via setters) at
 * event time so a single handler instance can survive every prop change
 * without re-binding — mirrors the `createKeyDownHandler` pattern in
 * `keyboard.ts`.
 */
import { type MentionState, canStartSlashCommand } from "./keyboard";
import { caretTextOffset, rangeInsideHost } from "./selection";
import { PILL_DATA_ATTR, extractPlainText } from "./utils";

const TRIGGER_CLOSE_GRACE_MS = 120;

function findInlineAtMention(
  text: string,
  caretOffset: number
): { startOffset: number; query: string } | null {
  const beforeCaret = text.slice(0, caretOffset).replace(/\u200B/g, "");
  const atIndex = beforeCaret.lastIndexOf("@");
  if (atIndex < 0) return null;
  const previousChar = atIndex > 0 ? beforeCaret[atIndex - 1] : "";
  if (previousChar && !/\s/.test(previousChar)) return null;
  const query = beforeCaret.slice(atIndex + 1);
  if (/\s/.test(query)) return null;
  return { startOffset: atIndex + 1, query };
}

function findInlineSlashCommand(
  text: string,
  caretOffset: number
): { startOffset: number; query: string } | null {
  const beforeCaret = text.slice(0, caretOffset).replace(/\u200B/g, "");
  const slashIndex = beforeCaret.lastIndexOf("/");
  if (!canStartSlashCommand(beforeCaret, slashIndex)) return null;
  const query = beforeCaret.slice(slashIndex + 1);
  if (/\s/.test(query)) return null;
  return { startOffset: slashIndex + 1, query };
}

export interface InputHandlerContext {
  host: () => HTMLDivElement | null;
  reconcilePillsFromDom: () => void;
  commitHistoryBoundary: () => void;
  clearHost: () => void;
  updateEmptyState: () => void;
  getOnContentChange: () => ((text: string) => void) | undefined;
  getAtMention: () => MentionState;
  setAtMention: (state: MentionState) => void;
  markAtMentionOpened: () => void;
  getAtMentionOpenedAt: () => number;
  getOnAtMention: () =>
    | ((query: string, pos: { x: number; y: number }) => void)
    | undefined;
  getOnAtMentionClose: () => (() => void) | undefined;
  getSlashCommand: () => MentionState;
  setSlashCommand: (state: MentionState) => void;
  markSlashCommandOpened: () => void;
  getSlashCommandOpenedAt: () => number;
  getOnSlashCommand: () => ((query: string) => void) | undefined;
  getOnSlashCommandClose: () => (() => void) | undefined;
}

/**
 * Returns the contenteditable host's native `input` event handler.
 */
export function createInputHandler(ctx: InputHandlerContext) {
  return (nativeEvent?: Event) => {
    const host = ctx.host();
    if (!host) return;
    ctx.reconcilePillsFromDom();
    ctx.commitHistoryBoundary();

    const text = extractPlainText(host);
    const hasPills = host.querySelector(`[${PILL_DATA_ATTR}]`) != null;
    const inputType =
      nativeEvent && "inputType" in nativeEvent
        ? String(nativeEvent.inputType)
        : undefined;
    const isDeletion = inputType?.startsWith("delete") ?? false;

    if (isDeletion && !hasPills && text.trim().length === 0) {
      ctx.clearHost();
      ctx.updateEmptyState();
      ctx.getOnContentChange()?.("");
      ctx.setAtMention({ active: false, startOffset: 0 });
      ctx.setSlashCommand({ active: false, startOffset: 0 });
      ctx.getOnAtMentionClose()?.();
      ctx.getOnSlashCommandClose()?.();
      return;
    }

    ctx.updateEmptyState();
    ctx.getOnContentChange()?.(text);

    {
      const range = rangeInsideHost(host);
      const caretOffset = caretTextOffset(host, range);
      if (!ctx.getAtMention().active) {
        const inlineMention = findInlineAtMention(text, caretOffset);
        if (inlineMention) {
          ctx.setAtMention({
            active: true,
            startOffset: inlineMention.startOffset,
            hasAtChar: true,
          });
          ctx.markAtMentionOpened();
        }
      }
      if (ctx.getAtMention().active) {
        const openedRecently =
          performance.now() - ctx.getAtMentionOpenedAt() <
          TRIGGER_CLOSE_GRACE_MS;
        if (caretOffset < ctx.getAtMention().startOffset) {
          if (!openedRecently) {
            ctx.setAtMention({ active: false, startOffset: 0 });
            ctx.getOnAtMentionClose()?.();
          }
        } else {
          const query = text
            .slice(ctx.getAtMention().startOffset, caretOffset)
            .replace(/\u200B/g, "");
          if (/\s/.test(query)) {
            if (!openedRecently) {
              ctx.setAtMention({ active: false, startOffset: 0 });
              ctx.getOnAtMentionClose()?.();
            }
          } else {
            const rect = range.getBoundingClientRect();
            ctx.getOnAtMention()?.(query, {
              x: rect.left,
              y: rect.bottom,
            });
          }
        }
      }
    }

    {
      const range = rangeInsideHost(host);
      const caretOffset = caretTextOffset(host, range);
      if (!ctx.getSlashCommand().active && !ctx.getAtMention().active) {
        const inlineSlashCommand = findInlineSlashCommand(text, caretOffset);
        if (inlineSlashCommand) {
          ctx.setSlashCommand({
            active: true,
            startOffset: inlineSlashCommand.startOffset,
            hasTriggerChar: true,
          });
          ctx.markSlashCommandOpened();
        }
      }
      if (ctx.getSlashCommand().active) {
        const openedRecently =
          performance.now() - ctx.getSlashCommandOpenedAt() <
          TRIGGER_CLOSE_GRACE_MS;
        if (caretOffset < ctx.getSlashCommand().startOffset) {
          if (!openedRecently) {
            ctx.setSlashCommand({ active: false, startOffset: 0 });
            ctx.getOnSlashCommandClose()?.();
          }
        } else {
          const query = text
            .slice(ctx.getSlashCommand().startOffset, caretOffset)
            .replace(/\u200B/g, "");
          if (/\s/.test(query)) {
            if (!openedRecently) {
              ctx.setSlashCommand({ active: false, startOffset: 0 });
              ctx.getOnSlashCommandClose()?.();
            }
          } else {
            ctx.getOnSlashCommand()?.(query);
          }
        }
      }
    }
  };
}
