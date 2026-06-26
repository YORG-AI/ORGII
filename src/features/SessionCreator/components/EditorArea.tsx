/**
 * EditorArea Component
 *
 * Main editor area for SessionCreator with file uploads, typing area,
 * context menu, and control buttons.
 *
 * Uses ComposerInput for proper cursor/selection handling around file pills.
 */
import { type MenuItemId } from "@/src/scaffold/ContextMenu/config";
import { useAtomValue } from "jotai";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import ComposerBar from "@src/components/ComposerBar";
import ComposerInput, { ComposerInputRef } from "@src/components/ComposerInput";
import ComposerShell from "@src/components/ComposerShell";
import Message from "@src/components/Message";
import { VoiceInputButton, VoiceRecordingBar } from "@src/components/Voice";
import { capPillText, storePillText } from "@src/config/pillTokens";
import type { AgentExecMode } from "@src/config/sessionCreatorConfig";
import ContextMenuPortal from "@src/engines/ChatPanel/InputArea/components/ContextMenuPortal";
import SlashCommandPortal from "@src/engines/ChatPanel/InputArea/components/SlashCommandPortal";
import { type VoiceInputError, useVoiceInput } from "@src/hooks/voice";
import i18n from "@src/i18n";
import {
  clearReferenceDragData,
  getReferenceDragPillData,
  hasReferenceDragData,
} from "@src/shared/dnd/referenceDragData";
import { chatAppearanceAtom } from "@src/store/config/configAtom";
import { voiceInputEnabledAtom } from "@src/store/platform/voiceInputAtom";
import type { RepoKind } from "@src/store/repo/types";
import type { ChatImageAttachment } from "@src/store/ui/chatImageAtom";
import type { SlashItem } from "@src/types/extensions";

import { SESSION_CONFIG } from "../config";
import { useTabDragDrop } from "../hooks/useTabDragDrop";
import type { AdvancedConfig, UploadedFile } from "../types";
import ControlButtons, { type DropdownDirection } from "./ControlButtons";
import ImageThumbnailRow from "./ImageThumbnailRow";
import LaunchButton from "./LaunchButton";
import SessionInfoLine from "./SessionInfoLine";
import UploadPills from "./UploadPills";

// ============================================
// Type Definitions
// ============================================

/** Variant type for different layouts */
export type EditorAreaVariant = "default" | "chatPanelFullScreen";

