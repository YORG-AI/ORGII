/**
 * useComposerInput Hook
 *
 * Provides state and handlers for ComposerInput integration.
 * This is a simpler alternative to useContextInput that uses the browser's
 * contenteditable selection and cursor management.
 *
 * @example
 * const { composerInputRef, handleAtSelect, ... } = useComposerInput({
 *   onContentChange: (content) => */
import {
  type MutableRefObject,
  type RefObject,
  useCallback,
  useRef,
  useState,
} from "react";

import {
  type ComposerInputRef,
  type PillIconType,
} from "@src/components/ComposerInput";
import { getTerminalBuffer } from "@src/components/TerminalInteractive/bufferCache";
import { storePillText } from "@src/config/pillTokens";
import type { AgentExecMode } from "@src/config/sessionCreatorConfig";
import { useSlashCommand } from "@src/engines/ChatPanel/hooks/useInputArea/useSlashCommand";
import type { SlashItem } from "@src/types/extensions";
import {
  capPillText,
  loadBrowserPillContent,
} from "@src/util/contextPillContent";
import { toBackendPtySessionId } from "@src/util/ui/terminal/ptySessionId";
import { useCurrentTheme } from "@src/util/ui/theme/themeUtils";

// ============================================
// Helpers
// ============================================

/**
 * Detect if a path is likely a folder based on:
 * - Ends with /
 * - Common folder names
 */
function isLikelyFolder(path: string): boolean {
  if (!path) return false;

  // Ends with slash is definitely a folder
  if (path.endsWith("/")) return true;

  // Get the last segment
  const fileName = path.split("/").pop() || path;

  // Common folder names
  const folderNames = [
    "node_modules",
    "src",
    "lib",
    "dist",
    "build",
    "public",
    "assets",
    "components",
    "hooks",
    "utils",
    "types",
    "styles",
    "pages",
    "features",
    "api",
    "store",
    "config",
    "tests",
    "__tests__",
    "__mocks__",
    ".git",
    ".vscode",
    ".idea",
  ];

  if (folderNames.includes(fileName.toLowerCase())) return true;

  return false;
}

// ============================================
// Types
// ============================================

export interface ContextItem {
  type: "file" | "folder";
  path: string;
  name: string;
}

export interface UseComposerInputOptions {
  /** Callback when text content changes */
  onContentChange?: (text: string) => void;
  /** Callback when context items (file pills) change */
  onContextItemsChange?: (items: ContextItem[]) => void;
  /**
   * When `true`, the embedded `/mode` picker reads + writes the
   * creator-default exec mode atom even if there is an active session
   * in the route. Pass this from `SessionCreator` (and any other
   * non-in-session input host) so the previously-active session's
   * pill is not silently rewritten by typing `/` in the creator.
   */
  creatorDefaultMode?: boolean;
  /** Repo/workspace roots whose workspace skills should appear in `/`. */
  workspacePaths?: string[];
}

export interface UseComposerInputReturn {
  /** Ref to attach to ComposerInput */
  composerInputRef: RefObject<ComposerInputRef | null>;
  /** Keyboard handler ref for context menu navigation */
  contextMenuKeyboardHandlerRef: RefObject<{
    handleKeyDown: (e: KeyboardEvent) => boolean;
  } | null>;
  /** Keyboard handler ref for slash command navigation */
  slashCommandKeyboardHandlerRef: MutableRefObject<
    ((e: KeyboardEvent) => boolean) | null
  >;
  /** Whether context menu is visible */
  showContextMenu: boolean;
  /** Set context menu visibility */
  setShowContextMenu: (show: boolean) => void;
  /** Current @ search query */
  atSearchQuery: string;
  /** Set @ search query */
  setAtSearchQuery: (query: string) => void;
  /** Current context items (file pills) */
  contextItems: ContextItem[];
  /** Dark mode flag */
  isDark: boolean;
  /** Handle @ mention trigger from ComposerInput */
  handleAtMention: (query: string, position: { x: number; y: number }) => void;
  /** Handle @ mention close */
  handleAtMentionClose: () => void;
  /** Handle selection from @ dropdown (type, value, optional displayName) */
  handleAtSelect: (type: string, value?: string, displayName?: string) => void;
  /** Handle manual @ button click */
  handleAtMentionClick: () => void;
  /** Whether the @ menu was opened by typing @ in the editor. */
  contextMenuKeyboardOpened: boolean;
  /** Get plain text content */
  getTextContent: () => string;
  /** Get all file pills */
  getFilePills: () => Array<{ filePath: string; fileName: string }>;
  /** Clear input */
  clearInput: () => void;
  /** Focus input */
  focusInput: () => void;

