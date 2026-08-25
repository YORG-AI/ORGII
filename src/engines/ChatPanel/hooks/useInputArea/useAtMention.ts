/**
 * useAtMention
 *
 * Handles @ mention dropdown logic for the InputArea
 */
import type { MenuItemId } from "@/src/scaffold/ContextMenu/config";
import { type MutableRefObject, type RefObject, useCallback } from "react";

import type { ComposerInputRef } from "@src/components/ComposerInput";
import { getTerminalBuffer } from "@src/components/TerminalInteractive/bufferCache";
import { storePillText } from "@src/config/pillTokens";
import { referenceInsertText } from "@src/features/Org2Cloud/referenceInsertText";
import { createLogger } from "@src/hooks/logger";
import {
  capPillText,
  loadBrowserPillContent,
  loadWorkItemPillContent,
} from "@src/util/contextPillContent";
import { toBackendPtySessionId } from "@src/util/ui/terminal/ptySessionId";

import type { AtMentionHandlers, CustomMentionOption } from "./types";

const log = createLogger("useAtMention");

interface UseAtMentionOptions {
  composerInputRef: RefObject<ComposerInputRef | null>;
  hasContentRef: MutableRefObject<boolean>;
  setShowContextMenu: (show: boolean) => void;
  setAtSearchQuery: (query: string) => void;
  handleSelectFile: (file: string) => void;
}

export function useAtMention(options: UseAtMentionOptions): AtMentionHandlers {
  const {
    composerInputRef,
    hasContentRef,
    setShowContextMenu,
    setAtSearchQuery,
    handleSelectFile,
  } = options;

  /**
   * Handle @ mention from ComposerInput
   */
  const handleAtMention = useCallback(
    (query: string, _position: { x: number; y: number }) => {
      setShowContextMenu(true);
      setAtSearchQuery(query);
    },
    [setShowContextMenu, setAtSearchQuery]
  );

  /**
   * Handle @ mention close
   */
  const handleAtMentionClose = useCallback(() => {
    setShowContextMenu(false);
    setAtSearchQuery("");
  }, [setShowContextMenu, setAtSearchQuery]);

  /**
   * Handle @ select - insert appropriate pill based on type
   */
  const handleAtSelect = useCallback(
    (type: MenuItemId | string, value?: string, displayName?: string) => {
      if (!composerInputRef.current || !value) {
        log.warn("[handleAtSelect] Missing composerInputRef or value", {
          composerInputRef: !!composerInputRef.current,
          value,
        });
        setShowContextMenu(false);
        setAtSearchQuery("");
        return;
      }

      // Resolve display name from value if not provided
      const resolvedDisplayName =
        displayName || value.split("/").pop() || value;

      switch (type) {
        case "files":
          handleSelectFile(value);
          break;
        case "repo":
          // Insert repo pill (path = repo path, displayName = repo name)
          composerInputRef.current.insertFilePill(
            value,
            false,
            "repo",
            resolvedDisplayName
          );
          hasContentRef.current = true;
          break;
        case "branch":
          // Insert branch pill (path = repoPath|branchName for serialization)
          composerInputRef.current.insertFilePill(
            value,
            false,
            "branch",
            resolvedDisplayName
          );
          hasContentRef.current = true;
          break;
        case "folder":
          // Insert folder pill with folder icon
          composerInputRef.current.insertFilePill(
            value,
            true, // is a folder
            "folder",
            resolvedDisplayName
          );
          hasContentRef.current = true;
          break;
        case "terminals":
        case "terminal": {
          // Unify with paste flow: use terminal:// path + store buffer content
          // Ask all mounted TerminalView instances to snapshot their buffer to cache
          window.dispatchEvent(new Event("terminal-snapshot-request"));
          const ptySessionId = toBackendPtySessionId(value);
          const buffer = getTerminalBuffer(ptySessionId);
          if (buffer) {
            const capped = capPillText(buffer);
            const lineCount = capped.trimEnd().split("\n").length;
            const pillPath = `terminal://${value}/${Date.now()}`;
            const pillDisplayName =
              lineCount > 1
                ? `${resolvedDisplayName} (1-${lineCount})`
                : resolvedDisplayName;

            storePillText(pillPath, capped);

            composerInputRef.current.insertFilePill(
              pillPath,
              false,
              "terminal",
              pillDisplayName
            );
          } else {
            composerInputRef.current.insertFilePill(
              value,
              false,
              "terminal",
              resolvedDisplayName
            );
          }
          hasContentRef.current = true;
          break;
        }
        case "cloudSession": {
          // A teammate's session has no local id, so it goes in as the
          // reference text the read boundary turns into a session card rather
          // than through the pill path, which assumes a local session.
          composerInputRef.current.insertMentionText(
            referenceInsertText(value)
          );
          hasContentRef.current = true;
          break;
        }
        case "sessions":
        case "session": {
          const sessionPillPath = `session://${value}/${Date.now()}`;
          composerInputRef.current.insertFilePill(
            sessionPillPath,
            false,
            "session",
            resolvedDisplayName
          );
          hasContentRef.current = true;
          break;
        }
        case "browser": {
          const browserPillPath = `browser://${value}/${Date.now()}`;
          composerInputRef.current.insertFilePill(
            browserPillPath,
            false,
            "browser",
            resolvedDisplayName
          );
          loadBrowserPillContent(value, browserPillPath);
          hasContentRef.current = true;
          break;
        }
        case "projects":
        case "project":
          composerInputRef.current.insertFilePill(
            value,
            false,
            "project",
            resolvedDisplayName
          );
          hasContentRef.current = true;
          break;
        case "workitem": {
          const workitemPillPath = `workitem://${value}/${Date.now()}`;
          composerInputRef.current.insertFilePill(
            workitemPillPath,
            false,
            "workitem",
            resolvedDisplayName
          );
          loadWorkItemPillContent(value, workitemPillPath);
          hasContentRef.current = true;
          break;
        }
        case "codebase": {
          // `value` is the full absolute path (repo_path/relative_path)
          // Insert as a regular file pill; the file path is what the agent needs
          composerInputRef.current.insertFilePill(
            value,
            false,
            "file",
            resolvedDisplayName
          );
          hasContentRef.current = true;
          break;
        }
        default:
          break;
      }

      setShowContextMenu(false);
      setAtSearchQuery("");
    },
    [
      composerInputRef,
      hasContentRef,
      handleSelectFile,
      setShowContextMenu,
      setAtSearchQuery,
    ]
  );

  const handleCustomMentionSelect = useCallback(
    (option: CustomMentionOption) => {
      if (!composerInputRef.current) {
        setShowContextMenu(false);
        setAtSearchQuery("");
        return;
      }
      if (option.selectType && option.selectValue) {
        handleAtSelect(
          option.selectType,
          option.selectValue,
          option.selectDisplayName ?? option.label
        );
        return;
      }

      composerInputRef.current.insertFilePill(
        `member://${option.id}`,
        false,
        "member",
        option.label
      );
      hasContentRef.current = true;
      setShowContextMenu(false);
      setAtSearchQuery("");
    },
    [
      composerInputRef,
      hasContentRef,
      handleAtSelect,
      setShowContextMenu,
      setAtSearchQuery,
    ]
  );

  return {
    handleAtMention,
    handleAtMentionClose,
    handleAtSelect,
    handleCustomMentionSelect,
  };
}
