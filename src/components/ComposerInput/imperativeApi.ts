/**
 * Imperative-handle factory for ComposerInput.
 *
 * Exposes the shared composer ref surface used across the codebase. The
 * façade returned by `getEditor()` covers the chainable insert-content pattern
 * used by existing composer actions.
 */
import { capPillText, storePillText } from "@src/config/pillTokens";

import {
  type ComposerEditorChain,
  type ComposerEditorFacade,
  type ComposerInputRef,
  type ComposerPillAttrs,
  type ComposerSnapshot,
  type PillIconType,
} from "./types";
import {
  collectContextPillTextsFromDom,
  extractPlainText,
  extractTextWithPills,
  snapshotPillsFromDom,
} from "./utils";

export interface ImperativeApiContext {
  host: () => HTMLDivElement | null;
  insertPill: (attrs: ComposerPillAttrs) => void;
  insertTextAtCaret: (text: string) => void;
  setHostContent: (text: string) => void;
  restoreSnapshot: (snapshot: ComposerSnapshot) => void;
  captureSnapshot: () => ComposerSnapshot;
  markHistoryBoundary: () => void;
  commitHistoryBoundary: () => void;
  clearHost: () => void;
  focusHost: () => void;
  placeCaretAtPoint: (x: number, y: number) => boolean;
  removePillByPath: (filePath: string) => void;
  isHostEmpty: () => boolean;
  isInlineMenuActive: () => boolean;
  triggerAtMention: () => void;
  /** Pulls the currently-active mention state (used by insertFilePill) */
  getAtMentionState: () => { active: boolean; hasAtChar?: boolean };
  /** Pulls the currently-active slash context state (used by insertFilePill) */
  getSlashCommandState: () => { active: boolean; hasTriggerChar?: boolean };
  /** Clears any active mention state (used after inserting via dropdown) */
  closeAtMention: () => void;
  /** Clears any active slash context state (used after inserting via dropdown) */
  closeSlashCommand: () => void;
  /** Delete the trigger character + query that opened the mention popover. */
  consumeMentionQuery: () => void;
  /** Delete the slash trigger character + query that opened the context popover. */
  consumeSlashCommandQuery: () => void;
}