export interface EditorAreaProps {
  /** Variant for different layouts (default: "default") */
  variant?: EditorAreaVariant;
  /** Uploaded files */
  uploadedFiles: UploadedFile[];
  /** Remove file handler */
  onRemoveFile: (fileId: string) => void;
  /** Composer input ref */
  composerInputRef: React.MutableRefObject<ComposerInputRef | null>;
  /** Content change handler */
  onContentChange?: (text: string) => void;
  /** @ mention handler */
  onAtMention?: (query: string, position: { x: number; y: number }) => void;
  /** @ mention close handler */
  onAtMentionClose?: () => void;
  /** Submit handler (Cmd+Enter) */
  onSubmit?: (text: string) => void;
  /** Show context menu */
  showContextMenu: boolean;
  /** Set context menu visibility */
  setShowContextMenu: (show: boolean) => void;
  /** @ search query */
  atSearchQuery: string;
  /** Set @ search query */
  setAtSearchQuery: (query: string) => void;
  /** @ select handler */
  onAtSelect: (type: MenuItemId, value?: string, displayName?: string) => void;
  /** Repo path for context menu */
  repoPath?: string;
  /** @ mention click handler */
  onAtMentionClick: () => void;
  /** Upload click handler */
  onUploadClick: () => void;
  /** Is loading state */
  isLoading: boolean;
  /** Launch handler */
  onLaunch: () => void;
  /** Advanced config */
  advancedConfig: AdvancedConfig;
  /** Advanced config change handler */
  onAdvancedConfigChange: (config: AdvancedConfig) => void;
  /** Current repository ID */
  repoId?: string;
  /** Current repository name */
  repoName?: string;
  /**
   * Handler for repo change. Only consumed when `hideInfoLine` is false and
   * the built-in SessionInfoLine is rendered. Optional because current
   * callers (ChatPanel/Launchpad variants) render SessionInfoLine themselves
   * and pass `hideInfoLine={true}`.
   */
  onRepoChange?: (repoId: string, options?: { repoKind?: RepoKind }) => void;
  /** Local source kind (folder = non-git workspace, hides branch) */
  repoKind?: RepoKind;
  /** Current branch name */
  branchName?: string;
  /**
   * Handler for branch change. Same lifecycle as `onRepoChange` — only
   * consumed by the internal SessionInfoLine (hideInfoLine=false path).
   */
  onBranchChange?: (branch: string) => void;
  /** Whether branches are loading */
  branchLoading?: boolean;
  /** Whether to hide the session info line (when rendered externally) */
  hideInfoLine?: boolean;
  /** Callback when images are pasted from clipboard */
  onImagePaste?: (files: File[]) => void;
  /** Currently attached images */
  attachedImages?: ChatImageAttachment[];
  /** Remove an attached image by ID */
  onRemoveImage?: (id: string) => void;
  /** Whether the launch button should be disabled */
  launchDisabled?: boolean;
  /** Optional visible launch button label */
  launchLabel?: string;
  /** Optional extra className for the outer composer shell */
  shellClassName?: string;
  /** Optional minimum height for the ComposerInput editor region. */
  editorMinHeight?: number;
  /** Optional maximum height for the ComposerInput editor region. */
  editorMaxHeight?: number;
  /** When true, auto-opens the model selector (e.g. after an incompatible agent switch) */
  requestModelOpen?: boolean;
  /** Called after the auto-open request has been consumed */
  onModelOpenHandled?: () => void;
  /** When true, hides the Model/Source pill from ComposerBar (rendered externally) */
  hideModelSourcePill?: boolean;
  /** Initial HTML content to pre-fill the editor on mount */
  initialContent?: string;
  /** Whether to focus the editor when it mounts. */
  autoFocus?: boolean;
  /** Optional override for the editor placeholder. */
  editorPlaceholder?: string;
  /** Optional content rendered at the top of the composer shell. */
  headerContent?: React.ReactNode;
  /** When set, controls whether composer dropdowns open above or below the trigger. */
  dropdownDirection?: DropdownDirection;
  /** When true, hides the per-composer launch button. */
  hideLaunchButton?: boolean;

  // Slash command (/ menu)
  showSlashMenu?: boolean;
  slashQuery?: string;
  slashCommandKeyboardHandlerRef?: React.MutableRefObject<
    ((e: KeyboardEvent) => boolean) | null
  >;
  onSlashCommand?: (query: string) => void;
  onSlashCommandClose?: () => void;
  onSlashSelect?: (item: SlashItem) => void;
  onModeSelect?: (mode: AgentExecMode) => void;
  currentMode?: AgentExecMode;
  filteredSlashItems?: SlashItem[];
  slashLoading?: boolean;
  /** Fetch+filter slash items without opening the inline "/" menu. */
  onPrefetchSlashItems?: (query: string) => void;
}

// ============================================
// Component
// ============================================

