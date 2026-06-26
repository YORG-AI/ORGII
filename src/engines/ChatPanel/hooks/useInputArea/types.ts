/**
 * Shared types for useInputArea hook modules
 */
import type {
  ChangeEvent,
  DragEvent,
  MutableRefObject,
  KeyboardEvent as ReactKeyboardEvent,
  RefObject,
} from "react";

import type { ComposerInputRef } from "@src/components/ComposerInput";
import type { AgentExecMode } from "@src/config/sessionCreatorConfig";
import type { MenuItemId } from "@src/scaffold/ContextMenu/config";
import type { ChatImageAttachment } from "@src/store/ui/chatImageAtom";
import type { SlashItem } from "@src/types/extensions/types";

// ============================================
// Options
// ============================================

export interface SubmitOverrideInput {
  displayText: string;
  agentContent?: string;
  imageDataUrls?: string[];
}

export interface CustomMentionOption {
  id: string;
  label: string;
  description?: string;
  groupLabel?: string;
  selectType?: MenuItemId;
  selectValue?: string;
  selectDisplayName?: string;
}

export interface UseInputAreaOptions {
  /** Custom placeholder text */
  placeholder?: string;
  /** Explicit session ID for the chat surface using this composer. */
  sessionId?: string;
  sessionScope?: "active" | "none";
  submitDisabled?: boolean;
  onSubmitOverride?: (input: SubmitOverrideInput) => Promise<boolean>;
  customMentionOptions?: ReadonlyArray<CustomMentionOption>;
}

export interface SubmitMessageOptions {
  capturedText?: string;
}

// ============================================
// Sub-hook Return Types
// ============================================

export interface InputAreaRefs {
  composerInputRef: RefObject<ComposerInputRef | null>;
  containerRef: RefObject<HTMLDivElement | null>;
  contextMenuKeyboardHandlerRef: MutableRefObject<
    ((event: ReactKeyboardEvent) => boolean) | null
  >;
  slashCommandKeyboardHandlerRef: MutableRefObject<
    ((event: globalThis.KeyboardEvent) => boolean) | null
  >;
  plusSlashCommandKeyboardHandlerRef: MutableRefObject<
    ((event: globalThis.KeyboardEvent) => boolean) | null
  >;
  hasContentRef: MutableRefObject<boolean>;
  setHasContent: (value: boolean) => void;
}

export interface InputAreaState {
  // Expanded/Collapsed state
  // Input focus state
  isInputFocused: boolean;
  setIsInputFocused: (focused: boolean) => void;

  // @ Mention state
  showContextMenu: boolean;
  setShowContextMenu: (show: boolean) => void;
  atSearchQuery: string;
  setAtSearchQuery: (query: string) => void;

  // Slash command state
  showSlashMenu: boolean;
  setShowSlashMenu: (show: boolean) => void;
  slashQuery: string;
  setSlashQuery: (query: string) => void;
}

export interface AtMentionHandlers {
  handleAtMention: (query: string, position: { x: number; y: number }) => void;
  handleAtMentionClose: () => void;
  handleAtSelect: (
    type: MenuItemId,
    value?: string,
    displayName?: string
  ) => void;
  handleCustomMentionSelect: (option: CustomMentionOption) => void;
}

export interface CiteCodeSnapshot {
  isCiteCode: boolean;
  selectedCiteRange: { start: number; end: number } | null;
  selectedCiteText: string;
  citeFileName: string;
}

export interface CiteCodeState {
  isCiteCode: boolean;
  selectedCiteRange: { start: number; end: number } | null;
  selectedCiteText: string;
  citeFileName: string;
  clearCiteCode: () => void;
  /**
   * Restore a previously-captured snapshot. Used by the InputArea
   * submit failure path so a network blip doesn't silently wipe the
   * user's cite-code banner.
   */
  restoreCiteCode: (snapshot: CiteCodeSnapshot) => void;
  /** Capture the current cite-code state by value for later restoration. */
  captureCiteCode: () => CiteCodeSnapshot;
}

export interface FileSelectionHandlers {
  handleSelectFile: (file: string) => void;
}

export interface UploadContextHandlers {
  fileInputRef: RefObject<HTMLInputElement | null>;
  handleUploadClick: () => void;
  handleFileUpload: (event: ChangeEvent<HTMLInputElement>) => Promise<void>;
}

