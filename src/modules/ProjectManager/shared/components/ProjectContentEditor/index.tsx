import type { JSONContent } from "@tiptap/react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import type { PillIconType } from "@src/components/ComposerInput";
import Input from "@src/components/Input";
import { GHOST_INPUT_PLACEHOLDER_CLASS } from "@src/components/Input/tokens";
import ContextMenuPortal from "@src/engines/ChatPanel/InputArea/components/ContextMenuPortal";
import SlashCommandPortal from "@src/engines/ChatPanel/InputArea/components/SlashCommandPortal";
import { useComposerInput } from "@src/hooks/input";
import RichMarkdownEditor, {
  RICH_MARKDOWN_COMPOSER_TOOLBAR_CLASS,
  type RichMarkdownEditorRef,
} from "@src/modules/shared/components/RichMarkdownEditor";
import type { SlashItem } from "@src/types/extensions";

export interface ProjectContentEditorRef {
  getDescriptionText: () => string;
  getDescriptionHTML: () => string;
  getDescriptionJSON: () => JSONContent | undefined;
  getMarkdown: () => string;
  insertImage: (src: string, alt?: string) => void;
  insertFilePill: (filePath: string, displayName?: string) => void;
  triggerAtMention: () => void;
  triggerSlashContext: () => void;
  focusTitle: () => void;
  focusDescription: () => void;
}

export interface ProjectContentTitleInputProps {
  title: string;
  onTitleChange: (title: string) => void;
  titlePlaceholder?: string;
  autoFocusTitle?: boolean;
  editable?: boolean;
  titleActions?: ReactNode;
}

export interface ProjectContentEditorProps {
  title: string;
  onTitleChange: (title: string) => void;
  summary?: string;
  onSummaryChange?: (summary: string) => void;
  initialDescription?: string;
  onDescriptionChange?: (markdown: string, text: string) => void;
  onImageInsert?: (files: File[]) => void;
  titlePlaceholder?: string;
  summaryPlaceholder?: string;
  descriptionPlaceholder?: string;
  autoFocusTitle?: boolean;
  editable?: boolean;
  className?: string;
  titleVisible?: boolean;
  separatorVisible?: boolean;
  descriptionVisible?: boolean;
  titleActions?: ReactNode;
  metaContent?: ReactNode;
  descriptionClassName?: string;
  /** Formatting controls for the description editor. */
  descriptionToolbarMode?: "floating" | "inline";
  descriptionMinHeight?: number;
  descriptionMaxHeight?: number | string;
  repoPath?: string | null;
  dataTestId?: string;
  /** Direction used by @ mention and slash-command menus. */
  dropdownDirection?: "up" | "down";
}

export const ProjectContentTitleInput = forwardRef<
  HTMLInputElement,
  ProjectContentTitleInputProps
>(
  (
    {
      title,
      onTitleChange,
      titlePlaceholder,
      autoFocusTitle = false,
      editable = true,
      titleActions,
    },
    ref
  ) => (
    <div className="flex w-full min-w-0 items-start gap-3">
      <Input
        ref={ref}
        type="text"
        value={title}
        onChange={onTitleChange}
        placeholder={titlePlaceholder}
        autoFocus={autoFocusTitle}
        readOnly={!editable}
        appearance="bare"
        autoHeight
        className="mb-1 min-w-0 flex-1"
        inputClassName={`text-[22px] font-semibold text-text-2 ${GHOST_INPUT_PLACEHOLDER_CLASS}`}
      />
      {titleActions && (
        <div className="flex shrink-0 items-center gap-1 pt-0.5">
          {titleActions}
        </div>
      )}
    </div>
  )
);

ProjectContentTitleInput.displayName = "ProjectContentTitleInput";

const ProjectContentEditor = forwardRef<
  ProjectContentEditorRef,
  ProjectContentEditorProps