const EditorArea: React.FC<EditorAreaProps> = ({
  variant = "default",
  uploadedFiles,
  onRemoveFile,
  composerInputRef,
  onContentChange,
  onAtMention,
  onAtMentionClose,
  onSubmit,
  showContextMenu,
  setShowContextMenu,
  atSearchQuery,
  setAtSearchQuery,
  onAtSelect,
  repoPath,
  onAtMentionClick,
  onUploadClick,
  isLoading,
  onLaunch,
  advancedConfig,
  onAdvancedConfigChange,
  repoId,
  repoName,
  onRepoChange,
  repoKind,
  branchName,
  onBranchChange,
  branchLoading,
  hideInfoLine,
  onImagePaste,
  attachedImages,
  onRemoveImage,
  launchDisabled,
  launchLabel,
  shellClassName,
  editorMinHeight,
  editorMaxHeight,
  requestModelOpen,
  onModelOpenHandled,
  hideModelSourcePill,
  initialContent,
  autoFocus = false,
  editorPlaceholder: editorPlaceholderOverride,
  headerContent,
  dropdownDirection,
  hideLaunchButton = false,
  showSlashMenu = false,
  slashQuery = "",
  slashCommandKeyboardHandlerRef: externalSlashKbRef,
  onSlashCommand,
  onSlashCommandClose,
  onSlashSelect,
  onModeSelect,
  currentMode = "build",
  filteredSlashItems = [],
  slashLoading = false,
  onPrefetchSlashItems,
}) => {
  const isChatPanelFullScreen = variant === "chatPanelFullScreen";
  const isCompact = isChatPanelFullScreen;
  const resolvedDropdownDirection =
    dropdownDirection ?? (isChatPanelFullScreen ? "up" : "down");

  // ============================================
  // Hooks
  // ============================================

  const { t: tSessions } = useTranslation("sessions");

  const editorPlaceholder =
    editorPlaceholderOverride ??
    (currentMode === "wingman"
      ? tSessions("creator.wingmanPlaceholder")
      : tSessions("creator.placeholderDefault"));
  // Internal keyboard handler ref for slash menu (used if external not provided)
  const internalSlashKbRef = useRef<((e: KeyboardEvent) => boolean) | null>(
    null
  );
  const slashCommandKeyboardHandlerRef =
    externalSlashKbRef ?? internalSlashKbRef;

  // Plus-button slash menu (header search mode)
  const [showPlusSlashMenu, setShowPlusSlashMenu] = useState(false);
  const [plusSlashQuery, setPlusSlashQuery] = useState("");
  const [contextMenuKeyboardOpened, setContextMenuKeyboardOpened] =
    useState(false);

  const handleOpenSkillsTools = useCallback(() => {
    setPlusSlashQuery("");
    setShowPlusSlashMenu(true);
    onPrefetchSlashItems?.("");
  }, [onPrefetchSlashItems]);

  const handlePlusSlashClose = useCallback(() => {
    setShowPlusSlashMenu(false);
    setPlusSlashQuery("");
  }, []);

  const handleContextMenuClose = useCallback(() => {
    setContextMenuKeyboardOpened(false);
    setShowContextMenu(false);
    setAtSearchQuery("");
  }, [setAtSearchQuery, setShowContextMenu]);

  const handlePlusSlashQueryChange = useCallback(
    (query: string) => {
      setPlusSlashQuery(query);
      onPrefetchSlashItems?.(query);
    },
    [onPrefetchSlashItems]
  );

  const handleManualAtMentionClick = useCallback(() => {
    setContextMenuKeyboardOpened(false);
    onAtMentionClick();
  }, [onAtMentionClick]);

  const editorContainerRef = React.useRef<HTMLDivElement>(null);

  // ============================================
  // Voice input (push-to-talk dictation)
  // ============================================
  //
  // Mirrors the wiring in `src/engines/ChatPanel/InputArea/index.tsx`:
  // transcripts are appended to the editor's current text via `setContent`
  // (with a single separating space when needed), then the editor is
  // refocused and `onContentChange` is re-emitted so launch-button gating
  // updates immediately.

  const voiceFeatureEnabled = useAtomValue(voiceInputEnabledAtom);
  const { sendOnEnter } = useAtomValue(chatAppearanceAtom);

  const isTabDragOver = useTabDragDrop(editorContainerRef, composerInputRef);
  const [isReferenceDragOver, setIsReferenceDragOver] = useState(false);
  const isDragOver = isTabDragOver || isReferenceDragOver;

  const hasReferenceDrag = useCallback(
    (types?: readonly string[]) => hasReferenceDragData(types),
    []
  );

  const handleReferenceDragOver = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      if (!hasReferenceDrag(Array.from(event.dataTransfer.types))) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "copy";
      setIsReferenceDragOver(true);
    },
    [hasReferenceDrag]
  );

  const handleReferenceDragLeave = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      if (!hasReferenceDrag(Array.from(event.dataTransfer.types))) return;
      event.preventDefault();
      event.stopPropagation();
      setIsReferenceDragOver(false);
    },
    [hasReferenceDrag]
  );

  const setComposerInputElement = useCallback(
    (node: ComposerInputRef | null) => {
      composerInputRef.current = node;
    },
    [composerInputRef]
  );

  const handleReferenceDrop = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      const reference = getReferenceDragPillData(event.dataTransfer);
      if (!reference) return;

      event.preventDefault();
      event.stopPropagation();
      setIsReferenceDragOver(false);

      try {
        storePillText(
          reference.pillPath,
          capPillText(JSON.stringify(reference.payload))
        );
        composerInputRef.current?.insertFilePill(
          reference.pillPath,
          false,
          reference.iconType,
          reference.displayName
        );
        Message.success(
          i18n.t("toasts.addedAsContext", { name: reference.displayName })
        );
      } finally {
        clearReferenceDragData(reference.type);
      }
    },
    [composerInputRef]
  );

  const handleVoiceCommit = useCallback(
    (transcript: string) => {
      const trimmed = transcript.trim();
      if (!trimmed) return;
      const editor = composerInputRef.current;
      if (!editor) return;
      const existing = editor.getText();
      const separator =
        existing.length === 0 || /\s$/.test(existing) ? "" : " ";
      const next = `${existing}${separator}${trimmed}`;
      editor.setContent(next);
      editor.focus();
      onContentChange?.(next);
    },
    [onContentChange, composerInputRef]
  );

  const handleVoiceError = useCallback(
    (err: VoiceInputError) => {
      if (err.code === "permission-denied") {
        Message.error(tSessions("input.voiceErrorPermission"));
      } else if (err.code === "unsupported") {
        Message.error(tSessions("input.voiceErrorUnsupported"));
      } else if (err.code === "audio-capture") {
        Message.error(tSessions("input.voiceErrorAudio"));
      } else if (err.code === "no-speech") {
        // Silent — the recording bar simply resets.
      } else if (err.code !== "aborted") {
        Message.error(tSessions("input.voiceErrorGeneric"));
      }
    },
    [tSessions]
  );

  const voice = useVoiceInput({
    onCommit: handleVoiceCommit,
    onError: handleVoiceError,
  });

  const showVoiceUi =
    voiceFeatureEnabled && voice.isRecording && !hideLaunchButton;

  // Ctrl+M acts as push-to-talk while focus is inside this composer container.
  useEffect(() => {
    if (!voiceFeatureEnabled) return;
    const node = editorContainerRef.current;
    if (!node) return;
    let shortcutActive = false;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
        return;
      }
      if (event.key.toLowerCase() !== "m" || event.repeat) return;
      event.preventDefault();
      event.stopPropagation();
      shortcutActive = true;
      voice.start();
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (!shortcutActive) return;
      if (event.key.toLowerCase() !== "m" && event.key !== "Control") return;
      event.preventDefault();
      event.stopPropagation();
      shortcutActive = false;
      voice.stop();
    };
    node.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp, true);
    return () => {
      node.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp, true);
    };
  }, [voice, voiceFeatureEnabled]);

  const handleAtMention = useCallback(
    (query: string, position: { x: number; y: number }) => {
      setContextMenuKeyboardOpened(true);
      onAtMention?.(query, position);
    },
    [onAtMention]
  );

  // ============================================
  // Keyboard Handler for Dropdown
  // ============================================

  /**
   * Function ref for keyboard handler
   */
  const contextMenuFunctionRef = React.useRef<
    ((e: React.KeyboardEvent) => boolean) | null
  >(null);

  /**
   * Delegate keyboard events to the context menu when dropdown is visible
   */
  const handleKeyDownForDropdown = useCallback(
    (event: KeyboardEvent): boolean => {
      if (showContextMenu && contextMenuFunctionRef.current) {
        // Convert native KeyboardEvent to React.KeyboardEvent for the handler
        // NOTE: Spread doesn't copy prototype properties like `key`, so we must copy them explicitly
        const reactEvent = {
          key: event.key,
          code: event.code,
          altKey: event.altKey,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          shiftKey: event.shiftKey,
          repeat: event.repeat,
          preventDefault: () => event.preventDefault(),
          stopPropagation: () => event.stopPropagation(),
          nativeEvent: event,
        } as unknown as React.KeyboardEvent;
        return contextMenuFunctionRef.current(reactEvent);
      }
      return false;
    },
    [showContextMenu]
  );

  /**
   * Delegate keyboard events to the slash command dropdown when visible
   */
  const handleKeyDownForSlashDropdown = useCallback(
    (event: KeyboardEvent): boolean => {
      if (
        (showSlashMenu || showPlusSlashMenu) &&
        slashCommandKeyboardHandlerRef.current
      ) {
        return slashCommandKeyboardHandlerRef.current(event);
      }
      return false;
    },
    [showSlashMenu, showPlusSlashMenu, slashCommandKeyboardHandlerRef]
  );

  // ============================================
  // Render
  // ============================================

  return (
    <div
      data-testid="chat-input"
      className={`relative w-full ${isChatPanelFullScreen ? "session-creator-chat-panel" : ""}`}
    >
      <ComposerShell
        ref={editorContainerRef}
        variant="default"
        data-chat-drop-target
        className={[
          "wp_text_area",
          isDragOver
            ? "!border-primary-6 !bg-[color-mix(in_srgb,var(--color-primary-6)_5%,var(--color-chat-input))] !shadow-[0_0_0_2px_color-mix(in_srgb,var(--color-primary-6)_20%,transparent)]"
            : "",
          shellClassName ?? "",
        ]
          .filter(Boolean)
          .join(" ")}
        onDragOver={handleReferenceDragOver}
        onDragLeave={handleReferenceDragLeave}
        onDropCapture={handleReferenceDrop}
        style={{
          height: isCompact ? "auto" : `${SESSION_CONFIG.EDITOR_HEIGHT}px`,
        }}
      >
        {headerContent}

        {/* Uploaded Files Pills */}
        {uploadedFiles.length > 0 && (
          <div>
            <UploadPills
              files={uploadedFiles}
              onRemove={onRemoveFile}
              className="mb-2"
            />
          </div>
        )}

        {/* Session Info Line — only rendered when a caller opts into the
            internal info line AND wires both handlers. In practice all
            current callers pass hideInfoLine={true} and render their own. */}
        {!hideInfoLine && onRepoChange && onBranchChange && (
          <div className="mb-2">
            <SessionInfoLine
              repoId={repoId}
              repoName={repoName}
              repoPath={repoPath}
              onRepoChange={onRepoChange}
              repoKind={repoKind}
              branchName={branchName}
              onBranchChange={onBranchChange}
              branchLoading={branchLoading}
            />
          </div>
        )}

        {/* Image Attachment Preview */}
        {attachedImages && attachedImages.length > 0 && onRemoveImage && (
          <ImageThumbnailRow images={attachedImages} onRemove={onRemoveImage} />
        )}

        {/* Composer Input Area */}
        <ComposerInput
          ref={setComposerInputElement}
          initialContent={initialContent ?? ""}
          placeholder={editorPlaceholder}
          onContentChange={(text) => onContentChange?.(text)}
          onAtMention={handleAtMention}
          onAtMentionClose={onAtMentionClose}
          onSubmit={onSubmit}
          requireCmdEnter={!sendOnEnter}
          autoFocus={autoFocus}
          className="session-editor flex-1 cursor-text overflow-y-auto rounded-md text-[14px] text-text-1"
          minHeight={editorMinHeight ?? (isChatPanelFullScreen ? 60 : 100)}
          maxHeight={editorMaxHeight ?? (isChatPanelFullScreen ? 200 : 300)}
          onKeyDownForDropdown={handleKeyDownForDropdown}
          onSlashCommand={onSlashCommand}
          onSlashCommandClose={onSlashCommandClose}
          onInputMouseDown={handlePlusSlashClose}
          onKeyDownForSlashDropdown={handleKeyDownForSlashDropdown}
          onImagePaste={onImagePaste}
        />

        {/* Context Menu for @ mentions - rendered via portal to avoid clipping */}
        <ContextMenuPortal
          visible={showContextMenu}
          containerRef={editorContainerRef}
          onClose={handleContextMenuClose}
          onSelect={onAtSelect}
          searchQuery={atSearchQuery}
          keyboardOpened={contextMenuKeyboardOpened}
          repoPath={repoPath}
          keyboardHandlerRef={contextMenuFunctionRef}
          placement={resolvedDropdownDirection}
        />

        {/* Slash Command Menu - inline "/" trigger */}
        {onSlashCommand && (
          <SlashCommandPortal
            visible={showSlashMenu}
            containerRef={editorContainerRef}
            placement={resolvedDropdownDirection}
            items={filteredSlashItems}
            loading={slashLoading}
            currentMode={currentMode}
            searchQuery={slashQuery}
            onClose={onSlashCommandClose ?? handlePlusSlashClose}
            onSelect={(item) => onSlashSelect?.(item)}
            onModeSelect={(mode) => onModeSelect?.(mode)}
            keyboardHandlerRef={slashCommandKeyboardHandlerRef}
            showActionFlyouts
            onImageUpload={onUploadClick}
          />
        )}

        {/* Slash Command Menu - "+" button trigger (header search mode) */}
        {onSlashCommand && (
          <SlashCommandPortal
            visible={showPlusSlashMenu}
            containerRef={editorContainerRef}
            anchorSelector="[data-composer-plus-menu-trigger]"
            placement={resolvedDropdownDirection}
            items={filteredSlashItems}
            loading={slashLoading}
            currentMode={currentMode}
            searchQuery={plusSlashQuery}
            onClose={handlePlusSlashClose}
            onSelect={(item) => {
              onSlashSelect?.(item);
              handlePlusSlashClose();
            }}
            onModeSelect={(mode) => {
              onModeSelect?.(mode);
              handlePlusSlashClose();
            }}
            keyboardHandlerRef={slashCommandKeyboardHandlerRef}
            searchMode="header"
            showActionFlyouts
            onSearchQueryChange={handlePlusSlashQueryChange}
            onImageUpload={() => {
              handlePlusSlashClose();
              onUploadClick();
            }}
          />
        )}

        {/* Control Bar */}
        {showVoiceUi ? (
          <VoiceRecordingBar
            elapsedSeconds={voice.elapsedSeconds}
            onCancel={voice.cancel}
            onAccept={voice.stop}
            onAddContent={handleManualAtMentionClick}
          />
        ) : (
          <ComposerBar
            onAddContent={handleManualAtMentionClick}
            onUpload={onUploadClick}
            onOpenSkillsTools={
              onSlashCommand ? handleOpenSkillsTools : undefined
            }
            dropdownDirection={resolvedDropdownDirection}
            repoPath={repoPath}
            toolbarItemGap={false}
            showContextInfo={false}
            pills={
              <ControlButtons
                advancedConfig={advancedConfig}
                onConfigChange={onAdvancedConfigChange}
                dropdownDirection={resolvedDropdownDirection}
                requestModelOpen={requestModelOpen}
                onModelOpenHandled={onModelOpenHandled}
                hideModelSourcePill={hideModelSourcePill}
              />
            }
            submitButton={
              !hideLaunchButton ? (
                <>
                  {voiceFeatureEnabled && (
                    <VoiceInputButton
                      onPressStart={voice.start}
                      onPressEnd={voice.stop}
                      disabled={!voice.isSupported}
                    />
                  )}
                  <LaunchButton
                    disabled={launchDisabled ?? false}
                    loading={isLoading}
                    onClick={onLaunch}
                    label={launchLabel}
                  />
                </>
              ) : undefined
            }
          />
        )}
      </ComposerShell>
    </div>
  );
};

export default EditorArea;
