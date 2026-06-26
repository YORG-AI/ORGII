/**
 * ComposerInput
 *
 * Drop-in replacement for the legacy ProseMirror input.
 * The editor surface is a single `contenteditable` host; pills
 * are mounted as `contenteditable="false"` spans with React Portals
 * rendering the `ComposerPill` UI inside each span. Selection, IME, and
 * caret behavior are delegated to the browser; the heavy logic lives in
 * `useEditorOperations`, `keyboard.ts`, `pasteHandlers.ts`, and
 * `imperativeApi.ts`.
 *
 * The component exposes the shared `ComposerInputRef` contract, so every
 * existing consumer (`useComposerInput`, `useSlashCommand`, `useDraftManagement`,
 * `inputPreparation`, …) keeps working without any signature changes.
 */
import { useAtomValue } from "jotai";
import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import { createPortal } from "react-dom";

import { hasReferenceDragData } from "@src/shared/dnd/referenceDragData";
import { installedSkillsAtom } from "@src/store/skills/installedSkillsAtom";
import { useCurrentTheme } from "@src/util/ui/theme/themeUtils";

import ComposerPill from "./ComposerPill";
import { createCutHandler } from "./cutHandler";
import { buildImperativeApi } from "./imperativeApi";
import "./index.scss";
import {
  type MentionState,
  canStartSlashCommand,
  createKeyDownHandler,
  removePillForDeleteDirection,
} from "./keyboard";
import { createDropHandler, createPasteHandler } from "./pasteHandlers";
import {
  caretTextOffset,
  placeCaretAfterPill,
  placeCaretAtEnd,
  placeCaretAtPoint,
  placeCaretAtTextOffset,
  rangeInsideHost,
} from "./selection";
import { removeSnapshotTextRange } from "./snapshotRanges";
import type { ComposerInputProps, ComposerInputRef } from "./types";
import { useEditorOperations } from "./useEditorOperations";
import {
  PILL_DATA_ATTR,
  extractPlainText,
  extractSerializedTextFromRange,
  sanitizeText,
} from "./utils";

export type {
  ComposerInputProps,
  ComposerInputRef,
  ComposerSnapshot,
  PillIconType,
} from "./types";

const IME_COMPOSITION_END_ENTER_GRACE_MS = 30;
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