>(
  (
    {
      title,
      onTitleChange,
      summary,
      onSummaryChange,
      initialDescription = "",
      onDescriptionChange,
      onImageInsert,
      titlePlaceholder: titlePlaceholderProp,
      summaryPlaceholder: summaryPlaceholderProp,
      descriptionPlaceholder: descriptionPlaceholderProp,
      autoFocusTitle = false,
      editable = true,
      className = "",
      titleVisible = true,
      separatorVisible = true,
      descriptionVisible = true,
      titleActions,
      metaContent,
      descriptionClassName = "",
      descriptionToolbarMode = "floating",
      descriptionMinHeight = 200,
      descriptionMaxHeight,
      repoPath,
      dataTestId,
      dropdownDirection = "down",
    },
    ref
  ) => {
    const { t } = useTranslation("projects");
    const titlePlaceholder =
      titlePlaceholderProp ?? t("projects.editor.titlePlaceholder");
    const summaryPlaceholder =
      summaryPlaceholderProp ?? t("projects.editor.summaryPlaceholder");
    const descriptionPlaceholder =
      descriptionPlaceholderProp ?? t("projects.editor.descriptionPlaceholder");
    const titleRef = useRef<HTMLInputElement>(null);
    const editorContainerRef = useRef<HTMLDivElement>(null);
    const editorRef = useRef<RichMarkdownEditorRef>(null);
    const descriptionValueRef = useRef(initialDescription);
    const [slashOpenedFromToolbar, setSlashOpenedFromToolbar] = useState(false);
    const slashOpenedFromToolbarRef = useRef(false);
    const contextMenuKeyboardHandlerRef = useRef<
      ((event: ReactKeyboardEvent) => boolean) | null
    >(null);

    const {
      showContextMenu,
      atSearchQuery,
      handleAtMention,
      handleAtMentionClose,
      contextMenuKeyboardOpened,
      showSlashMenu,
      slashQuery,
      setSlashQuery,
      slashCommandKeyboardHandlerRef,
      handleSlashCommand,
      handleSlashCommandClose,
      handleModeSelect,
      currentMode,
      filteredSlashItems,
      slashLoading,
    } = useComposerInput();

    const skillSlashItems = useMemo<SlashItem[]>(
      () => filteredSlashItems.filter((item) => item.category === "skill"),
      [filteredSlashItems]
    );

    useEffect(() => {
      if (descriptionValueRef.current === initialDescription) return;
      descriptionValueRef.current = initialDescription;
      editorRef.current?.setContent(initialDescription);
    }, [initialDescription]);

    const getSerializedDescription = useCallback(
      () => editorRef.current?.getMarkdown() ?? descriptionValueRef.current,
      []
    );

    useImperativeHandle(ref, () => ({
      getDescriptionText: () => editorRef.current?.getText() ?? "",
      getDescriptionHTML: () => editorRef.current?.getHTML() ?? "",
      getDescriptionJSON: () => editorRef.current?.getJSON(),
      getMarkdown: getSerializedDescription,
      insertImage: (src: string, alt?: string) =>
        editorRef.current?.insertImage(src, alt),
      insertFilePill: (filePath: string, displayName?: string) => {
        editorRef.current?.insertFilePill(filePath, false, "file", displayName);
      },
      triggerAtMention: () => editorRef.current?.triggerAtMention(),
      triggerSlashContext: () => {
        slashOpenedFromToolbarRef.current = true;
        setSlashOpenedFromToolbar(true);
        setSlashQuery("");
        editorRef.current?.triggerSlashContext();
      },
      focusTitle: () => titleRef.current?.focus(),
      focusDescription: () => editorRef.current?.focus(),
    }));

    const handleDescriptionChange = (markdown: string, text: string) => {
      descriptionValueRef.current = markdown;
      onDescriptionChange?.(markdown, text);
    };

    const handleDescriptionContainerClick = useCallback(
      (event: ReactMouseEvent<HTMLDivElement>) => {
        const target = event.target;
        if (target instanceof HTMLElement) {
          if (target.closest(".ProseMirror, button")) {
            return;
          }
        }
        editorRef.current?.focus();
      },
      [editorRef]
    );

    const handleProjectAtSelect = useCallback(
      (type: string, value?: string, displayName?: string) => {
        if (!value) return;
        const normalizedType = type.toLowerCase();
        const iconTypeByMenuType: Record<string, PillIconType> = {
          files: "file",
          file: "file",
          folders: "folder",
          folder: "folder",
          directory: "folder",
          repo: "repo",
          branch: "branch",
          terminals: "terminal",
          terminal: "terminal",
          sessions: "session",
          session: "session",
          browser: "browser",
          project: "project",
          workitem: "workitem",
          issue: "issue",
          pr: "pr",
        };
        const iconType = iconTypeByMenuType[normalizedType] ?? "file";
        editorRef.current?.insertFilePill(
          value,
          iconType === "folder",
          iconType,
          displayName || value.split("/").pop() || value
        );
        handleAtMentionClose();
      },
      [handleAtMentionClose]
    );

    const handleContextMenuKeyDown = useCallback((event: KeyboardEvent) => {
      const handler = contextMenuKeyboardHandlerRef.current;
      if (!handler) return false;
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
      } as unknown as ReactKeyboardEvent;
      return handler(reactEvent);
    }, []);

    const handleProjectSlashClose = useCallback(() => {
      slashOpenedFromToolbarRef.current = false;
      setSlashOpenedFromToolbar(false);
      handleSlashCommandClose();
    }, [handleSlashCommandClose]);

    const handleProjectSlashSelect = useCallback(
      (item: SlashItem) => {
        slashOpenedFromToolbarRef.current = false;
        setSlashOpenedFromToolbar(false);
        if (item.category === "skill") {
          const skillToken = `/${item.skillName ?? item.name}`;
          editorRef.current?.insertFilePill(
            skillToken,
            false,
            "skill",
            item.name
          );
          editorRef.current?.focus();
          handleSlashCommandClose();
          return;
        }
        handleProjectSlashClose();
      },
      [handleProjectSlashClose, handleSlashCommandClose]
    );

    const handleProjectSlashCommand = useCallback(
      (query: string) => {
        if (!slashOpenedFromToolbarRef.current) {
          setSlashOpenedFromToolbar(false);
        }
        handleSlashCommand(query);
      },
      [handleSlashCommand]
    );

    const showSummary = onSummaryChange !== undefined || Boolean(summary);

    return (
      <div
        className={`w-full min-w-0 ${className}`.trim()}
        data-testid={dataTestId}
      >
        {titleVisible && (
          <ProjectContentTitleInput
            ref={titleRef}
            title={title}
            onTitleChange={onTitleChange}
            titlePlaceholder={titlePlaceholder}
            autoFocusTitle={autoFocusTitle}
            editable={editable}
            titleActions={titleActions}
          />
        )}

        {showSummary && (
          <Input
            type="text"
            value={summary ?? ""}
            onChange={(nextSummary) => onSummaryChange?.(nextSummary)}
            placeholder={summaryPlaceholder}
            readOnly={!editable && !onSummaryChange}
            appearance="bare"
            autoHeight
            className="mb-5 w-full"
            inputClassName={`text-[13px] text-text-2 ${GHOST_INPUT_PLACEHOLDER_CLASS}`}
          />
        )}

        {metaContent && <div className="mb-4 mt-3 w-full">{metaContent}</div>}

        {separatorVisible && (
          <div className="mb-4 mt-2 w-full border-t border-border-2" />
        )}

        {descriptionVisible && (
          <div
            ref={editorContainerRef}
            className={`${descriptionMaxHeight ? "min-h-0 flex-1" : "min-h-[200px]"} w-full min-w-0 cursor-text`}
            onClick={handleDescriptionContainerClick}
          >
            <RichMarkdownEditor
              ref={editorRef}
              value={initialDescription}
              onChange={handleDescriptionChange}
              placeholder={descriptionPlaceholder}
              onAtMention={editable ? handleAtMention : undefined}
              onAtMentionClose={editable ? handleAtMentionClose : undefined}
              onSlashCommand={editable ? handleProjectSlashCommand : undefined}
              onSlashCommandClose={
                editable ? handleProjectSlashClose : undefined
              }
              onKeyDownForDropdown={handleContextMenuKeyDown}
              onKeyDownForSlashDropdown={(event) =>
                slashCommandKeyboardHandlerRef.current?.(event) ?? false
              }
              onImageInsert={editable ? onImageInsert : undefined}
              minHeight={descriptionMinHeight}
              maxHeight={descriptionMaxHeight}
              editable={editable}
              toolbarMode={descriptionToolbarMode}
              toolbarClassName={
                descriptionToolbarMode === "inline"
                  ? RICH_MARKDOWN_COMPOSER_TOOLBAR_CLASS
                  : "work-item-toolbar"
              }
              toolbarSize="mini"
              toolbarDropdownPosition="top-start"
              className={`noDrag flex-1 cursor-text rounded-md text-text-1 ${descriptionClassName}`.trim()}
            />
            <ContextMenuPortal
              visible={showContextMenu}
              containerRef={editorContainerRef}
              onClose={handleAtMentionClose}
              onSelect={handleProjectAtSelect}
              searchQuery={atSearchQuery}
              inlineSearchOnEmpty
              keyboardOpened={contextMenuKeyboardOpened}
              repoPath={repoPath ?? undefined}
              keyboardHandlerRef={contextMenuKeyboardHandlerRef}
              placement={dropdownDirection}
            />
            <SlashCommandPortal
              visible={showSlashMenu}
              containerRef={editorContainerRef}
              placement={dropdownDirection}
              items={skillSlashItems}
              loading={slashLoading}
              currentMode={currentMode}
              searchQuery={slashQuery}
              onClose={handleProjectSlashClose}
              onSelect={handleProjectSlashSelect}
              onModeSelect={handleModeSelect}
              keyboardHandlerRef={slashCommandKeyboardHandlerRef}
              searchMode={slashOpenedFromToolbar ? "header" : "inline"}
              onSearchQueryChange={setSlashQuery}
              showActionFlyouts={slashOpenedFromToolbar}
              showModeRows={false}
            />
          </div>
        )}
      </div>
    );
  }
);

ProjectContentEditor.displayName = "ProjectContentEditor";

export default ProjectContentEditor;
