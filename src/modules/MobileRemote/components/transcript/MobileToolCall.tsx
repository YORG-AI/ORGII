import React, { Suspense, lazy, useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import BottomSheet from "@src/components/BottomSheet";
import Button from "@src/components/Button";
import FileTypeIcon from "@src/components/FileTypeIcon";
import { Placeholder } from "@src/components/Placeholder";
import { getToolIcon } from "@src/config/toolIcons";
import { EventBlockHeader } from "@src/engines/ChatPanel/blocks/primitives/EventBlockHeader";
import {
  EventBlockHeaderInfo,
  EventBlockHeaderSubtitle,
  EventBlockHeaderTitle,
} from "@src/engines/ChatPanel/blocks/primitives/EventBlockHeaderTextSlots";
import { SESSION_UI_TOKENS } from "@src/engines/ChatPanel/blocks/primitives/config";
import {
  ArrowRight01Icon,
  HugeiconsIcon,
  SquareArrowUpRight02Icon,
} from "@src/icons";
import { formatToolName } from "@src/util/ui/rendering/formatToolName";

import type {
  MobileToolData,
  TranscriptItem,
} from "../../lib/transcriptReducer";
import { type MobileFileTarget, mobileFileTargets } from "./mobileFileTool";

const MobileFilePreview = lazy(
  () =>
    import(/* webpackChunkName: "mobile-file-preview" */ "./MobileFilePreview")
);

type ToolLifecycle = "running" | "done" | "failed";

const TOOL_LABEL_KEYS: Record<string, string> = {
  read_file: "readFile",
  edit_file: "editFile",
  edit_file_by_replace: "editFile",
  apply_patch: "editFile",
  write_file: "editFile",
  delete_file: "deleteFile",
  run_shell: "runCommand",
  run_command_line: "runCommand",
  shell: "runCommand",
  code_search: "searchCode",
  grep: "searchCode",
  glob_file_search: "findFiles",
  find_files: "findFiles",
  list_dir: "listDirectory",
  web_search: "searchWeb",
  manage_todo: "updateTodos",
  subagent: "delegateTask",
  agent: "delegateTask",
  task_create: "manageTask",
  task_update: "manageTask",
  task_list: "manageTask",
  task_get: "manageTask",
  await_output: "waitForOutput",
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export function normalizeMobileToolLifecycle(status?: string): ToolLifecycle {
  const normalized = status?.toLowerCase() ?? "";
  if (
    normalized.includes("fail") ||
    normalized.includes("error") ||
    normalized.includes("cancel")
  ) {
    return "failed";
  }
  if (
    normalized.includes("running") ||
    normalized.includes("pending") ||
    normalized.includes("waiting") ||
    normalized.includes("streaming")
  ) {
    return "running";
  }
  return "done";
}

function toolKind(data?: MobileToolData): string {
  return stringValue(data?.kind);
}

function summaryFromToolData(data?: MobileToolData): string {
  const payload = record(data);
  if (!payload) return "";
  const kind = toolKind(data);
  const keysByKind: Record<string, string[]> = {
    file: ["filePath", "fileName"],
    edit: ["filePath", "fileName"],
    deleteFile: ["filePath", "fileName"],
    shell: ["command", "description", "cwd"],
    search: ["query"],
    glob: ["pattern"],
    listDir: ["directory"],
    webSearch: ["query"],
    subagent: ["description", "subagentType"],
    orgTask: ["action"],
    await: ["handle"],
    message: ["content"],
  };
  const keys = keysByKind[kind] ?? [
    "filePath",
    "command",
    "query",
    "pattern",
    "directory",
    "description",
    "action",
  ];
  return keys.map((key) => stringValue(payload[key])).find(Boolean) ?? "";
}

export function mobileToolSummary(item: TranscriptItem): string {
  const projected = item.toolSummary?.trim();
  if (projected) return projected;
  const structured = summaryFromToolData(item.toolData);
  if (structured) return structured;
  if (item.toolFilePath?.trim()) return item.toolFilePath.trim();
  if (item.toolCommand?.trim()) return item.toolCommand.trim();
  const fallback = item.text.trim();
  return fallback !== item.toolName ? fallback : "";
}

function outputFromToolData(data?: MobileToolData): string {
  const payload = record(data);
  if (!payload) return "";
  const kind = toolKind(data);

  if (kind === "shell") {
    return (
      stringValue(payload.output) ||
      stringValue(payload.streamOutput) ||
      stringValue(payload.errorMessage)
    );
  }
  if (kind === "file") return stringValue(payload.content);
  if (kind === "edit") {
    return stringValue(payload.diff) || stringValue(payload.content);
  }
  if (kind === "await") return stringValue(payload.resultText);
  if (kind === "message") return stringValue(payload.content);
  if (kind === "subagent") {
    return (
      stringValue(payload.errorMessage) ||
      stringValue(payload.resultSummary) ||
      stringValue(payload.resultContent)
    );
  }
  if (kind === "orgTask") {
    return stringValue(payload.errorMessage) || stringValue(payload.guidance);
  }

  if (kind === "search" && Array.isArray(payload.results)) {
    return payload.results
      .map((entry) => {
        const match = record(entry);
        if (!match) return "";
        const file = stringValue(match.file);
        const line = numberValue(match.line);
        const content = stringValue(match.content);
        return `${file}${line == null ? "" : `:${line}`}${content ? `  ${content}` : ""}`;
      })
      .filter(Boolean)
      .join("\n");
  }
  if (kind === "glob" && Array.isArray(payload.files)) {
    return payload.files.map(stringValue).filter(Boolean).join("\n");
  }
  if (kind === "listDir" && Array.isArray(payload.entries)) {
    return payload.entries
      .map((entry) => {
        const row = record(entry);
        if (!row) return "";
        const name = stringValue(row.name);
        return row.isDirectory === true ? `${name}/` : name;
      })
      .filter(Boolean)
      .join("\n");
  }
  if (kind === "webSearch" && Array.isArray(payload.results)) {
    return payload.results
      .map((entry) => stringValue(record(entry)?.title))
      .filter(Boolean)
      .join("\n");
  }
  if (kind === "todo" && Array.isArray(payload.todos)) {
    return payload.todos
      .map((entry) => {
        const todo = record(entry);
        if (!todo) return "";
        const content = stringValue(todo.content);
        const status = stringValue(todo.status);
        return content ? `${status ? `[${status}] ` : ""}${content}` : "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function compactMetadata(data?: MobileToolData): Record<string, unknown> {
  const payload = record(data);
  if (!payload) return {};
  const hidden = new Set([
    "content",
    "diff",
    "output",
    "streamOutput",
    "resultContent",
    "resultSummary",
    "errorMessage",
    "results",
    "files",
    "entries",
    "todos",
    "tasks",
    "fileName",
    "filePath",
    "language",
    "lineCount",
    "startLine",
    "oldContent",
    "newContent",
    "oldStartLine",
    "newStartLine",
    "linesAdded",
    "linesRemoved",
    "isDeleted",
    "applyPatchSegments",
  ]);
  return Object.fromEntries(
    Object.entries(payload).filter(
      ([key, value]) => key !== "kind" && !hidden.has(key) && value != null
    )
  );
}

function toolLabelKey(item: TranscriptItem): string | undefined {
  const name = (item.toolCanonical || item.toolName || "").toLowerCase();
  const exact = TOOL_LABEL_KEYS[name];
  if (exact) return exact;
  const kind = toolKind(item.toolData);
  const byKind: Record<string, string> = {
    file: "readFile",
    edit: "editFile",
    deleteFile: "deleteFile",
    shell: "runCommand",
    search: "searchCode",
    glob: "findFiles",
    listDir: "listDirectory",
    webSearch: "searchWeb",
    todo: "updateTodos",
    subagent: "delegateTask",
    orgTask: "manageTask",
    await: "waitForOutput",
  };
  return byKind[kind];
}

interface MobileToolCallProps {
  item: TranscriptItem;
  onOpenDetails?: () => void;
  detailsOpen?: boolean;
}

function useMobileToolPresentation(item: TranscriptItem) {
  const { t } = useTranslation("mobileRemote");
  const lifecycle = normalizeMobileToolLifecycle(item.toolStatus);
  const labelKey = toolLabelKey(item);
  const rawName = item.toolName || item.toolCanonical || "tool";
  const title = labelKey
    ? t(`transcript.tools.labels.${labelKey}`)
    : formatToolName(rawName);
  const summary = mobileToolSummary(item);
  const output = outputFromToolData(item.toolData);
  const fileTargets = mobileFileTargets(item);
  const metadata = compactMetadata(item.toolData);
  const metadataText =
    Object.keys(metadata).length > 0 ? JSON.stringify(metadata, null, 2) : "";
  const hasDetails = Boolean(
    fileTargets.length > 0 || output || metadataText || item.toolDataTruncated
  );
  const statusLabel = t(`transcript.tools.status.${lifecycle}`);
  const iconClassName =
    lifecycle === "failed"
      ? "text-danger-6"
      : lifecycle === "running"
        ? "text-info-6"
        : "text-text-3";

  return {
    t,
    lifecycle,
    rawName,
    title,
    summary,
    output,
    fileTargets,
    metadataText,
    hasDetails,
    statusLabel,
    iconClassName,
  };
}

export function MobileToolCall({
  item,
  onOpenDetails,
  detailsOpen = false,
}: MobileToolCallProps) {
  const {
    t,
    lifecycle,
    rawName,
    title,
    summary,
    hasDetails,
    statusLabel,
    iconClassName,
  } = useMobileToolPresentation(item);

  const header = (
    <EventBlockHeader
      isCollapsed={!hasDetails}
      withHover={false}
      className="chat-block-title !h-7 !px-0"
      rightContent={
        hasDetails && onOpenDetails ? (
          <HugeiconsIcon
            icon={ArrowRight01Icon}
            size={SESSION_UI_TOKENS.ICON.SIZE_SM}
            className="text-text-3"
            aria-hidden="true"
          />
        ) : undefined
      }
    >
      <span aria-hidden="true" className="chat-block-icon shrink-0">
        {getToolIcon(rawName, {
          size: SESSION_UI_TOKENS.ICON.SIZE_SM,
          className: iconClassName,
        })}
      </span>
      <EventBlockHeaderTitle>{title}</EventBlockHeaderTitle>
      {summary ? (
        <EventBlockHeaderSubtitle
          className="chat-code-sm text-text-3"
          title={summary}
        >
          {summary}
        </EventBlockHeaderSubtitle>
      ) : null}
      <EventBlockHeaderInfo
        className={
          lifecycle === "failed"
            ? "text-danger-6"
            : lifecycle === "running"
              ? "text-info-6"
              : undefined
        }
      >
        {statusLabel}
      </EventBlockHeaderInfo>
    </EventBlockHeader>
  );

  if (!hasDetails || !onOpenDetails) {
    return (
      <div
        className="w-full min-w-0"
        data-tool-call-name={rawName}
        data-tool-call-layout="inline"
        data-tool-call-status={lifecycle}
      >
        {header}
      </div>
    );
  }

  return (
    <button
      type="button"
      className="block w-full min-w-0 border-0 bg-transparent p-0 text-left focus-visible:ring-2 focus-visible:ring-primary-6/30 focus-visible:outline-none"
      aria-haspopup="dialog"
      aria-expanded={detailsOpen}
      aria-label={t("transcript.tools.openDetails", { tool: title })}
      onClick={onOpenDetails}
      data-tool-call-name={rawName}
      data-tool-call-layout="inline"
      data-tool-call-status={lifecycle}
      data-tool-call-action="open-details"
    >
      {header}
    </button>
  );
}

MobileToolCall.displayName = "MobileToolCall";

export interface MobileToolDetailSheetProps {
  item: TranscriptItem;
  open: boolean;
  onClose: () => void;
  onOpenFile?: (target: MobileFileTarget) => Promise<void>;
}

type OpenFileState =
  | { phase: "idle" }
  | { phase: "opening"; targetIndex: number }
  | { phase: "requested"; targetIndex: number }
  | { phase: "failed"; targetIndex: number; message: string };

export function MobileToolDetailSheet({
  item,
  open,
  onClose,
  onOpenFile,
}: MobileToolDetailSheetProps) {
  const {
    t,
    lifecycle,
    rawName,
    title,
    summary,
    output,
    fileTargets,
    metadataText,
    statusLabel,
    iconClassName,
  } = useMobileToolPresentation(item);
  const [selectedTargetIndex, setSelectedTargetIndex] = useState(
    () => fileTargets[0]?.targetIndex ?? 0
  );
  const [openFileState, setOpenFileState] = useState<OpenFileState>({
    phase: "idle",
  });
  const openRequestRef = useRef(0);
  const selectedTarget =
    fileTargets.find((target) => target.targetIndex === selectedTargetIndex) ??
    fileTargets[0];
  const firstTargetIndex = fileTargets[0]?.targetIndex ?? 0;

  const handleClose = useCallback(() => {
    openRequestRef.current += 1;
    setSelectedTargetIndex(firstTargetIndex);
    setOpenFileState({ phase: "idle" });
    onClose();
  }, [firstTargetIndex, onClose]);

  const handleOpenFile = useCallback(
    async (target: MobileFileTarget) => {
      if (!onOpenFile || openFileState.phase === "opening") return;
      const requestId = ++openRequestRef.current;
      setSelectedTargetIndex(target.targetIndex);
      setOpenFileState({ phase: "opening", targetIndex: target.targetIndex });
      try {
        await onOpenFile(target);
        if (openRequestRef.current !== requestId) return;
        setOpenFileState({
          phase: "requested",
          targetIndex: target.targetIndex,
        });
      } catch (error) {
        if (openRequestRef.current !== requestId) return;
        setOpenFileState({
          phase: "failed",
          targetIndex: target.targetIndex,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [onOpenFile, openFileState.phase]
  );

  const renderOpenLabel = (target: MobileFileTarget) => {
    if (
      openFileState.phase === "requested" &&
      openFileState.targetIndex === target.targetIndex
    ) {
      return t("transcript.tools.fileOpenRequested");
    }
    return t("transcript.tools.openFile");
  };

  return (
    <BottomSheet
      open={open}
      onClose={handleClose}
      showCloseButton
      closeLabel={t("transcript.tools.closeDetails")}
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span aria-hidden="true" className="chat-block-icon shrink-0">
            {getToolIcon(rawName, {
              size: SESSION_UI_TOKENS.ICON.SIZE_MD,
              className: iconClassName,
            })}
          </span>
          <span className="min-w-0 truncate">{title}</span>
          <span
            className={`chat-block-xs shrink-0 font-normal ${
              lifecycle === "failed"
                ? "text-danger-6"
                : lifecycle === "running"
                  ? "text-info-6"
                  : "text-text-3"
            }`}
          >
            {statusLabel}
          </span>
        </span>
      }
      bodyClassName="!px-4 !pb-5"
    >
      <div data-mobile-tool-detail={item.id}>
        {summary ? (
          <p className="chat-block-content mb-4 leading-5 break-words text-text-2">
            {summary}
          </p>
        ) : null}
        {fileTargets.length > 0 ? (
          <section className="mb-4" data-mobile-file-targets="true">
            <div className={`${SESSION_UI_TOKENS.TEXT.LABEL_XS} mb-1.5`}>
              {t("transcript.tools.files")}
            </div>
            <div className="flex flex-col gap-2">
              {fileTargets.map((target) => {
                const selected =
                  target.targetIndex === selectedTarget?.targetIndex;
                const opening =
                  openFileState.phase === "opening" &&
                  openFileState.targetIndex === target.targetIndex;
                return (
                  <div
                    key={`${target.targetIndex}:${target.filePath}:${target.line ?? ""}`}
                    className={`flex min-w-0 items-center gap-2 rounded-lg border px-2.5 py-2 ${
                      selected
                        ? "border-primary-5 bg-fill-1"
                        : "border-border-2 bg-bg-2"
                    }`}
                    data-mobile-file-target={target.filePath}
                  >
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-2 border-0 bg-transparent p-0 text-left focus-visible:ring-2 focus-visible:ring-primary-6/30 focus-visible:outline-none"
                      onClick={() => setSelectedTargetIndex(target.targetIndex)}
                      aria-pressed={selected}
                    >
                      <FileTypeIcon fileName={target.fileName} size="small" />
                      <span className="min-w-0 flex-1">
                        <span className="chat-block-xs block truncate font-medium text-text-1">
                          {target.fileName}
                        </span>
                        <span
                          className="chat-code-sm block truncate text-text-3"
                          title={target.filePath}
                        >
                          {target.filePath}
                          {target.line ? `:${target.line}` : ""}
                        </span>
                      </span>
                    </button>
                    <Button
                      size="small"
                      variant="primary"
                      appearance="ghost"
                      icon={
                        <HugeiconsIcon
                          icon={SquareArrowUpRight02Icon}
                          size={SESSION_UI_TOKENS.ICON.SIZE_SM}
                        />
                      }
                      loading={opening}
                      disabled={!onOpenFile}
                      aria-label={t("transcript.tools.openFileNamed", {
                        file: target.fileName,
                      })}
                      onClick={() => void handleOpenFile(target)}
                      data-mobile-open-file={target.filePath}
                    >
                      {renderOpenLabel(target)}
                    </Button>
                  </div>
                );
              })}
            </div>
            {!onOpenFile ? (
              <p className="chat-block-xs mt-1.5 text-text-3">
                {t("transcript.tools.openFileUnavailable")}
              </p>
            ) : null}
            {openFileState.phase === "failed" ? (
              <p className="chat-block-xs mt-1.5 text-danger-6" role="alert">
                {t("transcript.tools.openFileFailed", {
                  message: openFileState.message,
                })}
              </p>
            ) : null}
          </section>
        ) : null}
        {selectedTarget?.content || selectedTarget?.diff ? (
          <section className="mb-4" data-mobile-file-highlight="true">
            <div className={`${SESSION_UI_TOKENS.TEXT.LABEL_XS} mb-1.5`}>
              {selectedTarget.diff
                ? t("transcript.tools.changes")
                : t("transcript.tools.preview")}
            </div>
            <Suspense
              fallback={
                <div className="min-h-24 rounded-lg border border-border-2 bg-bg-2">
                  <Placeholder
                    placement="sidebar"
                    variant="loading"
                    title={t("transcript.tools.loadingPreview")}
                  />
                </div>
              }
            >
              <MobileFilePreview target={selectedTarget} />
            </Suspense>
          </section>
        ) : null}
        {fileTargets.length === 0 && metadataText ? (
          <section className="mb-4">
            <div className={`${SESSION_UI_TOKENS.TEXT.LABEL_XS} mb-1.5`}>
              {t("transcript.tools.details")}
            </div>
            <pre className="chat-code-sm overflow-x-auto rounded-lg bg-fill-1 p-3 leading-5 break-words whitespace-pre-wrap text-text-2">
              {metadataText}
            </pre>
          </section>
        ) : null}
        {fileTargets.length === 0 && output ? (
          <section className="mb-4">
            <div className={`${SESSION_UI_TOKENS.TEXT.LABEL_XS} mb-1.5`}>
              {t("transcript.tools.output")}
            </div>
            <pre className="chat-code-sm overflow-x-auto rounded-lg bg-fill-1 p-3 leading-5 break-words whitespace-pre-wrap text-text-2">
              {output}
            </pre>
          </section>
        ) : null}
        {item.toolDataTruncated ? (
          <p className="chat-block-xs text-text-3">
            {t("transcript.tools.truncated")}
          </p>
        ) : null}
      </div>
    </BottomSheet>
  );
}

MobileToolDetailSheet.displayName = "MobileToolDetailSheet";