  // Slash command (/ menu)
  showSlashMenu: boolean;
  setShowSlashMenu: (show: boolean) => void;
  slashQuery: string;
  setSlashQuery: (query: string) => void;
  handleSlashCommand: (query: string) => void;
  handleSlashCommandClose: () => void;
  handleSlashSelect: (item: SlashItem) => void;
  handleModeSelect: (mode: AgentExecMode) => void;
  currentMode: AgentExecMode;
  filteredSlashItems: SlashItem[];
  slashLoading: boolean;
  prefetchSlashItems: (query: string) => void;
}

// ============================================
// Hook Implementation
// ============================================

export function useComposerInput(
  options: UseComposerInputOptions = {}
): UseComposerInputReturn {
  const {
    onContentChange: _onContentChange,
    onContextItemsChange,
    creatorDefaultMode = false,
    workspacePaths,
  } = options;

  // ============================================
  // Refs
  // ============================================

  const composerInputRef = useRef<ComposerInputRef>(null);
  const contextMenuKeyboardHandlerRef = useRef<{
    handleKeyDown: (e: KeyboardEvent) => boolean;
  }>(null);

  // ============================================
  // State
  // ============================================

  const [showContextMenu, setShowContextMenu] = useState(false);
  const [atSearchQuery, setAtSearchQuery] = useState("");
  const [contextMenuKeyboardOpened, setContextMenuKeyboardOpened] =
    useState(false);
  const [contextItems, setContextItems] = useState<ContextItem[]>([]);
  const [_dropdownPosition, setDropdownPosition] = useState({ x: 0, y: 0 });

  // Slash command state
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashQuery, setSlashQuery] = useState("");
  const slashCommandKeyboardHandlerRef = useRef<
    ((e: KeyboardEvent) => boolean) | null
  >(null);

  // ============================================
  // Slash Command Hook
  // ============================================

  const {
    handleSlashCommand,
    handleSlashCommandClose,
    handleSlashSelect,
    handleModeSelect,
    currentMode,
    filteredItems: filteredSlashItems,
    slashLoading,
    prefetchItems: prefetchSlashItems,
  } = useSlashCommand({
    composerInputRef,
    setShowSlashMenu,
    setSlashQuery,
    creatorDefaultMode,
    workspacePaths,
  });

  // ============================================
  // Theme
  // ============================================

  const { isDark } = useCurrentTheme();

  // ============================================
  // Handlers
  // ============================================

  /**
   * Handle @ mention trigger from ComposerInput
   */
  const handleAtMention = useCallback(
    (query: string, position: { x: number; y: number }) => {
      setContextMenuKeyboardOpened(true);
      setAtSearchQuery(query);
      setDropdownPosition(position);
      setShowContextMenu(true);
    },
    []
  );

  /**
   * Handle @ mention close
   */
  const handleAtMentionClose = useCallback(() => {
    setContextMenuKeyboardOpened(false);
    setShowContextMenu(false);
    setAtSearchQuery("");
  }, []);

  /**
   * Map menu type to pill icon type
   */
  const getIconType = (type: string): PillIconType | undefined => {
    switch (type) {
      case "terminals":
      case "terminal":
        return "terminal";
      case "sessions":
      case "session":
        return "session";
      case "browser":
        return "browser";
      case "repo":
        return "repo";
      case "branch":
        return "branch";
      case "folders":
      case "folder":
      case "directory":
        return "folder";
      case "files":
      case "file":
        return "file";
      default:
        return undefined;
    }
  };

  /**
   * Handle selection from @ dropdown
   * ContextMenu calls onSelect(type, value, displayName) where:
   * - type is MenuItemId like "files", "folders", "terminals", "sessions", "browser"
   * - value is the file/folder path or item id
   * - displayName is the human-readable name (optional, used for terminal/session/browser)
   */
  const handleAtSelect = useCallback(
    (type: string, value?: string, displayName?: string) => {
      if (!composerInputRef.current || !value) return;

      // Determine icon type based on menu selection
      const iconType = getIconType(type);

      // Terminal pills: unify with paste flow so getTerminalPillTexts() picks them up
      if (iconType === "terminal") {
        // Ask all mounted TerminalView instances to snapshot their buffer to cache
        window.dispatchEvent(new Event("terminal-snapshot-request"));
        const ptySessionId = toBackendPtySessionId(value);
        const buffer = getTerminalBuffer(ptySessionId);
        if (buffer) {
          const capped = capPillText(buffer);
          const lineCount = capped.split("\n").length;
          const pillPath = `terminal://${value}/${Date.now()}`;
          const pillDisplayName =
            lineCount > 1
              ? `${displayName || "Terminal"} (1-${lineCount})`
              : displayName || "Terminal";

          storePillText(pillPath, capped);

          composerInputRef.current.insertFilePill(
            pillPath,
            false,
            "terminal",
            pillDisplayName
          );

          const newItems = [
            ...contextItems,
            { type: "file" as const, path: pillPath, name: pillDisplayName },
          ];
          setContextItems(newItems);
          onContextItemsChange?.(newItems);
          handleAtMentionClose();
          return;
        }
        // No buffer available — fall through to default pill (navigation-only)
      }

      // Session pills: pass session ID only — no transcript loading
      if (iconType === "session") {
        const pillPath = `session://${value}/${Date.now()}`;
        const pillDisplayName = displayName || "Session";
        composerInputRef.current.insertFilePill(
          pillPath,
          false,
          "session",
          pillDisplayName
        );

        const newItems = [
          ...contextItems,
          { type: "file" as const, path: pillPath, name: pillDisplayName },
        ];
        setContextItems(newItems);
        onContextItemsChange?.(newItems);
        handleAtMentionClose();
        return;
      }

      // Browser pills: load URL and page content
      if (iconType === "browser") {
        const pillPath = `browser://${value}/${Date.now()}`;
        const pillDisplayName = displayName || "Browser Tab";
        composerInputRef.current.insertFilePill(
          pillPath,
          false,
          "browser",
          pillDisplayName
        );
        loadBrowserPillContent(value, pillPath);

        const newItems = [
          ...contextItems,
          { type: "file" as const, path: pillPath, name: pillDisplayName },
        ];
        setContextItems(newItems);
        onContextItemsChange?.(newItems);
        handleAtMentionClose();
        return;
      }

      // Determine if it's a folder only for file/folder types (not repo/branch)
      let isFolder = false;
      if (!iconType || iconType === "file" || iconType === "folder") {
        const isFolderByType =
          type === "folders" || type === "folder" || type === "directory";
        const isFolderByPath = isLikelyFolder(value);
        isFolder = isFolderByType || isFolderByPath;
      }

      // Use provided displayName, or extract from path/value
      const resolvedDisplayName =
        displayName || value.split("/").pop() || value;

      // Insert the pill with correct icon type and display name
      composerInputRef.current.insertFilePill(
        value,
        isFolder,
        iconType,
        resolvedDisplayName
      );

      // Update context items
      const newItem: ContextItem = {
        type: isFolder ? "folder" : "file",
        path: value,
        name: resolvedDisplayName,
      };

      const newItems = [...contextItems, newItem];
      setContextItems(newItems);
      onContextItemsChange?.(newItems);

      // Close dropdown
      handleAtMentionClose();
    },
    [contextItems, onContextItemsChange, handleAtMentionClose]
  );

  /**
   * Handle manual @ button click
   */
  const handleAtMentionClick = useCallback(() => {
    setContextMenuKeyboardOpened(false);
    if (!composerInputRef.current) return;

    const editor = composerInputRef.current.getEditor();
    if (!editor) return;

    // Focus and insert @ character
    editor.chain().focus().insertContent("@").run();

    // Trigger @ mention mode (sets internal state + calls onAtMention)
    setTimeout(() => {
      composerInputRef.current?.triggerAtMention();
    }, 0);
  }, []);

  /**
   * Get plain text content
   */
  const getTextContent = useCallback((): string => {
    return composerInputRef.current?.getText() || "";
  }, []);

  /**
   * Get all file pills
   */
  const getFilePills = useCallback((): Array<{
    filePath: string;
    fileName: string;
  }> => {
    return composerInputRef.current?.getFilePills() || [];
  }, []);

  /**
   * Clear input
   */
  const clearInput = useCallback(() => {
    composerInputRef.current?.clear();
    setContextItems([]);
  }, []);

  /**
   * Focus input
   */
  const focusInput = useCallback(() => {
    composerInputRef.current?.focus();
  }, []);

  // ============================================
  // Return
  // ============================================

  return {
    composerInputRef,
    contextMenuKeyboardHandlerRef,
    slashCommandKeyboardHandlerRef,
    showContextMenu,
    setShowContextMenu,
    atSearchQuery,
    setAtSearchQuery,
    contextItems,
    isDark,
    handleAtMention,
    handleAtMentionClose,
    handleAtSelect,
    handleAtMentionClick,
    contextMenuKeyboardOpened,
    getTextContent,
    getFilePills,
    clearInput,
    focusInput,

    // Slash command
    showSlashMenu,
    setShowSlashMenu,
    slashQuery,
    setSlashQuery,
    handleSlashCommand,
    handleSlashCommandClose,
    handleSlashSelect,
    handleModeSelect,
    currentMode,
    filteredSlashItems,
    slashLoading,
    prefetchSlashItems,
  };
}

export default useComposerInput;