const ComposerInput = forwardRef<ComposerInputRef, ComposerInputProps>(
  function ComposerInput(props, ref) {
    const {
      placeholder = "Type your message...",
      initialContent = "",
      onContentChange,
      onAtMention,
      onAtMentionClose,
      onSubmit,
      requireCmdEnter = true,
      autoFocus = false,
      className = "",
      minHeight = 60,
      maxHeight = 200,
      overflowY,
      editable = true,
      onKeyDownForDropdown,
      onSlashCommand,
      onSlashCommandClose,
      onKeyDownForSlashDropdown,
      onInputMouseDown,
      onImagePaste,
      onBeforeNewline,
      slashTriggerMode = "command",
    } = props;

    const { isDark } = useCurrentTheme();
    const installedSkills = useAtomValue(installedSkillsAtom);
    const skillPathByName = useMemo(() => {
      const map = new Map<string, string>();
      for (const skill of installedSkills) {
        map.set(skill.name, skill.path);
        map.set(`/${skill.name}`, skill.path);
      }
      return map;
    }, [installedSkills]);
    const installedSkillsRef = useRef(installedSkills);
    installedSkillsRef.current = installedSkills;

    const ops = useEditorOperations();
    const { hostRef, pillEntries } = ops;

    // ===== Stale-closure-proof callback refs =====
    const onContentChangeRef = useRef(onContentChange);
    const onAtMentionRef = useRef(onAtMention);
    const onAtMentionCloseRef = useRef(onAtMentionClose);
    const onSubmitRef = useRef(onSubmit);
    const onKeyDownForDropdownRef = useRef(onKeyDownForDropdown);
    const onSlashCommandRef = useRef(onSlashCommand);
    const onSlashCommandCloseRef = useRef(onSlashCommandClose);
    const onKeyDownForSlashDropdownRef = useRef(onKeyDownForSlashDropdown);
    const onInputMouseDownRef = useRef(onInputMouseDown);
    const onImagePasteRef = useRef(onImagePaste);
    const onBeforeNewlineRef = useRef(onBeforeNewline);
    useEffect(() => {
      onContentChangeRef.current = onContentChange;
      onAtMentionRef.current = onAtMention;
      onAtMentionCloseRef.current = onAtMentionClose;
      onSubmitRef.current = onSubmit;
      onKeyDownForDropdownRef.current = onKeyDownForDropdown;
      onSlashCommandRef.current = onSlashCommand;
      onSlashCommandCloseRef.current = onSlashCommandClose;
      onKeyDownForSlashDropdownRef.current = onKeyDownForSlashDropdown;
      onInputMouseDownRef.current = onInputMouseDown;
      onImagePasteRef.current = onImagePaste;
      onBeforeNewlineRef.current = onBeforeNewline;
    });

    // ===== Composition + mention state =====
    const isComposingRef = useRef(false);
    const compositionEndedAtRef = useRef(0);
    const pendingCaretAfterPillRef = useRef(false);
    const atMentionRef = useRef<MentionState>({
      active: false,
      startOffset: 0,
    });
    const slashCommandRef = useRef<MentionState>({
      active: false,
      startOffset: 0,
    });
    const atMentionOpenedAtRef = useRef(0);
    const slashCommandOpenedAtRef = useRef(0);

    // ===== Mention/slash reset helper =====
    const resetMentionState = useCallback(() => {
      atMentionRef.current = { active: false, startOffset: 0 };
      slashCommandRef.current = { active: false, startOffset: 0 };
      onAtMentionCloseRef.current?.();
      onSlashCommandCloseRef.current?.();
    }, []);

    // ===== Text/empty state cache =====
    const isEmptyRef = useRef(true);
    const [hostIsEmpty, setHostIsEmpty] = React.useState(true);

    const updateEmptyState = useCallback(() => {
      const empty = ops.isHostEmpty();
      if (empty !== isEmptyRef.current) {
        isEmptyRef.current = empty;
        setHostIsEmpty(empty);
      }
    }, [ops]);

    // ===== Mention-driven update handler =====
    const updateCoveredPillSelection = useCallback(() => {
      const host = hostRef.current;
      if (!host) return;
      const pills = host.querySelectorAll<HTMLElement>(`[${PILL_DATA_ATTR}]`);
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        pills.forEach((pill) => pill.classList.remove("is-selection-covered"));
        return;
      }
      const range = selection.getRangeAt(0);
      if (!host.contains(range.commonAncestorContainer)) {
        pills.forEach((pill) => pill.classList.remove("is-selection-covered"));
        return;
      }
      pills.forEach((pill) => {
        pill.classList.toggle(
          "is-selection-covered",
          range.intersectsNode(pill)
        );
      });
    }, [hostRef]);

    const handleInput = useCallback(
      (nativeEvent?: Event) => {
        const host = hostRef.current;
        if (!host) return;
        ops.reconcilePillsFromDom();
        ops.commitHistoryBoundary();

        const text = extractPlainText(host);
        const hasPills = host.querySelector(`[${PILL_DATA_ATTR}]`) != null;
        const inputType =
          nativeEvent && "inputType" in nativeEvent
            ? String(nativeEvent.inputType)
            : undefined;
        const isDeletion = inputType?.startsWith("delete") ?? false;

        if (isDeletion && !hasPills && text.trim().length === 0) {
          ops.clearHost();
          updateEmptyState();
          onContentChangeRef.current?.("");
          atMentionRef.current = { active: false, startOffset: 0 };
          slashCommandRef.current = { active: false, startOffset: 0 };
          onAtMentionCloseRef.current?.();
          onSlashCommandCloseRef.current?.();
          return;
        }

        updateEmptyState();
        onContentChangeRef.current?.(text);

        {
          const range = rangeInsideHost(host);
          const caretOffset = caretTextOffset(host, range);
          if (!atMentionRef.current.active) {
            const inlineMention = findInlineAtMention(text, caretOffset);
            if (inlineMention) {
              atMentionRef.current = {
                active: true,
                startOffset: inlineMention.startOffset,
                hasAtChar: true,
              };
              atMentionOpenedAtRef.current = performance.now();
            }
          }
          if (atMentionRef.current.active) {
            const openedRecently =
              performance.now() - atMentionOpenedAtRef.current <
              TRIGGER_CLOSE_GRACE_MS;
            if (caretOffset < atMentionRef.current.startOffset) {
              if (!openedRecently) {
                atMentionRef.current = { active: false, startOffset: 0 };
                onAtMentionCloseRef.current?.();
              }
            } else {
              const query = text
                .slice(atMentionRef.current.startOffset, caretOffset)
                .replace(/\u200B/g, "");
              if (/\s/.test(query)) {
                if (!openedRecently) {
                  atMentionRef.current = { active: false, startOffset: 0 };
                  onAtMentionCloseRef.current?.();
                }
              } else {
                const rect = range.getBoundingClientRect();
                onAtMentionRef.current?.(query, {
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
          if (!slashCommandRef.current.active && !atMentionRef.current.active) {
            const inlineSlashCommand = findInlineSlashCommand(
              text,
              caretOffset
            );
            if (inlineSlashCommand) {
              slashCommandRef.current = {
                active: true,
                startOffset: inlineSlashCommand.startOffset,
                hasTriggerChar: true,
              };
              slashCommandOpenedAtRef.current = performance.now();
            }
          }
          if (slashCommandRef.current.active) {
            const openedRecently =
              performance.now() - slashCommandOpenedAtRef.current <
              TRIGGER_CLOSE_GRACE_MS;
            if (caretOffset < slashCommandRef.current.startOffset) {
              if (!openedRecently) {
                slashCommandRef.current = { active: false, startOffset: 0 };
                onSlashCommandCloseRef.current?.();
              }
            } else {
              const query = text
                .slice(slashCommandRef.current.startOffset, caretOffset)
                .replace(/\u200B/g, "");
              if (/\s/.test(query)) {
                if (!openedRecently) {
                  slashCommandRef.current = { active: false, startOffset: 0 };
                  onSlashCommandCloseRef.current?.();
                }
              } else {
                onSlashCommandRef.current?.(query);
              }
            }
          }
        }
      },
      [hostRef, ops, updateEmptyState]
    );

    // ===== Stable handlers =====
    const handlePaste = useMemo(
      () =>
        createPasteHandler({
          insertPill: (attrs) => {
            pendingCaretAfterPillRef.current = true;
            ops.insertPill(attrs);
          },
          insertTextAtCaret: ops.insertTextAtCaret,
          getOnImagePaste: () => onImagePasteRef.current,
          getInstalledSkills: () => installedSkillsRef.current,
        }),
      [ops]
    );

    const handleDrop = useMemo(
      () =>
        createDropHandler({
          insertPill: (attrs) => {
            pendingCaretAfterPillRef.current = true;
            ops.insertPill(attrs);
            updateEmptyState();
            const host = hostRef.current;
            if (host) onContentChangeRef.current?.(extractPlainText(host));
          },
        }),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [ops]
    );

    const handleCut = useMemo(
      () =>
        createCutHandler({
          reconcilePillsFromDom: ops.reconcilePillsFromDom,
          onAfterCut: handleInput,
        }),
      // handleInput is stable (useCallback with stable deps); ops is stable.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [ops.reconcilePillsFromDom, handleInput]
    );

    // Wrap `insertNewline` so a bare-Enter / Shift+Enter newline still
    // flows through the same notify-host path that native typing does.
    // The op mutates the DOM directly (no `beforeinput`/`input` event),
    // so without this the parent (e.g. `useEditorExpansion`) never sees
    // the new `\n` and the compact pill row would refuse to expand.
    const insertNewlineAndNotify = useCallback(() => {
      ops.insertNewline();
      handleInput();
    }, [ops, handleInput]);

    const undoAndNotify = useCallback(() => {
      const restored = ops.undo();
      if (restored) handleInput();
      return restored;
    }, [ops, handleInput]);

    const redoAndNotify = useCallback(() => {
      const restored = ops.redo();
      if (restored) handleInput();
      return restored;
    }, [ops, handleInput]);

    const handleKeyDown = useMemo(
      () =>
        createKeyDownHandler({
          host: () => hostRef.current,
          isComposing: (event) => {
            if (
              event.isComposing ||
              isComposingRef.current ||
              event.keyCode === 229
            ) {
              return true;
            }
            return (
              event.key === "Enter" &&
              performance.now() - compositionEndedAtRef.current <
                IME_COMPOSITION_END_ENTER_GRACE_MS
            );
          },
          getAtMention: () => atMentionRef.current,
          setAtMention: (state) => {
            atMentionRef.current = state;
            if (state.active) atMentionOpenedAtRef.current = performance.now();
          },
          getSlashCommand: () => slashCommandRef.current,
          setSlashCommand: (state) => {
            slashCommandRef.current = state;
            if (state.active)
              slashCommandOpenedAtRef.current = performance.now();
          },
          getOnKeyDownForDropdown: () => onKeyDownForDropdownRef.current,
          getOnKeyDownForSlashDropdown: () =>
            onKeyDownForSlashDropdownRef.current,
          getOnAtMention: () => onAtMentionRef.current,
          getOnAtMentionClose: () => onAtMentionCloseRef.current,
          getOnSlashCommand: () => onSlashCommandRef.current,
          getOnSlashCommandClose: () => onSlashCommandCloseRef.current,
          getOnSubmit: () => onSubmitRef.current,
          getOnBeforeNewline: () => onBeforeNewlineRef.current,
          getText: () => {
            const host = hostRef.current;
            return host ? extractPlainText(host) : "";
          },
          insertNewline: insertNewlineAndNotify,
          undo: undoAndNotify,
          redo: redoAndNotify,
          requireCmdEnter,
          slashTriggerMode,
        }),
      [
        hostRef,
        insertNewlineAndNotify,
        redoAndNotify,
        requireCmdEnter,
        slashTriggerMode,
        undoAndNotify,
      ]
    );

    // ===== Native event wiring =====
    useEffect(() => {
      const host = hostRef.current;
      if (!host) return;
      const handleCompositionStart = () => {
        isComposingRef.current = true;
      };
      const handleCompositionEnd = () => {
        isComposingRef.current = false;
        compositionEndedAtRef.current = performance.now();
      };
      const handleBeforeInput = (event: InputEvent) => {
        if (isComposingRef.current) return;
        ops.markHistoryBoundary();
        if (event.inputType.startsWith("deleteContent")) {
          const direction = event.inputType.endsWith("Forward")
            ? "forward"
            : "backward";
          if (removePillForDeleteDirection(host, direction, false)) {
            event.preventDefault();
            ops.reconcilePillsFromDom();
            ops.commitHistoryBoundary();
            handleInput();
            return;
          }
        }
        if (event.inputType === "insertText" && event.data) {
          const sanitized = sanitizeText(event.data);
          if (sanitized !== event.data) {
            event.preventDefault();
            if (sanitized) ops.insertTextAtCaret(sanitized);
            ops.commitHistoryBoundary();
            handleInput();
          }
        }
      };
      const handlePasteEvent = (event: ClipboardEvent) => {
        ops.markHistoryBoundary();
        if (handlePaste(event)) {
          ops.commitHistoryBoundary();
          handleInput();
        }
      };
      const handleDropEvent = (event: DragEvent) => {
        ops.markHistoryBoundary();
        if (handleDrop(event)) {
          ops.commitHistoryBoundary();
          handleInput();
        }
      };
      const handleDragOverEvent = (event: DragEvent) => {
        const hasReferenceType = hasReferenceDragData(
          event.dataTransfer ? Array.from(event.dataTransfer.types) : undefined
        );
        if (hasReferenceType) {
          event.preventDefault();
          if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
        }
      };
      const handleCutEvent = (event: ClipboardEvent) => {
        handleCut(event);
      };
      const handleCopyEvent = (event: ClipboardEvent) => {
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) return;
        const range = selection.getRangeAt(0);
        if (!host.contains(range.commonAncestorContainer)) return;
        const text = extractSerializedTextFromRange(range);
        if (!text) return;
        event.preventDefault();
        event.clipboardData?.setData("text/plain", text);
      };
      host.addEventListener("compositionstart", handleCompositionStart);
      host.addEventListener("compositionend", handleCompositionEnd);
      host.addEventListener("beforeinput", handleBeforeInput);
      host.addEventListener("paste", handlePasteEvent);
      host.addEventListener("drop", handleDropEvent);
      host.addEventListener("dragover", handleDragOverEvent);
      host.addEventListener("cut", handleCutEvent);
      host.addEventListener("copy", handleCopyEvent);
      host.addEventListener("keydown", handleKeyDown);
      document.addEventListener("selectionchange", updateCoveredPillSelection);
      return () => {
        host.removeEventListener("compositionstart", handleCompositionStart);
        host.removeEventListener("compositionend", handleCompositionEnd);
        host.removeEventListener("beforeinput", handleBeforeInput);
        host.removeEventListener("paste", handlePasteEvent);
        host.removeEventListener("drop", handleDropEvent);
        host.removeEventListener("dragover", handleDragOverEvent);
        host.removeEventListener("cut", handleCutEvent);
        host.removeEventListener("copy", handleCopyEvent);
        host.removeEventListener("keydown", handleKeyDown);
        document.removeEventListener(
          "selectionchange",
          updateCoveredPillSelection
        );
      };
      // ops is stable (object from useEditorOperations never changes identity).
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
      hostRef,
      ops.insertTextAtCaret,
      handlePaste,
      handleDrop,
      handleCut,
      handleKeyDown,
      handleInput,
      updateCoveredPillSelection,
    ]);

    // ===== Initial content + autoFocus =====
    useEffect(() => {
      if (!initialContent) return;
      ops.setHostContent(initialContent);
      updateEmptyState();
      onContentChangeRef.current?.(initialContent);
      if (autoFocus) {
        const host = hostRef.current;
        if (host) placeCaretAtEnd(host);
      }
      // Only on mount — `setContent` covers later programmatic updates.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
      if (!autoFocus) return;
      const host = hostRef.current;
      if (host) placeCaretAtEnd(host);
      // hostRef is a stable React ref — listing it would cause spurious re-runs.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [autoFocus]);

    // ===== Imperative handle =====
    useImperativeHandle(
      ref,
      () =>
        buildImperativeApi({
          host: () => hostRef.current,
          insertPill: (attrs) => {
            pendingCaretAfterPillRef.current = true;
            ops.insertPill(attrs);
            updateEmptyState();
            const host = hostRef.current;
            if (host) onContentChangeRef.current?.(extractPlainText(host));
          },
          insertTextAtCaret: (text) => {
            ops.insertTextAtCaret(text);
            updateEmptyState();
            const host = hostRef.current;
            if (host) onContentChangeRef.current?.(extractPlainText(host));
          },
          setHostContent: (content) => {
            resetMentionState();
            ops.setHostContent(content);
            updateEmptyState();
            onContentChangeRef.current?.(content);
          },
          restoreSnapshot: (snapshot) => {
            resetMentionState();
            ops.restoreSnapshot(snapshot);
            updateEmptyState();
            const host = hostRef.current;
            if (host) onContentChangeRef.current?.(extractPlainText(host));
          },
          captureSnapshot: () => ops.captureSnapshot(),
          markHistoryBoundary: ops.markHistoryBoundary,
          commitHistoryBoundary: ops.commitHistoryBoundary,
          clearHost: () => {
            resetMentionState();
            ops.clearHost();
            updateEmptyState();
            onContentChangeRef.current?.("");
          },
          focusHost: ops.focusHost,
          placeCaretAtPoint: (x, y) => {
            const host = hostRef.current;
            return host ? placeCaretAtPoint(host, x, y) : false;
          },
          removePillByPath: (filePath) => {
            ops.removePillByPath(filePath);
            updateEmptyState();
            const host = hostRef.current;
            if (host) onContentChangeRef.current?.(extractPlainText(host));
          },
          isHostEmpty: ops.isHostEmpty,
          isInlineMenuActive: () =>
            atMentionRef.current.active || slashCommandRef.current.active,
          triggerAtMention: () => {
            const host = hostRef.current;
            if (!host) return;
            host.focus();
            const range = rangeInsideHost(host);
            const caretOffset = caretTextOffset(host, range);
            atMentionRef.current = {
              active: true,
              startOffset: caretOffset,
              hasAtChar: false,
            };
            atMentionOpenedAtRef.current = performance.now();
            const rect = range.getBoundingClientRect();
            onAtMentionRef.current?.("", {
              x: rect.left,
              y: rect.bottom,
            });
          },
          triggerSlashContext: () => {
            const host = hostRef.current;
            if (!host) return;
            host.focus();
            const range = rangeInsideHost(host);
            const caretOffset = caretTextOffset(host, range);
            slashCommandRef.current = {
              active: true,
              startOffset: caretOffset,
              hasTriggerChar: false,
            };
            slashCommandOpenedAtRef.current = performance.now();
            onSlashCommandRef.current?.("");
          },
          getSlashCommandState: () => ({
            active: slashCommandRef.current.active,
            hasTriggerChar: slashCommandRef.current.hasTriggerChar,
          }),
          closeSlashCommand: () => {
            slashCommandRef.current = { active: false, startOffset: 0 };
            onSlashCommandCloseRef.current?.();
          },
          consumeSlashCommandQuery: () => {
            const host = hostRef.current;
            if (!host) return;
            const slashCommand = slashCommandRef.current;
            if (!slashCommand.active) return;
            const range = rangeInsideHost(host);
            const caretOffset = caretTextOffset(host, range);
            const startOffset = Math.max(
              0,
              slashCommand.startOffset - (slashCommand.hasTriggerChar ? 1 : 0)
            );
            const snapshot = ops.captureSnapshot();
            ops.restoreSnapshot(
              removeSnapshotTextRange(snapshot, startOffset, caretOffset)
            );
            placeCaretAtTextOffset(host, startOffset);
          },
          getAtMentionState: () => ({
            active: atMentionRef.current.active,
            hasAtChar: atMentionRef.current.hasAtChar,
          }),
          closeAtMention: () => {
            atMentionRef.current = { active: false, startOffset: 0 };
            onAtMentionCloseRef.current?.();
          },
          consumeMentionQuery: () => {
            const host = hostRef.current;
            if (!host) return;
            const mention = atMentionRef.current;
            if (!mention.active) return;
            const range = rangeInsideHost(host);
            const caretOffset = caretTextOffset(host, range);
            const startOffset = Math.max(
              0,
              mention.startOffset - (mention.hasAtChar ? 1 : 0)
            );
            const snapshot = ops.captureSnapshot();
            ops.restoreSnapshot(
              removeSnapshotTextRange(snapshot, startOffset, caretOffset)
            );
            placeCaretAtTextOffset(host, startOffset);
          },
        }),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [ops, updateEmptyState]
    );

    // ===== Pill portal targets =====
    const pillPortals = pillEntries.map((entry) => {
      const target = ops.hostRef.current?.querySelector(
        `[data-pill-id="${entry.id}"]`
      ) as HTMLSpanElement | null;
      if (!target) return null;
      ops.registerPillHost(entry.id, target);
      return createPortal(
        <ComposerPill
          attrs={entry.attrs}
          skillPath={
            entry.attrs.iconType === "skill"
              ? (skillPathByName.get(entry.attrs.filePath) ??
                skillPathByName.get(entry.attrs.fileName))
              : undefined
          }
          onDelete={() => {
            ops.markHistoryBoundary();
            const host = ops.hostRef.current;
            const parent = target.parentNode;
            const previousSibling = target.previousSibling;
            parent?.removeChild(target);
            if (host && parent) {
              const range = document.createRange();
              // Walk left past any empty sentinel text nodes to find real content.
              // If nothing is to the left, fall back to end of parent (after the
              // last remaining child) so the caret never snaps to position 0.
              let placed = false;
              let node: ChildNode | null = previousSibling as ChildNode | null;
              while (node) {
                if (
                  node.nodeType === Node.TEXT_NODE &&
                  (node.textContent ?? "").length > 0 &&
                  parent.contains(node)
                ) {
                  range.setStart(node, (node.textContent ?? "").length);
                  placed = true;
                  break;
                }
                node = node.previousSibling;
              }
              if (!placed) {
                range.setStart(parent, parent.childNodes.length);
              }
              range.collapse(true);
              const selection = window.getSelection();
              if (selection) {
                host.focus({ preventScroll: true });
                selection.removeAllRanges();
                selection.addRange(range);
              }
            }
            ops.reconcilePillsFromDom();
            ops.commitHistoryBoundary();
            updateEmptyState();
            if (host) onContentChangeRef.current?.(extractPlainText(host));
          }}
        />,
        target,
        entry.id
      );
    });

    useLayoutEffect(() => {
      if (!pendingCaretAfterPillRef.current) return;

      const frameId = requestAnimationFrame(() => {
        const liveHost = hostRef.current;
        if (!liveHost) return;
        const insertedPill = liveHost.querySelector<HTMLElement>(
          "[data-last-inserted-pill]"
        );
        if (!insertedPill) return;
        placeCaretAfterPill(insertedPill);
        insertedPill.removeAttribute("data-last-inserted-pill");
        pendingCaretAfterPillRef.current = false;
      });

      return () => cancelAnimationFrame(frameId);
    }, [hostRef, pillEntries]);

    return (
      <div
        className={`composer-input ${isDark ? "dark" : "light"} ${className}`}
        style={{
          minHeight,
          maxHeight,
          overflowY: overflowY ?? "auto",
        }}
      >
        <div className="composer-input-wrapper">
          <div
            ref={hostRef}
            className={`composer-input-content ${isDark ? "dark" : "light"} ${
              hostIsEmpty ? "is-empty" : ""
            }`}
            contentEditable={editable}
            suppressContentEditableWarning
            data-placeholder={placeholder}
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            onInput={(event) => handleInput(event.nativeEvent)}
            onMouseDown={() => onInputMouseDownRef.current?.()}
          />
        </div>
        {pillPortals}
      </div>
    );
  }
);

ComposerInput.displayName = "ComposerInput";

export default ComposerInput;