export function buildImperativeApi(
  ctx: ImperativeApiContext
): ComposerInputRef {
  const focusHostAfterRender = () => {
    requestAnimationFrame(() => ctx.focusHost());
  };

  const buildFacade = (): ComposerEditorFacade => {
    const chain = (): ComposerEditorChain => {
      const api: ComposerEditorChain = {
        focus: () => {
          ctx.focusHost();
          return api;
        },
        insertContent: (content: string) => {
          ctx.insertTextAtCaret(content);
          return api;
        },
        run: () => true,
      };
      return api;
    };
    return {
      chain,
      commands: {
        focus: () => {
          ctx.focusHost();
          return true;
        },
      },
    };
  };

  return {
    getText: () => {
      const host = ctx.host();
      return host ? extractPlainText(host) : "";
    },
    getTextWithPills: () => {
      const host = ctx.host();
      return host ? extractTextWithPills(host) : "";
    },
    getTerminalPillTexts: () => {
      const host = ctx.host();
      return host ? collectContextPillTextsFromDom(host) : {};
    },
    getHTML: () => {
      const host = ctx.host();
      return host ? extractPlainText(host) : "";
    },
    getSnapshot: () => ctx.captureSnapshot(),
    setContent: (content) => {
      if (typeof content === "string") {
        ctx.setHostContent(content);
      } else {
        ctx.restoreSnapshot(content);
      }
    },
    clear: () => {
      ctx.clearHost();
    },
    focus: () => {
      ctx.focusHost();
    },
    placeCaretAtPoint: (x, y) => ctx.placeCaretAtPoint(x, y),
    isEmpty: () => ctx.isHostEmpty(),
    isInlineMenuActive: () => ctx.isInlineMenuActive(),
    insertMentionText: (text: string) => {
      const mention = ctx.getAtMentionState();
      ctx.markHistoryBoundary();
      if (mention.active) {
        ctx.consumeMentionQuery();
      }
      ctx.insertTextAtCaret(text);
      ctx.commitHistoryBoundary();
      if (mention.active) {
        ctx.closeAtMention();
      }
    },
    insertFilePill: (
      filePath: string,
      isFolder = false,
      iconType?: PillIconType,
      displayName?: string
    ) => {
      const fileName = displayName || filePath.split("/").pop() || filePath;
      const mention = ctx.getAtMentionState();
      const slashCommand = ctx.getSlashCommandState();
      ctx.markHistoryBoundary();
      if (mention.active) {
        ctx.consumeMentionQuery();
      } else if (slashCommand.active) {
        ctx.consumeSlashCommandQuery();
      }
      ctx.insertPill({
        filePath,
        fileName,
        isFolder,
        iconType: (iconType ?? null) as PillIconType | null,
        lineStart: null,
        lineEnd: null,
      });
      // Trailing space so the next typed character lands after the pill
      // without nudging the caret back into it.
      ctx.insertTextAtCaret(" ");
      ctx.commitHistoryBoundary();
      if (mention.active) {
        ctx.closeAtMention();
      } else if (slashCommand.active) {
        ctx.closeSlashCommand();
      }
    },
    prependFilePill: (
      filePath: string,
      isFolder = false,
      iconType?: PillIconType,
      displayName?: string
    ) => {
      const fileName = displayName || filePath.split("/").pop() || filePath;
      const pillAttrs: ComposerPillAttrs = {
        filePath,
        fileName,
        isFolder,
        iconType: (iconType ?? null) as PillIconType | null,
        lineStart: null,
        lineEnd: null,
      };
      // Capture the existing content, rebuild the doc with the new pill
      // at the front followed by a space separator, then re-append the
      // original parts so the user's prior text is preserved.
      const existing = ctx.captureSnapshot();
      ctx.markHistoryBoundary();
      ctx.restoreSnapshot({
        parts: [
          { kind: "pill", attrs: pillAttrs },
          { kind: "text", text: " " },
          ...existing.parts,
        ],
      });
      ctx.commitHistoryBoundary();
    },
    appendFilePill: (
      filePath: string,
      isFolder = false,
      iconType?: PillIconType,
      displayName?: string
    ) => {
      const fileName = displayName || filePath.split("/").pop() || filePath;
      const pillAttrs: ComposerPillAttrs = {
        filePath,
        fileName,
        isFolder,
        iconType: (iconType ?? null) as PillIconType | null,
        lineStart: null,
        lineEnd: null,
      };
      // Capture the existing content, then rebuild with the new pill
      // at the end. When there is existing content a space separator is
      // inserted before the pill so it reads as a distinct token.
      const existing = ctx.captureSnapshot();
      const hasContent = existing.parts.length > 0;
      ctx.markHistoryBoundary();
      ctx.restoreSnapshot({
        parts: [
          ...existing.parts,
          ...(hasContent ? [{ kind: "text" as const, text: " " }] : []),
          { kind: "pill", attrs: pillAttrs },
          { kind: "text", text: " " },
        ],
      });
      ctx.commitHistoryBoundary();
      focusHostAfterRender();
    },
    insertFileReference: (options) => {
      const fileName =
        options.fileName ||
        options.filePath.split("/").pop() ||
        options.filePath;
      const mention = ctx.getAtMentionState();
      const slashCommand = ctx.getSlashCommandState();
      ctx.markHistoryBoundary();
      if (mention.active) {
        ctx.consumeMentionQuery();
      } else if (slashCommand.active) {
        ctx.consumeSlashCommandQuery();
      }
      ctx.insertPill({
        filePath: options.filePath,
        fileName,
        isFolder: false,
        iconType: "file",
        lineStart: options.lineStart,
        lineEnd: options.lineEnd,
      });
      ctx.insertTextAtCaret(" ");
      ctx.commitHistoryBoundary();
      if (mention.active) {
        ctx.closeAtMention();
      } else if (slashCommand.active) {
        ctx.closeSlashCommand();
      }
    },
    removeFilePill: (filePath: string) => {
      ctx.removePillByPath(filePath);
    },
    getFilePills: () => {
      const host = ctx.host();
      return host ? snapshotPillsFromDom(host) : [];
    },
    insertPrPill: (prData) => {
      const pillPath = `pr://${prData.prNumber}`;
      const displayName = `#${prData.prNumber} ${prData.prTitle}`;
      storePillText(pillPath, capPillText(JSON.stringify(prData)));
      ctx.markHistoryBoundary();
      ctx.insertPill({
        filePath: pillPath,
        fileName: displayName,
        isFolder: false,
        iconType: "pr",
        lineStart: null,
        lineEnd: null,
      });
      ctx.insertTextAtCaret(" ");
      ctx.commitHistoryBoundary();
    },
    getEditor: () => buildFacade(),
    triggerAtMention: () => {
      ctx.triggerAtMention();
    },
    consumeMentionQuery: () => {
      const mention = ctx.getAtMentionState();
      if (!mention.active) return;
      ctx.markHistoryBoundary();
      ctx.consumeMentionQuery();
      ctx.closeAtMention();
      ctx.commitHistoryBoundary();
      focusHostAfterRender();
    },
    consumeSlashQuery: () => {
      const slashCommand = ctx.getSlashCommandState();
      if (slashCommand.active) {
        ctx.consumeSlashCommandQuery();
        ctx.closeSlashCommand();
      }
    },
  };
}
