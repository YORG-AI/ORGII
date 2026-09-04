import React, {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import type { PillIconType } from "@src/components/ComposerInput/types";
import { serializePillNode } from "@src/components/ComposerInput/utils";
import "@src/components/MarkdownFormattingToolbar/index.scss";
import Textarea from "@src/components/Textarea";
import {
  CodeXmlIcon,
  Heading02Icon,
  HugeiconsIcon,
  LeftToRightListNumberIcon,
  Link01Icon,
  ListChecksIcon,
  ListIcon,
  QuoteIcon,
  TextBoldIcon,
  TextItalicIcon,
  TextStrikethroughIcon,
} from "@src/icons";
import { MarkdownContent } from "@src/modules/shared/components/MarkdownContent";

import MarkdownEditorModeSwitch, {
  type MarkdownEditorMode,
} from "./ModeSwitch";
import {
  type MarkdownTextareaEdit,
  type MarkdownTextareaFormat,
  formatMarkdownTextareaSelection,
  insertMarkdownTextareaText,
  markdownTextareaToPlainText,
} from "./formatting";

export { default as MarkdownEditorModeSwitch } from "./ModeSwitch";
export type { MarkdownEditorMode } from "./ModeSwitch";

const TOOLBAR_ICON_SIZE = 14;
const COMPACT_TOOLBAR_CLASS = "min-h-0! border-b-0! pb-0.5! [&_svg]:size-3.5";
const DROPDOWN_KEYS = ["ArrowUp", "ArrowDown", "Enter", "Tab", "Escape"];

type InlineTrigger = {
  kind: "mention" | "slash";
  start: number;
  hasTriggerCharacter: boolean;
};

interface MarkdownTextareaInsertOptions {
  separateFromAdjacentText?: boolean;
  clientX?: number;
  clientY?: number;
}

export interface MarkdownTextareaEditorRef {
  focus: () => void;
  getText: () => string;
  getMarkdown: () => string;
  setContent: (content: string) => void;
  clear: () => void;
  isEmpty: () => boolean;
  insertImage: (src: string, alt?: string) => void;
  insertText: (text: string, options?: MarkdownTextareaInsertOptions) => void;
  insertFilePill: (
    filePath: string,
    isFolder?: boolean,
    iconType?: PillIconType,
    displayName?: string
  ) => void;
  triggerAtMention: () => void;
  consumeMentionQuery: () => void;
}

interface MarkdownTextareaEditorProps {
  value: string;
  onChange: (markdown: string, plainText: string) => void;
  placeholder?: string;
  minHeight?: number | string;
  /**
   * Rows the autosize floor reserves. The floor is applied as an explicit
   * height, so it wins over `minHeight` whenever it is taller — a composer
   * that wants `minHeight` to govern passes a smaller value.
   */
  minRows?: number;
  maxHeight?: number | string;
  maxLength?: number;
  disabled?: boolean;
  editable?: boolean;
  autoFocus?: boolean;
  appearance?: "plain" | "outlined";
  onSubmit?: () => void;
  onImageInsert?: (files: File[]) => void;
  onAtMention?: (
    query: string,
    cursorPosition: { x: number; y: number }
  ) => void;
  onAtMentionClose?: () => void;
  onSlashCommand?: (query: string) => void;
  onSlashCommandClose?: () => void;
  onKeyDownForDropdown?: (event: KeyboardEvent) => boolean;
  onKeyDownForSlashDropdown?: (event: KeyboardEvent) => boolean;
  dataTestId?: string;
  className?: string;
  mode?: MarkdownEditorMode;
  onModeChange?: (mode: MarkdownEditorMode) => void;
}

interface ToolbarAction {
  format: MarkdownTextareaFormat;
  label: string;
  icon: React.ReactNode;
}

function cursorPosition(textarea: HTMLTextAreaElement): {
  x: number;
  y: number;
} {
  const rect = textarea.getBoundingClientRect();
  return { x: rect.left + 8, y: rect.bottom };
}

function textOffsetAtPoint(
  textarea: HTMLTextAreaElement,
  clientX?: number,
  clientY?: number
): number | null {
  if (clientX === undefined || clientY === undefined) return null;
  const ownerDocument = textarea.ownerDocument as Document & {
    caretPositionFromPoint?: (
      x: number,
      y: number
    ) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const position = ownerDocument.caretPositionFromPoint?.(clientX, clientY);
  if (position?.offsetNode === textarea) return position.offset;
  const range = ownerDocument.caretRangeFromPoint?.(clientX, clientY);
  if (range?.startContainer === textarea) return range.startOffset;
  return null;
}

/**
 * Markdown source editor shared by comments, issues, PRs, and project
 * descriptions. Write uses one native textarea; Preview mounts the existing
 * lazy Markdown renderer only on demand.
 */
const MarkdownTextareaEditor = forwardRef<
  MarkdownTextareaEditorRef,
  MarkdownTextareaEditorProps
>(function MarkdownTextareaEditor(
  {
    value,
    onChange,
    placeholder,
    minHeight = 72,
    minRows = 3,
    maxHeight = 240,
    maxLength,
    disabled = false,
    editable = true,
    autoFocus = false,
    appearance = "plain",
    onSubmit,
    onImageInsert,
    onAtMention,
    onAtMentionClose,
    onSlashCommand,
    onSlashCommandClose,
    onKeyDownForDropdown,
    onKeyDownForSlashDropdown,
    dataTestId,
    className = "",
    mode: controlledMode,
    onModeChange,
  },
  ref
) {
  const { t } = useTranslation("sessions");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const valueRef = useRef(value);
  const [internalMode, setInternalMode] = useState<MarkdownEditorMode>("write");
  const pendingSelectionRef = useRef<{ start: number; end: number } | null>(
    null
  );
  const inlineTriggerRef = useRef<InlineTrigger | null>(null);
  const canWrite = editable && !disabled;
  const mode = controlledMode ?? internalMode;
  const activeMode = canWrite ? mode : "preview";

  const setMode = useCallback(
    (nextMode: MarkdownEditorMode) => {
      if (controlledMode === undefined) setInternalMode(nextMode);
      onModeChange?.(nextMode);
    },
    [controlledMode, onModeChange]
  );

  const emitChange = useCallback(
    (nextValue: string) => {
      if (maxLength !== undefined && nextValue.length > maxLength) return false;
      valueRef.current = nextValue;
      onChange(nextValue, markdownTextareaToPlainText(nextValue));
      return true;
    },
    [maxLength, onChange]
  );

  const closeInlineTrigger = useCallback(() => {
    const trigger = inlineTriggerRef.current;
    inlineTriggerRef.current = null;
    if (trigger?.kind === "mention") onAtMentionClose?.();
    if (trigger?.kind === "slash") onSlashCommandClose?.();
  }, [onAtMentionClose, onSlashCommandClose]);

  const setInlineTrigger = useCallback(
    (nextTrigger: InlineTrigger) => {
      const previousTrigger = inlineTriggerRef.current;
      if (previousTrigger && previousTrigger.kind !== nextTrigger.kind) {
        if (previousTrigger.kind === "mention") onAtMentionClose?.();
        if (previousTrigger.kind === "slash") onSlashCommandClose?.();
      }
      inlineTriggerRef.current = nextTrigger;
    },
    [onAtMentionClose, onSlashCommandClose]
  );

  const insertEdit = useCallback(
    (edit: MarkdownTextareaEdit) => {
      if (!emitChange(edit.value)) return;
      pendingSelectionRef.current = {
        start: edit.selectionStart,
        end: edit.selectionEnd,
      };
      closeInlineTrigger();
    },
    [closeInlineTrigger, emitChange]
  );

  const insertText = useCallback(
    (text: string, options?: MarkdownTextareaInsertOptions) => {
      if (!text || !canWrite) return;
      const textarea = textareaRef.current;
      const fallbackEnd = textarea?.selectionEnd ?? valueRef.current.length;
      const pointOffset = textarea
        ? textOffsetAtPoint(textarea, options?.clientX, options?.clientY)
        : null;
      const insertionOffset = pointOffset ?? fallbackEnd;
      insertEdit(
        insertMarkdownTextareaText(
          {
            value: valueRef.current,
            start: insertionOffset,
            end: insertionOffset,
          },
          text,
          options?.separateFromAdjacentText
        )
      );
    },
    [canWrite, insertEdit]
  );

  const focus = useCallback(() => {
    if (!canWrite) return;
    if (activeMode === "preview") {
      pendingSelectionRef.current = {
        start: valueRef.current.length,
        end: valueRef.current.length,
      };
      setMode("write");
      return;
    }
    textareaRef.current?.focus();
  }, [activeMode, canWrite, setMode]);

  const openInlineTrigger = useCallback(
    (kind: InlineTrigger["kind"], hasTriggerCharacter = false) => {
      if (!canWrite) return;
      if (activeMode === "preview") setMode("write");
      const textarea = textareaRef.current;
      const start = textarea?.selectionEnd ?? valueRef.current.length;
      setInlineTrigger({ kind, start, hasTriggerCharacter });
      if (kind === "mention") {
        onAtMention?.("", textarea ? cursorPosition(textarea) : { x: 0, y: 0 });
      } else {
        onSlashCommand?.("");
      }
      textarea?.focus();
    },
    [
      activeMode,
      canWrite,
      onAtMention,
      onSlashCommand,
      setInlineTrigger,
      setMode,
    ]
  );

  useImperativeHandle(
    ref,
    () => ({
      focus,
      getText: () => markdownTextareaToPlainText(valueRef.current),
      getMarkdown: () => valueRef.current,
      setContent: (content) => {
        if (emitChange(content)) {
          pendingSelectionRef.current = {
            start: content.length,
            end: content.length,
          };
        }
      },
      clear: () => {
        if (emitChange("")) pendingSelectionRef.current = { start: 0, end: 0 };
      },
      isEmpty: () => valueRef.current.trim().length === 0,
      insertImage: (src, alt = "image") =>
        insertText(`![${alt.replace(/[[\]]/g, "")}](${src})`, {
          separateFromAdjacentText: true,
        }),
      insertText,
      insertFilePill: (filePath, isFolder = false, iconType, displayName) => {
        const trigger = inlineTriggerRef.current;
        const textarea = textareaRef.current;
        let insertionOffset = textarea?.selectionEnd ?? valueRef.current.length;
        if (trigger) {
          const cursor = textarea?.selectionEnd ?? valueRef.current.length;
          const from = trigger.hasTriggerCharacter
            ? Math.max(0, trigger.start - 1)
            : trigger.start;
          valueRef.current = `${valueRef.current.slice(0, from)}${valueRef.current.slice(cursor)}`;
          insertionOffset = from;
        }
        const resolvedIconType = iconType ?? (isFolder ? "folder" : "file");
        insertEdit(
          insertMarkdownTextareaText(
            {
              value: valueRef.current,
              start: insertionOffset,
              end: insertionOffset,
            },
            serializePillNode({
              filePath,
              fileName: displayName || filePath.split("/").pop() || filePath,
              iconType: resolvedIconType,
            }),
            true
          )
        );
      },
      triggerAtMention: () => openInlineTrigger("mention"),
      consumeMentionQuery: () => {
        const trigger = inlineTriggerRef.current;
        if (!trigger || trigger.kind !== "mention") return;
        const textarea = textareaRef.current;
        const cursor = textarea?.selectionEnd ?? valueRef.current.length;
        const from = trigger.hasTriggerCharacter
          ? Math.max(0, trigger.start - 1)
          : trigger.start;
        insertEdit({
          value: `${valueRef.current.slice(0, from)}${valueRef.current.slice(cursor)}`,
          selectionStart: from,
          selectionEnd: from,
        });
      },
    }),
    [emitChange, focus, insertEdit, insertText, openInlineTrigger]
  );

  useLayoutEffect(() => {
    valueRef.current = value;
  }, [value]);

  useLayoutEffect(() => {
    const pendingSelection = pendingSelectionRef.current;
    const textarea = textareaRef.current;
    if (activeMode !== "write" || !pendingSelection || !textarea) return;
    pendingSelectionRef.current = null;
    textarea.focus();
    textarea.setSelectionRange(pendingSelection.start, pendingSelection.end);
  }, [activeMode, value]);

  const selectMode = useCallback(
    (nextMode: MarkdownEditorMode) => {
      if (!canWrite || nextMode === mode) return;
      if (nextMode === "preview") {
        const textarea = textareaRef.current;
        if (textarea) {
          pendingSelectionRef.current = {
            start: textarea.selectionStart,
            end: textarea.selectionEnd,
          };
        }
        closeInlineTrigger();
      }
      setMode(nextMode);
    },
    [canWrite, closeInlineTrigger, mode, setMode]
  );

  const applyFormat = useCallback(
    (format: MarkdownTextareaFormat) => {
      const textarea = textareaRef.current;
      if (!textarea || !canWrite) return;
      insertEdit(
        formatMarkdownTextareaSelection(
          {
            value: textarea.value,
            start: textarea.selectionStart,
            end: textarea.selectionEnd,
          },
          format
        )
      );
    },
    [canWrite, insertEdit]
  );

  const updateInlineTrigger = useCallback(
    (nextValue: string, textarea: HTMLTextAreaElement) => {
      const trigger = inlineTriggerRef.current;
      if (!trigger) return;
      const cursor = textarea.selectionStart;
      const query = nextValue.slice(trigger.start, cursor);
      if (cursor < trigger.start || /\s/u.test(query)) {
        closeInlineTrigger();
        return;
      }
      if (trigger.kind === "mention") {
        onAtMention?.(query, cursorPosition(textarea));
      } else {
        onSlashCommand?.(query);
      }
    },
    [closeInlineTrigger, onAtMention, onSlashCommand]
  );

  const actions: ToolbarAction[] = [
    {
      format: "heading",
      label: t("creator.toolbar.heading2"),
      icon: (
        <HugeiconsIcon
          icon={Heading02Icon}
          data-icon="heading-2"
          size={TOOLBAR_ICON_SIZE}
        />
      ),
    },
    {
      format: "bold",
      label: t("creator.toolbar.bold"),
      icon: (
        <HugeiconsIcon
          icon={TextBoldIcon}
          data-icon="bold"
          size={TOOLBAR_ICON_SIZE}
        />
      ),
    },
    {
      format: "italic",
      label: t("creator.toolbar.italic"),
      icon: (
        <HugeiconsIcon
          icon={TextItalicIcon}
          data-icon="italic"
          size={TOOLBAR_ICON_SIZE}
        />
      ),
    },
    {
      format: "strikethrough",
      label: t("creator.toolbar.strikethrough"),
      icon: (
        <HugeiconsIcon
          icon={TextStrikethroughIcon}
          data-icon="strikethrough"
          size={TOOLBAR_ICON_SIZE}
        />
      ),
    },
    {
      format: "inlineCode",
      label: t("creator.toolbar.inlineCode"),
      icon: (
        <HugeiconsIcon
          icon={CodeXmlIcon}
          data-icon="code"
          size={TOOLBAR_ICON_SIZE}
        />
      ),
    },
    {
      format: "link",
      label: t("creator.toolbar.link"),
      icon: (
        <HugeiconsIcon
          icon={Link01Icon}
          data-icon="link-icon"
          size={TOOLBAR_ICON_SIZE}
        />
      ),
    },
    {
      format: "quote",
      label: t("creator.toolbar.quote"),
      icon: (
        <HugeiconsIcon
          icon={QuoteIcon}
          data-icon="quote"
          size={TOOLBAR_ICON_SIZE}
        />
      ),
    },
    {
      format: "bulletList",
      label: t("creator.toolbar.bulletList"),
      icon: (
        <HugeiconsIcon
          icon={ListIcon}
          data-icon="list"
          size={TOOLBAR_ICON_SIZE}
        />
      ),
    },
    {
      format: "numberedList",
      label: t("creator.toolbar.numberedList"),
      icon: (
        <HugeiconsIcon
          icon={LeftToRightListNumberIcon}
          data-icon="list-ordered"
          size={TOOLBAR_ICON_SIZE}
        />
      ),
    },
    {
      format: "taskList",
      label: t("creator.toolbar.taskList"),
      icon: (
        <HugeiconsIcon
          icon={ListChecksIcon}
          data-icon="list-checks"
          size={TOOLBAR_ICON_SIZE}
        />
      ),
    },
  ];

  const surfaceClassName =
    appearance === "outlined"
      ? "composer-surface-shadow relative rounded-md border border-border-2 bg-primary-container"
      : "";

  return (
    <div
      className={`flex min-h-0 min-w-0 flex-col ${surfaceClassName} ${className}`.trim()}
      data-testid={dataTestId}
      data-markdown-textarea-editor
    >
      {activeMode === "write" ? (
        <div className="flex min-h-0 flex-col">
          <div
            className={`markdown-formatting-toolbar ${COMPACT_TOOLBAR_CLASS}`}
            role="toolbar"
            aria-label={t("creator.toolbar.formatting", "Text formatting")}
            data-testid={dataTestId ? `${dataTestId}-toolbar` : undefined}
            onMouseDown={(event) => event.preventDefault()}
          >
            {actions.map(({ format, label, icon }) => (
              <button
                key={format}
                type="button"
                className="toolbar-btn"
                title={label}
                aria-label={label}
                disabled={!canWrite}
                data-markdown-format={format}
                onClick={() => applyFormat(format)}
              >
                {icon}
              </button>
            ))}
          </div>
          <Textarea
            ref={textareaRef}
            value={value}
            onChange={(nextValue, event) => {
              emitChange(nextValue);
              updateInlineTrigger(nextValue, event.currentTarget);
            }}
            placeholder={placeholder}
            size="small"
            appearance="bare"
            autoSize={{ minRows, maxRows: 10 }}
            rows={minRows}
            maxLength={maxLength}
            disabled={!canWrite}
            autoFocus={autoFocus}
            spellCheck
            textareaStyle={{ minHeight, maxHeight, overflowY: "auto" }}
            data-testid={dataTestId ? `${dataTestId}-textarea` : undefined}
            onPaste={(event) => {
              if (!onImageInsert) return;
              const files = Array.from(event.clipboardData.items)
                .filter((item) => item.type.startsWith("image/"))
                .map((item) => item.getAsFile())
                .filter((file): file is File => file !== null);
              if (files.length === 0) return;
              event.preventDefault();
              onImageInsert(files);
            }}
            onDrop={(event) => {
              if (!onImageInsert) return;
              const files = Array.from(event.dataTransfer.files).filter(
                (file) => file.type.startsWith("image/")
              );
              if (files.length === 0) return;
              event.preventDefault();
              onImageInsert(files);
            }}
            onKeyDown={(event) => {
              const trigger = inlineTriggerRef.current;
              if (trigger && DROPDOWN_KEYS.includes(event.key)) {
                const handled =
                  trigger.kind === "mention"
                    ? onKeyDownForDropdown?.(event.nativeEvent)
                    : onKeyDownForSlashDropdown?.(event.nativeEvent);
                if (handled) {
                  event.preventDefault();
                  return;
                }
              }
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                onSubmit?.();
                return;
              }
              if (event.key === "Escape" && trigger) {
                event.preventDefault();
                closeInlineTrigger();
                return;
              }
              if (event.key === "@" && onAtMention) {
                setInlineTrigger({
                  kind: "mention",
                  start: event.currentTarget.selectionStart + 1,
                  hasTriggerCharacter: true,
                });
                onAtMention("", cursorPosition(event.currentTarget));
              } else if (
                event.key === "/" &&
                onSlashCommand &&
                (event.currentTarget.selectionStart === 0 ||
                  /\s/u.test(
                    value.charAt(event.currentTarget.selectionStart - 1)
                  ))
              ) {
                setInlineTrigger({
                  kind: "slash",
                  start: event.currentTarget.selectionStart + 1,
                  hasTriggerCharacter: true,
                });
                onSlashCommand("");
              }
              if (!(event.metaKey || event.ctrlKey)) return;
              const shortcutFormat =
                event.key.toLowerCase() === "b"
                  ? "bold"
                  : event.key.toLowerCase() === "i"
                    ? "italic"
                    : null;
              if (!shortcutFormat) return;
              event.preventDefault();
              applyFormat(shortcutFormat);
            }}
          />
        </div>
      ) : (
        <div className="flex min-h-0 flex-col">
          <div
            className="min-h-0 overflow-y-auto px-2 py-2"
            style={{ minHeight, maxHeight }}
            role="region"
            aria-label={t("common:common.preview", "Preview")}
            data-testid={dataTestId ? `${dataTestId}-preview` : undefined}
            data-markdown-preview
          >
            <MarkdownContent
              body={value}
              emptyText={t(
                "common:common.nothingToPreview",
                "Nothing to preview"
              )}
              clamped={false}
            />
          </div>
        </div>
      )}
      {canWrite && controlledMode === undefined ? (
        <div className="flex min-h-8 items-center px-1.5 py-1">
          <MarkdownEditorModeSwitch
            mode={mode}
            onModeChange={selectMode}
            dataTestId={dataTestId ? `${dataTestId}-mode-switch` : undefined}
          />
        </div>
      ) : null}
    </div>
  );
});

MarkdownTextareaEditor.displayName = "MarkdownTextareaEditor";

export default MarkdownTextareaEditor;
