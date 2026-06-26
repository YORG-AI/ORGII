/**
 * useInputArea Hook
 *
 * Description: Handles all business logic for the ChatPanel InputArea
 *
 * Features:
 * - Message state management (text, expanded state)
 * - @ Mention system (dropdown, file/folder/git mentions)
 * - Context management (add/remove context items)
 * - File attachments (drag-drop and file picker)
 * - Cite code integration (code snippets from editor)
 * - Language detection (auto-detect Chinese/English)
 * - Message submission (format and send messages)
 * - Keyboard shortcuts (Enter, Shift+Enter, Escape)
 *
 * @example
 * const {
 *   composerInputRef, handleDivSubmit, clearCiteCode,
 *   handleUploadClick, handleAtMention, ...
 * } = useInputArea();
 */
import { useAtomValue } from "jotai";
import { useCallback, useEffect, useId, useMemo, useRef } from "react";

import { useChatContext } from "@src/contexts/workspace/ChatContext";
import { useDataContext } from "@src/contexts/workspace/DataContext";
import useWorkspaceChat from "@src/engines/ChatPanel/hooks/useWorkspaceChat";
import { useRepositoryInfo } from "@src/engines/SessionCore";
import { sortedEventsAtom } from "@src/engines/SessionCore/core/atoms/events";
import { sessionHasComposerStopBlockingWork } from "@src/engines/SessionCore/core/runningEventGate";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { isPlanDisplayEvent } from "@src/engines/SessionCore/derived/planDisplayEvents";
import { useSessionId } from "@src/engines/SessionCore/hooks/session";
import { createLogger } from "@src/hooks/logger";
import {
  useSessionDraftField,
  useSessionReplyField,
} from "@src/hooks/session/useSessionPatch";
import { getPlanDocViewModel } from "@src/modules/WorkStation/Chat/Communication/MessageViewer/planDocViewModel";
import {
  isPendingCancelAtom,
  isSessionActiveAtom,
  sessionRuntimeStatusAtom,
} from "@src/store/session/cliSessionStatusAtom";
import { pendingPlanApprovalsAtom } from "@src/store/session/planApprovalAtom";
import { sessionByIdAtom } from "@src/store/session/sessionAtom/atoms";
import { wpReadOnlyAtom } from "@src/store/ui/chatPanelAtom";
import { workspaceFoldersAtom } from "@src/store/ui/workspaceFoldersAtom";
import { activeWorkspaceRootPathAtom } from "@src/store/workspace";
import { getCompactPathLabel } from "@src/util/file/pathUtils";
import { formatRepoPathForDisplay } from "@src/util/file/repoPathDisplay";
import { useCurrentTheme } from "@src/util/ui/theme/themeUtils";

import {
  buildCompactFilesReloadKey,
  countChatRounds,
} from "../../InputArea/components/compactFileChangesHelpers";
import { useCompactFileData } from "../../InputArea/components/useCompactFileData";
import {
  readImageDraft,
  writeImageDraft,
} from "../../InputArea/utils/imageDraftCache";
import { applyParsedContent } from "../../InputArea/utils/pillContentParser";
import { resolveDraftRestoreAction } from "./draftRestore";
import type {
  CustomMentionOption,
  UseInputAreaOptions,
  UseInputAreaReturn,
} from "./types";
import { useAtMention } from "./useAtMention";
import { useCiteCode } from "./useCiteCode";
import { useDragDrop } from "./useDragDrop";
import { useFileSelection } from "./useFileSelection";
import { useImageAttachment } from "./useImageAttachment";
import { useInputAreaEffects } from "./useInputAreaEffects";
import { useInputAreaRefs } from "./useInputAreaRefs";
import { useInputAreaState } from "./useInputAreaState";
import { useSlashCommand } from "./useSlashCommand";
import { useSubmitMessage } from "./useSubmitMessage";
import { useUploadContext } from "./useUploadContext";

// Re-export types
export type { UseInputAreaOptions, UseInputAreaReturn } from "./types";

const logger = createLogger("useInputArea");
const MAX_DRAFT_RESTORE_CHARS = 20_000;
const MAX_DRAFT_RESTORE_LINES = 500;
const MAX_DRAFT_RESTORE_BRACKETS = 500;