export interface DragDropHandlers {
  handleDragOver: (e: DragEvent<HTMLDivElement>) => void;
  handleDragLeave: (e: DragEvent<HTMLDivElement>) => void;
  handleDrop: (e: DragEvent<HTMLDivElement>) => void;
}

// ============================================
// Main Return Type
// ============================================

export interface UseInputAreaReturn {
  // Refs
  composerInputRef: RefObject<ComposerInputRef | null>;
  containerRef: RefObject<HTMLDivElement | null>;
  contextMenuKeyboardHandlerRef: MutableRefObject<
    ((event: ReactKeyboardEvent) => boolean) | null
  >;
  slashCommandKeyboardHandlerRef: MutableRefObject<
    ((event: globalThis.KeyboardEvent) => boolean) | null
  >;
  plusSlashCommandKeyboardHandlerRef: MutableRefObject<
    ((event: globalThis.KeyboardEvent) => boolean) | null
  >;

  hasContentRef: MutableRefObject<boolean>;

  // Input state
  isInputFocused: boolean;
  setIsInputFocused: (focused: boolean) => void;
  handleInputBlur: () => void;
  handleContentChange: (text: string) => void;
  handleAtMention: (query: string, position: { x: number; y: number }) => void;
  handleAtMentionClose: () => void;
  isInputEmpty: () => boolean;

  // Context Menu
  showContextMenu: boolean;
  setShowContextMenu: (show: boolean) => void;
  atSearchQuery: string;
  setAtSearchQuery: (query: string) => void;
  handleAtSelect: (
    type: MenuItemId,
    value?: string,
    displayName?: string
  ) => void;
  handleCustomMentionSelect: (option: CustomMentionOption) => void;
  customMentionOptions: ReadonlyArray<CustomMentionOption>;

  // Slash command
  showSlashMenu: boolean;
  slashQuery: string;
  handleSlashCommand: (query: string) => void;
  handleSlashCommandClose: () => void;
  handleSlashSelect: (item: SlashItem) => void;
  handleSlashAppendSelect: (item: SlashItem) => void;
  handleModeSelect: (mode: AgentExecMode) => void;
  currentMode: AgentExecMode;
  filteredSlashItems: SlashItem[];
  slashLoading: boolean;
  prefetchSlashItems: (query: string) => void;

  // File selection
  handleSelectFile: (file: string) => void;

  // Context management
  contextItemsAtChat: string[];
  setContextItemsAtChat: (items: string[]) => void;

  // Upload
  fileInputRef: RefObject<HTMLInputElement | null>;
  handleUploadClick: () => void;
  handleFileUpload: (event: ChangeEvent<HTMLInputElement>) => Promise<void>;

  // Cite code
  isCiteCode: boolean;
  selectedCiteRange: { start: number; end: number } | null;
  selectedCiteText: string;
  citeFileName: string;
  clearCiteCode: () => void;

  // Message submission
  handleDivSubmit: (options?: SubmitMessageOptions) => Promise<void>;
  isWpGeneWorking: boolean;
  isSessionActive: boolean;
  /** True while a cancel has been dispatched but Rust hasn't acknowledged yet. */
  isPendingCancel: boolean;
  wpReadOnly: boolean;

  // Session control
  interruptSession: () => Promise<void>;
  resumeSession: () => Promise<void>;
  isHosted: boolean;
  /** True when stop button is available (cloud or OS Agent sessions) */
  canStopAgent: boolean;
  /** True when the session supports resume (CLI-only; Rust agents don't) */
  canResume: boolean;
  /** True when CLI session is in a terminal state (failed/cancelled/completed) */
  isSessionTerminal: boolean;

  // Drag & drop
  dropTargetId: string;
  handleDragOver: (e: DragEvent<HTMLDivElement>) => void;
  handleDragLeave: (e: DragEvent<HTMLDivElement>) => void;
  handleDrop: (e: DragEvent<HTMLDivElement>) => void;

  // Styling
  isDark: boolean;

  // Context hooks
  feedBack: unknown;
  setFeedBack: (info: unknown) => void;
  replyInfo: { isReply: boolean };
  setReplyInfo: (info: { isReply: boolean }) => void;
  localContextList: unknown[];
  currentRepoPath: string | undefined;
  skillWorkspacePaths: string[];

  // Image attachments
  attachedImages: ChatImageAttachment[];
  handleImagePaste: (files: File[]) => void;
  hasImages: boolean;
  clearAttachedImages: () => void;
}
