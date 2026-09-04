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
} from "react";
import { useTranslation } from "react-i18next";

import type { PillIconType } from "@src/components/ComposerInput";
import Input from "@src/components/Input";
import { GHOST_INPUT_PLACEHOLDER_CLASS } from "@src/components/Input/tokens";
import ContextMenuPortal from "@src/engines/ChatPanel/InputArea/components/ContextMenuPortal";
import SlashCommandPortal from "@src/engines/ChatPanel/InputArea/components/SlashCommandPortal";
import { useComposerInput } from "@src/hooks/input";
import MarkdownTextareaEditor, {
  type MarkdownEditorMode,
  type MarkdownTextareaEditorRef,
} from "@src/modules/shared/components/MarkdownTextareaEditor";
import type { SlashItem } from "@src/types/extensions";

export interface ProjectContentEditorRef {
  getMarkdown: () => string;
  insertImage: (src: string, alt?: string) => void;
  insertFilePill: (filePath: string, displayName?: string) => void;
  triggerAtMention: () => void;
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
  autoFocusDescription?: boolean;
  editable?: boolean;
  className?: string;
  titleVisible?: boolean;
  separatorVisible?: boolean;
  descriptionVisible?: boolean;
  titleActions?: ReactNode;
  metaContent?: ReactNode;
  descriptionClassName?: string;
  descriptionMode?: MarkdownEditorMode;
  onDescriptionModeChange?: (mode: MarkdownEditorMode) => void;
  descriptionMinHeight?: number;
  descriptionMinRows?: number;
  descriptionMaxHeight?: number | string;
  repoPath?: string | null;
  dataTestId?: string;
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
      autoFocusDescription = false,
      editable = true,
      className = "",
      titleVisible = true,
      separatorVisible = true,
      descriptionVisible = true,
      titleActions,
      metaContent,
      descriptionClassName = "",
      descriptionMode,
      onDescriptionModeChange,
      descriptionMinHeight = 200,
      descriptionMinRows,
      descriptionMaxHeight,
      repoPath,
      dataTestId,
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
    const editorRef = useRef<MarkdownTextareaEditorRef>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const descriptionValueRef = useRef(initialDescription);
    const contextMenuKeyboardHandlerRef = useRef<
      ((event: ReactKeyboardEvent) => boolean) | null
    >(null);

    const {
      showContextMenu,
      atSearchQuery,
      handleAtMention,
      handleAtMentionClose,
      showSlashMenu,
      slashQuery,
      slashCommandKeyboardHandlerRef,
      handleSlashCommand,
      handleSlashCommandClose,
      handleModeSelect,
      currentMode,
      includeProjectMode,
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
      getMarkdown: getSerializedDescription,
      insertImage: (src: string, alt?: string) =>
        editorRef.current?.insertImage(src, alt),
      insertFilePill: (filePath: string, displayName?: string) => {
        editorRef.current?.insertFilePill(filePath, false, "file", displayName);
      },
      triggerAtMention: () => editorRef.current?.triggerAtMention(),
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
          if (target.closest("textarea, button")) {
            return;
          }
        }
        editorRef.current?.focus();
      },
      [editorRef]
    );

    const handleProjectContextMenuClose = useCallback(() => {
      handleAtMentionClose();
    }, [handleAtMentionClose]);

    const handleProjectAtMention = useCallback(
      (query: string, position: { x: number; y: number }) => {
        handleAtMention(query, position);
      },
      [handleAtMention]
    );

    const handleProjectFilesSelected = useCallback(
      (event: React.ChangeEvent<HTMLInputElement>) => {
        for (const file of Array.from(event.target.files ?? [])) {
          editorRef.current?.insertFilePill(
            file.name,
            false,
            "file",
            file.name
          );
        }
        event.target.value = "";
      },
      []
    );

    const handleProjectContextModeSelect = useCallback(
      (mode: Parameters<typeof handleModeSelect>[0]) => {
        handleModeSelect(mode);
        editorRef.current?.consumeMentionQuery();
        handleProjectContextMenuClose();
      },
      [handleModeSelect, handleProjectContextMenuClose]
    );
    const handleProjectContextImageUpload = useCallback(() => {
      editorRef.current?.consumeMentionQuery();
      fileInputRef.current?.click();
    }, []);

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
        handleProjectContextMenuClose();
      },
      [handleProjectContextMenuClose]
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

    const handleProjectSlashSelect = useCallback(
      (item: SlashItem) => {
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
        handleSlashCommandClose();
      },
      [handleSlashCommandClose]
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

        {metaContent && <div className="mt-3 mb-4 w-full">{metaContent}</div>}

        {separatorVisible && (
          <div className="mt-2 mb-4 w-full border-t border-border-2" />
        )}

        {descriptionVisible && (
          <div
            ref={editorContainerRef}
            className={`${descriptionMaxHeight ? "min-h-0 flex-1" : "min-h-[200px]"} w-full min-w-0 cursor-text`}
            onClick={handleDescriptionContainerClick}
          >
            <MarkdownTextareaEditor
              ref={editorRef}
              value={initialDescription}
              onChange={handleDescriptionChange}
              placeholder={descriptionPlaceholder}
              onAtMention={editable ? handleProjectAtMention : undefined}
              onAtMentionClose={
                editable ? handleProjectContextMenuClose : undefined
              }
              onSlashCommand={editable ? handleSlashCommand : undefined}
              onSlashCommandClose={
                editable ? handleSlashCommandClose : undefined
              }
              onKeyDownForDropdown={handleContextMenuKeyDown}
              onKeyDownForSlashDropdown={(event) =>
                slashCommandKeyboardHandlerRef.current?.(event) ?? false
              }
              onImageInsert={editable ? onImageInsert : undefined}
              autoFocus={autoFocusDescription}
              minHeight={descriptionMinHeight}
              minRows={descriptionMinRows}
              maxHeight={descriptionMaxHeight}
              editable={editable}
              mode={descriptionMode}
              onModeChange={onDescriptionModeChange}
              className={`noDrag flex-1 cursor-text rounded-md text-text-1 ${descriptionClassName}`.trim()}
            />
            <ContextMenuPortal
              visible={showContextMenu}
              containerRef={editorContainerRef}
              onClose={handleProjectContextMenuClose}
              onSelect={handleProjectAtSelect}
              onImageUpload={handleProjectContextImageUpload}
              currentMode={currentMode}
              onModeSelect={handleProjectContextModeSelect}
              includeProjectMode={includeProjectMode}
              searchQuery={atSearchQuery}
              repoPath={repoPath ?? undefined}
              keyboardHandlerRef={contextMenuKeyboardHandlerRef}
            />
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={handleProjectFilesSelected}
              tabIndex={-1}
              aria-hidden
            />
            <SlashCommandPortal
              visible={showSlashMenu}
              containerRef={editorContainerRef}
              items={skillSlashItems}
              loading={slashLoading}
              searchQuery={slashQuery}
              onClose={handleSlashCommandClose}
              onSelect={handleProjectSlashSelect}
              keyboardHandlerRef={slashCommandKeyboardHandlerRef}
            />
          </div>
        )}
      </div>
    );
  }
);

ProjectContentEditor.displayName = "ProjectContentEditor";

export default ProjectContentEditor;