function getDraftRestoreSkipReason(draftText: string): string | null {
  if (draftText.length > MAX_DRAFT_RESTORE_CHARS) return "too_large";

  let lineCount = 1;
  let bracketCount = 0;
  for (const char of draftText) {
    if (char === "\n") {
      lineCount += 1;
      if (lineCount > MAX_DRAFT_RESTORE_LINES) return "too_many_lines";
    }
    if (char === "[") {
      bracketCount += 1;
      if (bracketCount > MAX_DRAFT_RESTORE_BRACKETS) {
        return "too_many_pill_candidates";
      }
    }
  }

  return null;
}

function getPlanMentionPath(event: SessionEvent): string | null {
  const planPath = getPlanDocViewModel(event).planPath;
  return planPath && planPath.trim() ? planPath : null;
}

function buildPlanMentionOptions(
  events: ReadonlyArray<SessionEvent>,
  pendingPlan: { planPath: string; planTitle: string } | null | undefined
): CustomMentionOption[] {
  const options: CustomMentionOption[] = [];
  const seenPaths = new Set<string>();

  if (pendingPlan?.planPath) {
    seenPaths.add(pendingPlan.planPath);
    options.push({
      id: `plan-file:${pendingPlan.planPath}`,
      label: pendingPlan.planTitle || getCompactPathLabel(pendingPlan.planPath),
      description: pendingPlan.planPath,
      groupLabel: "Plan",
      selectType: "files",
      selectValue: pendingPlan.planPath,
      selectDisplayName: getCompactPathLabel(pendingPlan.planPath),
    });
  }

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!isPlanDisplayEvent(event)) continue;
    const planPath = getPlanMentionPath(event);
    if (!planPath || seenPaths.has(planPath)) continue;

    seenPaths.add(planPath);
    const title = getPlanDocViewModel(event).title;
    options.push({
      id: `plan-file:${planPath}`,
      label: title || getCompactPathLabel(planPath),
      description: planPath,
      groupLabel: "Plan",
      selectType: "files",
      selectValue: planPath,
      selectDisplayName: getCompactPathLabel(planPath),
    });

    if (options.length >= 4) break;
  }

  return options;
}

