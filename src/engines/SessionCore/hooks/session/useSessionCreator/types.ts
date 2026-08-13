/**
 * Type definitions for SessionCreator feature
 */
import type { ChangeEvent, MutableRefObject, RefObject } from "react";

import type { AgentInfo, ProviderInfo } from "@src/api/http/config";
import type { ComposerInputRef } from "@src/components/ComposerInput";
import type { ComposerModeEntry } from "@src/config/sessionCreatorConfig";
import type {
  AdvancedConfig,
  UploadedFile,
} from "@src/features/SessionCreator/types";
import type { Repo } from "@src/store/repo";
import type { SessionSource } from "@src/store/session/creatorStateAtom";
import type { ChatImageAttachment } from "@src/store/ui/chatImageAtom";
import type { SlashItem } from "@src/types/extensions";

/**
 * Handler interface for keyboard navigation in context menu
 */
export interface ContextMenuKeyboardHandler {
  handleKeyDown: (e: KeyboardEvent) => boolean;
}

export interface UseSessionCreatorReturn {
  // Refs
  fileInputRef: RefObject<HTMLInputElement | null>;
  composerInputRef: RefObject<ComposerInputRef | null>;
  contextMenuKeyboardHandlerRef: RefObject<ContextMenuKeyboardHandler | null>;
  slashCommandKeyboardHandlerRef: MutableRefObject<
    ((e: KeyboardEvent) => boolean) | null
  >;

  // State
  editorContent: string;
  setEditorContent: (content: string) => void;
  sessionName: string;
  setSessionName: (name: string) => void;
  uploadedFiles: UploadedFile[];
  isLoading: boolean;
  advancedConfig: AdvancedConfig;
  setAdvancedConfig: (
    nextOrUpdater: AdvancedConfig | ((prev: AdvancedConfig) => AdvancedConfig)
  ) => void;

  // Computed value — the session-scoped draft (sessionSourceAtom) overlaid
  // on the global repo selection. `null` ≡ no repo available anywhere.
  effectiveSource: SessionSource | null;
  repos: Repo[];

  // Discovery data
  providers: ProviderInfo[];
  agents: AgentInfo[];

  // Context input
  showContextMenu: boolean;
  setShowContextMenu: (show: boolean) => void;
  atSearchQuery: string;
  setAtSearchQuery: (query: string) => void;
  isDark: boolean;

  // Slash command (/ menu)
  showSlashMenu: boolean;
  slashQuery: string;
  handleSlashCommand: (query: string) => void;
  handleSlashCommandClose: () => void;
  handleSlashSelect: (item: SlashItem) => void;
  handleModeSelect: (mode: ComposerModeEntry["id"]) => void;
  currentMode: ComposerModeEntry["id"];
  includeProjectMode: boolean;
  filteredSlashItems: SlashItem[];
  slashLoading: boolean;
  prefetchSlashItems: (query: string) => void;

  // Event handlers
  handleFileUpload: (e: ChangeEvent<HTMLInputElement>) => void;
  handleRemoveFile: (fileId: string) => void;
  handleUploadClick: () => void;
  handleContentChange: (text: string) => void;
  handleAtMention: (query: string, position: { x: number; y: number }) => void;
  handleAtMentionClose: () => void;
  handleAtMentionClick: () => void;
  handleAtSelect: (type: string, value?: string, displayName?: string) => void;
  handleLaunch: () => Promise<boolean>;
  canLaunch: boolean;

  // Wallet/credit balance error modal triggers. Modal components live
  // under `.market/` (archived for OSS) — render sites mount nothing in
  // the OSS build and show a toast instead. The flag seam is kept so the
  // commercial build only restores the modal mount, not the wiring.
  showAddFundsModal: boolean;
  closeAddFundsModal: () => void;
  showBuyCreditsModal: boolean;
  closeBuyCreditsModal: () => void;

  // Branch change handler — updates the session-scoped draft branch only.
  // Does NOT perform a git checkout.
  handleBranchChange: (branch: string) => void;
  // Real git checkout — switches the active workspace branch. Invoked by the
  // "also switch workspace?" confirmation in SessionInfoLine.
  checkoutBranch: (branch: string) => Promise<void>;

  // Image attachments
  attachedImages: ChatImageAttachment[];
  handleImagePaste: (files: File[]) => void;
  removeImage: (id: string) => void;
  clearImages: () => void;
  hasImages: boolean;
}
