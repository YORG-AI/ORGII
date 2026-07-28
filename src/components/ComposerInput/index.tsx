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
  useMemo,
  useRef,
} from "react";

import { installedSkillsAtom } from "@src/store/skills/installedSkillsAtom";
import { useCurrentTheme } from "@src/util/ui/theme/themeUtils";

import { createInputHandler } from "./composerInput.inputHandler";
import { useComposerNativeEvents } from "./composerInput.nativeEvents";
import { useComposerPillPortals } from "./composerInput.pillPortals";
import { createCutHandler } from "./cutHandler";
import { buildImperativeApi } from "./imperativeApi";
import "./index.scss";
import { type MentionState, createKeyDownHandler } from "./keyboard";
import { createDropHandler, createPasteHandler } from "./pasteHandlers";
import {
  caretTextOffset,
  placeCaretAtEnd,
  placeCaretAtPoint,
  placeCaretAtTextOffset,
  rangeInsideHost,
} from "./selection";
import { removeSnapshotTextRange } from "./snapshotRanges";
import type { ComposerInputProps, ComposerInputRef } from "./types";
import { useEditorOperations } from "./useEditorOperations";
import { PILL_DATA_ATTR, extractPlainText } from "./utils";

export type {
  ComposerInputProps,
  ComposerInputRef,
  ComposerSnapshot,
  PillIconType,
} from "./types";

const IME_COMPOSITION_END_ENTER_GRACE_MS = 30;

const ComposerInput = forwardRef<ComposerInputRef, ComposerInputProps>(
  function ComposerInput(props, ref) {
    const {
      placeholder = "Type your message...",
      ariaLabel,
      trailingHint = null,
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

    const handleInput = useMemo(
      () =>
        createInputHandler({
          host: () => hostRef.current,
          reconcilePillsFromDom: ops.reconcilePillsFromDom,
          commitHistoryBoundary: ops.commitHistoryBoundary,
          clearHost: ops.clearHost,
          updateEmptyState,
          getOnContentChange: () => onContentChangeRef.current,
          getAtMention: () => atMentionRef.current,
          setAtMention: (state) => {
            atMentionRef.current = state;
          },
          markAtMentionOpened: () => {
            atMentionOpenedAtRef.current = performance.now();
          },
          getAtMentionOpenedAt: () => atMentionOpenedAtRef.current,
          getOnAtMention: () => onAtMentionRef.current,
          getOnAtMentionClose: () => onAtMentionCloseRef.current,
          getSlashCommand: () => slashCommandRef.current,
          setSlashCommand: (state) => {
            slashCommandRef.current = state;
          },
          markSlashCommandOpened: () => {
            slashCommandOpenedAtRef.current = performance.now();
          },
          getSlashCommandOpenedAt: () => slashCommandOpenedAtRef.current,
          getOnSlashCommand: () => onSlashCommandRef.current,
          getOnSlashCommandClose: () => onSlashCommandCloseRef.current,
        }),
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
    useComposerNativeEvents({
      hostRef,
      ops,
      isComposingRef,
      compositionEndedAtRef,
      handlePaste,
      handleDrop,
      handleCut,
      handleKeyDown,
      handleInput,
      undoAndNotify,
      redoAndNotify,
      updateCoveredPillSelection,
    });

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
    const pillPortals = useComposerPillPortals({
      ops,
      pillEntries,
      skillPathByName,
      updateEmptyState,
      onContentChangeRef,
      pendingCaretAfterPillRef,
    });

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
            } ${trailingHint && !hostIsEmpty ? "has-trailing-hint" : ""}`}
            contentEditable={editable}
            aria-label={ariaLabel}
            suppressContentEditableWarning
            data-placeholder={placeholder}
            data-trailing-hint={
              trailingHint && !hostIsEmpty ? trailingHint : undefined
            }
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