export function useInputArea(
  options: UseInputAreaOptions = {}
): UseInputAreaReturn {
  const {
    customMentionOptions,
    onSubmitOverride,
    sessionId: propSessionId,
    sessionScope = "active",
    submitDisabled = false,
  } = options;

  // ============================================
  // Context Integration
  // ============================================

  const { feedBackInfo: feedBack, setFeedBackInfo: setFeedBack } =
    useChatContext();

  const { localContextList } = useDataContext();

  // Toolbar (workspace) repo — used as the fallback when no session is active
  // (creator mode) or the active session row predates the per-session
  // `repo_path` column.
  const { repoPath: workspaceRepoPath } = useRepositoryInfo();

  // ============================================
  // Workspace Chat
  // ============================================

  const {
    handleSessInputChange,
    handleSessChatSubmit,
    stopSession,
    resumeSession,
    isHosted,
    canStopAgent,
    canResume,
  } = useWorkspaceChat({ sessionId: propSessionId, sessionScope });

  // ============================================
  // Atoms (Global State)
  // ============================================

  const wpReadOnly = useAtomValue(wpReadOnlyAtom);
  const rawIsSessionActive = useAtomValue(isSessionActiveAtom);
  const rawIsPendingCancel = useAtomValue(isPendingCancelAtom);
  const runtimeStatus = useAtomValue(sessionRuntimeStatusAtom);
  const pendingPlanApprovals = useAtomValue(pendingPlanApprovalsAtom);
  const isSessionless = sessionScope === "none";
  const isSessionActive = isSessionless ? false : rawIsSessionActive;
  const isPendingCancel = isSessionless ? false : rawIsPendingCancel;

  const sessionEvents = useAtomValue(sortedEventsAtom);
  // Retry is only meaningful for `failed` runs. A user-initiated cancel should
  // never surface the orange retry button — the user stopped on purpose.
  const isSessionTerminal = !isSessionless && runtimeStatus === "failed";

  // ============================================
  // Sub-hooks
  // ============================================

  const refs = useInputAreaRefs();
  const reactDropTargetId = useId();
  const dropTargetId = `chat-drop-${reactDropTargetId.replace(/:/g, "")}`;
  const state = useInputAreaState();
  const { isDark } = useCurrentTheme();
  const citeCode = useCiteCode();

  // Mirror the current slash/@ menu open state into a ref so the draft-restore
  // effect can avoid clobbering live input WITHOUT re-running whenever a menu
  // toggles. When a menu is open the user is actively typing into a mounted
  // editor, so a late restore must not clear/re-seed it (see draftRestore.ts).
  const mentionMenuOpenRef = useRef(false);
  mentionMenuOpenRef.current = state.showSlashMenu || state.showContextMenu;

  // ============================================
  // Per-session Draft Persistence (P3)
  // ============================================
  //
  // The chat composer's text is mirrored onto `sessions.draft_text` so it
  // survives navigation, app restarts, and background row refreshes.
  // Three things to coordinate:
  //   1. On session switch, restore the persisted draft into ComposerInput.
  //   2. While typing, debounce-write the latest text via `setDraft`.
  //   3. On send, immediately clear the draft (`flushDraft("")`) so the
  //      next session activation doesn't see a stale value.
  //
  // We deliberately use the `useSessionId` "active" form so the composer
  // tracks whichever session the user is currently viewing in chat —
  // matches the read path used by the pills.
  const { sessionId: resolvedActiveSessionId } = useSessionId({
    propSessionId,
  });
  const activeSessionId =
    sessionScope === "none"
      ? undefined
      : (propSessionId ?? resolvedActiveSessionId);
  const draftSessionId = activeSessionId ?? "";
  const hasComposerStopBlockingWork = activeSessionId
    ? sessionHasComposerStopBlockingWork(
        sessionEvents,
        activeSessionId,
        runtimeStatus
      )
    : false;

  // Visual "agent is working" flag — drives the Stop vs. Send icon.
  // This uses the composer-specific gate: foreground tools remain stoppable,
  // while background processes and hidden status sentinels stay in footer/replay
  // surfaces without keeping the main button stuck in Stop.
  const isWpGeneWorking =
    (isSessionActive || hasComposerStopBlockingWork) && !isPendingCancel;

  const sessionFileReloadKey = buildCompactFilesReloadKey(
    activeSessionId ?? null,
    countChatRounds(sessionEvents),
    isWpGeneWorking
  );
  const { allFiles: sessionFiles } = useCompactFileData({
    sessionId: activeSessionId ?? null,
    reloadKey: sessionFileReloadKey,
  });

  // Session-scoped repo path. When a session is active prefer its persisted
  // `repo_path` (the value that drove `workspace_root` at session start) over
  // the global repo selection atom. This keeps every input-area consumer —
  // composer bar, ContextInfoButton's `policies_list` lookup, file-prewarm
  // effect — aligned with the *session*'s repo, even when the global selection
  // has since navigated to a different project. Falls back to the global
  // selection value for creator mode and older session rows without repo_path.
  const activeSession = useAtomValue(sessionByIdAtom(activeSessionId ?? ""));
  const activeWorkspaceRootPath = useAtomValue(activeWorkspaceRootPathAtom);
  const workspaceFolders = useAtomValue(workspaceFoldersAtom);
  const currentRepoPath = activeSessionId
    ? (activeSession?.repoPath ?? workspaceRepoPath)
    : workspaceRepoPath;
  const pendingPlan = activeSessionId
    ? pendingPlanApprovals.get(activeSessionId)?.current
    : null;
  const sessionFileMentionOptions = useMemo<ReadonlyArray<CustomMentionOption>>(
    () =>
      sessionFiles.slice(0, 12).map((file) => {
        const displayPath = formatRepoPathForDisplay({
          path: file.path,
          repoPath: currentRepoPath,
        }).displayPath;
        const label = getCompactPathLabel(displayPath || file.path);
        return {
          id: `session-file:${file.path}`,
          label,
          description: `${file.status === "D" ? "Deleted" : "Modified"} · ${displayPath || file.path}`,
          groupLabel: "Diff",
          selectType: "files",
          selectValue: file.path,
          selectDisplayName: file.fileName,
        };
      }),
    [currentRepoPath, sessionFiles]
  );
  const planMentionOptions = useMemo<ReadonlyArray<CustomMentionOption>>(
    () => buildPlanMentionOptions(sessionEvents, pendingPlan),
    [pendingPlan, sessionEvents]
  );
  const mergedCustomMentionOptions = useMemo(
    () => [
      ...sessionFileMentionOptions,
      ...planMentionOptions,
      ...(customMentionOptions ?? []),
    ],
    [customMentionOptions, planMentionOptions, sessionFileMentionOptions]
  );
  const skillWorkspacePaths = useMemo(() => {
    const roots = new Set<string>();
    for (const folder of workspaceFolders) {
      const normalizedPath = folder.path.replace(/\/+$/, "");
      if (normalizedPath) roots.add(normalizedPath);
    }
    for (const path of [currentRepoPath, activeWorkspaceRootPath]) {
      const normalizedPath = path?.replace(/\/+$/, "");
      if (normalizedPath) roots.add(normalizedPath);
    }
    return [...roots];
  }, [activeWorkspaceRootPath, currentRepoPath, workspaceFolders]);
  const {
    draftText: persistedDraft,
    setDraft,
    flushDraft,
  } = useSessionDraftField(draftSessionId);
  // Per-session reply target (P3). The chat-item Reply action writes a
  // chunk id here via `setReplyTarget`; the composer banner reads it to
  // decide whether to render `ReplyInfoDisplay`. Dismissing the banner
  // (or sending the message) calls `clearReplyTarget`.
  const { replyTargetEventId, clearReplyTarget } =
    useSessionReplyField(draftSessionId);
  // Track which session id we last seeded the editor with so a re-render
  // (e.g. a draft persisting back into the session row) doesn't re-seed
  // the editor and clobber what the user is currently typing. Only the
  // session-id transition is allowed to touch the editor content here.
  const seededSessionRef = useRef<string | null>(null);
  const programmaticInputMutationDepthRef = useRef(0);
  const imageDraftSessionRef = useRef<string | null>(null);
  const imageDraftHydratingRef = useRef(false);

  const fileSelection = useFileSelection({
    composerInputRef: refs.composerInputRef,
    hasContentRef: refs.hasContentRef,
  });

  const atMention = useAtMention({
    composerInputRef: refs.composerInputRef,
    hasContentRef: refs.hasContentRef,
    setShowContextMenu: state.setShowContextMenu,
    setAtSearchQuery: state.setAtSearchQuery,
    handleSelectFile: fileSelection.handleSelectFile,
  });

  const slashCommand = useSlashCommand({
    composerInputRef: refs.composerInputRef,
    setShowSlashMenu: state.setShowSlashMenu,
    setSlashQuery: state.setSlashQuery,
    workspacePaths: skillWorkspacePaths,
  });

  const imageAttachment = useImageAttachment(dropTargetId);

  // Pull stable function references out of the imageAttachment object so the
  // effects below only re-run when draftSessionId changes, not on every render
  // (useImageAttachment returns a new object literal each call).
  const { restoreImages, images: attachmentImages } = imageAttachment;

  useEffect(() => {
    if (!draftSessionId) {
      imageDraftSessionRef.current = null;
      imageDraftHydratingRef.current = true;
      restoreImages([]);
      queueMicrotask(() => {
        imageDraftHydratingRef.current = false;
      });
      return;
    }

    if (imageDraftSessionRef.current === draftSessionId) return;
    imageDraftSessionRef.current = draftSessionId;
    imageDraftHydratingRef.current = true;
    restoreImages(readImageDraft(draftSessionId));
    queueMicrotask(() => {
      imageDraftHydratingRef.current = false;
    });
  }, [draftSessionId, restoreImages]);

  useEffect(() => {
    if (!draftSessionId || imageDraftHydratingRef.current) return;
    writeImageDraft(draftSessionId, attachmentImages);
  }, [draftSessionId, attachmentImages]);

  const withProgrammaticInputMutation = useCallback((mutation: () => void) => {
    programmaticInputMutationDepthRef.current += 1;
    try {
      mutation();
    } finally {
      window.setTimeout(() => {
        programmaticInputMutationDepthRef.current = Math.max(
          0,
          programmaticInputMutationDepthRef.current - 1
        );
      }, 0);
    }
  }, []);

  const handleRestoreInputContent = useCallback(
    (text: string) => {
      refs.setHasContent(text.trim().length > 0);
      handleSessInputChange(text);
    },
    [handleSessInputChange, refs]
  );

  const uploadContext = useUploadContext({
    composerInputRef: refs.composerInputRef,
    imageOwnerId: dropTargetId,
  });

  const dragDrop = useDragDrop({
    composerInputRef: refs.composerInputRef,
  });

  // ============================================
  // Effects
  // ============================================

  useInputAreaEffects({
    composerInputRef: refs.composerInputRef,
    containerRef: refs.containerRef,
    dropTargetId,
    hasContentRef: refs.hasContentRef,
    showContextMenu: state.showContextMenu,
    setShowContextMenu: state.setShowContextMenu,
    isCiteCode: citeCode.isCiteCode,
    selectedCiteText: citeCode.selectedCiteText,
    selectedCiteRange: citeCode.selectedCiteRange,
    citeFileName: citeCode.citeFileName,
    currentRepoPath,
    withProgrammaticInputMutation,
    onRestoreInputContent: handleRestoreInputContent,
  });

  // ============================================
  // Event Handlers - Input Management
  // ============================================

  const handleInputBlur = useCallback(() => {
    state.setIsInputFocused(false);
  }, [state]);

  const handleContentChange = useCallback(
    (text: string) => {
      const draftText =
        refs.composerInputRef.current?.getTextWithPills() ?? text;
      const cleanedText = draftText.trim();
      refs.setHasContent(cleanedText.length > 0);

      // Pass to workspace chat handler
      handleSessInputChange(draftText);

      if (programmaticInputMutationDepthRef.current > 0) {
        return;
      }

      // Mirror the latest text onto the session row (debounced). Skip
      // when we don't have an active session id — the composer is only
      // mounted once we've resolved one in practice, but the ref form
      // guards against a flash of "" on first paint clobbering an
      // existing draft.
      if (draftSessionId) {
        setDraft(draftText);
      }
    },
    [draftSessionId, handleSessInputChange, refs, setDraft]
  );

  // Restore the persisted draft into the editor on session switch.
  // We seed exactly once per session id transition: subsequent renders
  // (where `persistedDraft` may be slightly stale relative to the
  // editor — the optimistic upsert in `useSessionPatch` writes back
  // into `sessionByIdAtom`) leave the live editor alone.
  useEffect(() => {
    const editor = refs.composerInputRef.current;
    const skipReason = persistedDraft
      ? getDraftRestoreSkipReason(persistedDraft)
      : null;
    const action = resolveDraftRestoreAction({
      draftSessionId,
      seededSessionId: seededSessionRef.current,
      hasEditor: Boolean(editor),
      mentionMenuOpen: mentionMenuOpenRef.current,
      persistedDraft: persistedDraft ?? null,
      skipReason,
    });

    switch (action) {
      case "reset-seed":
        seededSessionRef.current = null;
        return;
      case "skip":
      case "wait":
        return;
      case "skip-open-menu":
        // User is mid slash/@ interaction — do not clobber live input.
        // Mark seeded so a later render doesn't re-seed and close the menu.
        seededSessionRef.current = draftSessionId;
        return;
      case "clear":
        if (skipReason) {
          logger.warn("skipping persisted draft restore", {
            draftSessionId,
            persistedDraftLength: persistedDraft?.length ?? 0,
            reason: skipReason,
          });
        }
        editor?.clear();
        refs.setHasContent(false);
        seededSessionRef.current = draftSessionId;
        return;
      case "restore":
        if (editor && persistedDraft) {
          applyParsedContent(editor, persistedDraft);
          refs.setHasContent(true);
          seededSessionRef.current = draftSessionId;
        }
        return;
    }
  }, [draftSessionId, persistedDraft, refs]);

  const isInputEmpty = useCallback(() => {
    return refs.composerInputRef.current?.isEmpty() ?? true;
  }, [refs.composerInputRef]);

  // ============================================
  // Event Handlers - Message Submission
  // ============================================

  const handleDivSubmit = useSubmitMessage({
    refs,
    draftSessionId,
    replyTargetEventId,
    flushDraft,
    clearReplyTarget,
    imageAttachment,
    citeCode,
    handleSessChatSubmit,
    onSubmitOverride,
    submitDisabled,
  });

  // ============================================
  // Effective replyInfo (P3)
  // ============================================
  //
  // The persisted `replyTargetEventId` on the session row (read via
  // `useSessionReplyField`) is the *only* source of truth for whether
  // the composer's reply banner is open. The `replyInfo` we expose
  // here is just a derived view-model in the legacy shape the UI
  // components (`InputArea`, `ReplyInfoDisplay`) already consume.
  const effectiveReplyInfo = useMemo<{
    isReply: boolean;
    info?: { type: string; eventId?: string };
  }>(
    () =>
      replyTargetEventId
        ? {
            isReply: true,
            info: { type: "reply", eventId: replyTargetEventId },
          }
        : { isReply: false },
    [replyTargetEventId]
  );

  // The legacy `setReplyInfo` callback signature is preserved so the
  // call sites (`InputArea`'s "× close banner" buttons) don't need to
  // know about the persisted column. We accept the same shape they
  // already pass and translate `isReply: false` into a backend
  // `clearReplyTarget()` call. There is no in-tree caller passing
  // `isReply: true` today — that path would belong to a future
  // chat-item Reply trigger and should call `setReplyTarget(eventId)`
  // directly via `useSessionReplyField`, not through this shim.
  const setReplyInfoBridge = useCallback(
    (next: { isReply: boolean; info?: { type: string; eventId?: string } }) => {
      if (!draftSessionId) return;
      if (!next.isReply && replyTargetEventId) {
        void clearReplyTarget().catch((err: unknown) => {
          logger.warn("clearReplyTarget(bridge) failed", err);
        });
      }
    },
    [clearReplyTarget, draftSessionId, replyTargetEventId]
  );

  // ============================================
  // Return Interface
  // ============================================

  return {
    // Refs
    composerInputRef: refs.composerInputRef,
    containerRef: refs.containerRef,
    contextMenuKeyboardHandlerRef: refs.contextMenuKeyboardHandlerRef,
    slashCommandKeyboardHandlerRef: refs.slashCommandKeyboardHandlerRef,
    plusSlashCommandKeyboardHandlerRef: refs.plusSlashCommandKeyboardHandlerRef,
    hasContentRef: refs.hasContentRef,

    // Input state
    isInputFocused: state.isInputFocused,
    setIsInputFocused: state.setIsInputFocused,
    handleInputBlur,
    handleContentChange,
    handleAtMention: atMention.handleAtMention,
    handleAtMentionClose: atMention.handleAtMentionClose,
    isInputEmpty,

    // @ Mention
    showContextMenu: state.showContextMenu,
    setShowContextMenu: state.setShowContextMenu,
    atSearchQuery: state.atSearchQuery,
    setAtSearchQuery: state.setAtSearchQuery,
    handleAtSelect: atMention.handleAtSelect,
    handleCustomMentionSelect: atMention.handleCustomMentionSelect,
    customMentionOptions: mergedCustomMentionOptions,

    // Slash command
    showSlashMenu: state.showSlashMenu,
    slashQuery: state.slashQuery,
    handleSlashCommand: slashCommand.handleSlashCommand,
    handleSlashCommandClose: slashCommand.handleSlashCommandClose,
    handleSlashSelect: slashCommand.handleSlashSelect,
    handleSlashAppendSelect: slashCommand.handleSlashAppendSelect,
    handleModeSelect: slashCommand.handleModeSelect,
    currentMode: slashCommand.currentMode,
    filteredSlashItems: slashCommand.filteredItems,
    slashLoading: slashCommand.slashLoading,
    prefetchSlashItems: slashCommand.prefetchItems,

    // File selection
    handleSelectFile: fileSelection.handleSelectFile,

    // Context management
    contextItemsAtChat: fileSelection.contextItemsAtChat,
    setContextItemsAtChat: fileSelection.setContextItemsAtChat,
    // Upload
    fileInputRef: uploadContext.fileInputRef,
    handleUploadClick: uploadContext.handleUploadClick,
    handleFileUpload: uploadContext.handleFileUpload,

    // Cite code
    isCiteCode: citeCode.isCiteCode,
    selectedCiteRange: citeCode.selectedCiteRange,
    selectedCiteText: citeCode.selectedCiteText,
    citeFileName: citeCode.citeFileName,
    clearCiteCode: citeCode.clearCiteCode,

    // Message submission
    handleDivSubmit,
    isWpGeneWorking,
    isSessionActive,
    isPendingCancel,
    wpReadOnly,

    // Session control — stopSession triggers interrupt and primes the
    // silent-queue window (isPendingCancelAtom) so subsequent user input
    // is enqueued invisibly until Rust finishes winding the turn down.
    interruptSession: stopSession,
    resumeSession,
    isHosted,
    canStopAgent,
    canResume,
    isSessionTerminal,

    // Drag & drop
    dropTargetId,
    handleDragOver: dragDrop.handleDragOver,
    handleDragLeave: dragDrop.handleDragLeave,
    handleDrop: dragDrop.handleDrop,

    // Styling
    isDark,

    // Context hooks
    feedBack,
    setFeedBack: setFeedBack as (info: unknown) => void,
    replyInfo: effectiveReplyInfo,
    setReplyInfo: setReplyInfoBridge as (info: unknown) => void,
    localContextList,
    currentRepoPath,
    skillWorkspacePaths,

    // Image attachments
    attachedImages: imageAttachment.images,
    handleImagePaste: imageAttachment.handleImagePaste,
    hasImages: imageAttachment.hasImages,
    clearAttachedImages: imageAttachment.clearImages,
  };
}

export default useInputArea;
