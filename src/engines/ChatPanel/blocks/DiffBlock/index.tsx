/**
 * DiffBlock — Chat-variant rendering for file-edit events
 * (`create`, `overwrite`, `edit`, `apply_patch`).
 *
 * Absorbs the prior `EditEvent` chat-variant logic. When the extracted data
 * contains multi-file `applyPatchSegments`, each segment is rendered as its
 * own `ChatCodeBlock` (deletion segments render with a "Deleted" trailing
 * tag and no body via `hasContent={false}`).
 * During streaming we show the raw `newContent` as code; once complete we
 * prefer a real unified diff, falling back to a synthetic full-write diff
 * when only the new content is available.
 */
import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";

import DiffStatsBadge from "@src/components/DiffStatsBadge";
import FileTypeIcon from "@src/components/FileTypeIcon";
import { getToolIcon } from "@src/config/toolIcons";
import {
  extractEditData,
  parseUnifiedDiffToOldNew,
} from "@src/engines/SessionCore/rendering/props/propsDataExtractors";
import { useToolLabelText } from "@src/engines/SessionCore/rendering/registry";
import type {
  EventStatus,
  ExtractedEditData,
  UniversalEventProps,
} from "@src/engines/SessionCore/rendering/types/universalProps";
import { getFileName } from "@src/util/file/pathUtils";

import { useChatHistoryDisplayMode } from "../../ChatHistory/chatDisplayModeContext";
import ChatCodeBlock from "../CodeBlock";
import EventFileHoverPreview from "../EventFileHoverPreview";
import {
  EventBlockHeader,
  EventBlockHeaderIcon,
  EventBlockHeaderSubtitle,
  EventBlockHeaderTitle,
  FailedEventRow,
  SESSION_UI_TOKENS,
  getEventBlockContainerClasses,
} from "../primitives";
import { useBlockHeader } from "../useBlockLocate";

function hasStreamingContent(segments: ExtractedEditData[]): boolean {
  return segments.some((s) => s.newContent || s.diff);
}

const VISIBLE_LINES = 6;

// Decode escape sequences that arrive in streaming payloads before the
// backend has had a chance to deliver the real diff/content.
function decodeStreamContent(content: string): string {
  try {
    return content
      .replace(/\\n/g, "\n")
      .replace(/\\"/g, '"')
      .replace(/\\t/g, "\t")
      .replace(/\\\\/g, "\\");
  } catch {
    return content;
  }
}

// Synthesize a unified-diff string that represents creating a brand new
// file: every line is an addition. This lets ChatCodeBlock render new-file
// writes (no real diff payload) with the same green-stripe diff styling
// and `+N` header badge as a real diff, instead of falling back to plain
// code without an add-count.
function synthesizeFullAddDiff(content: string): string {
  const lines = content.split("\n");
  const header = `@@ -0,0 +1,${lines.length} @@`;
  return [header, ...lines.map((line) => `+${line}`)].join("\n");
}

interface SegmentViewProps {
  segment: ExtractedEditData;
  isLoading: boolean;
  eventId: string;
  isNewFile?: boolean;
}

const SegmentView: React.FC<SegmentViewProps> = ({
  segment,
  isLoading,
  eventId,
  isNewFile,
}) => {
  const { t } = useTranslation("sessions");
  const {
    filePath,
    fileName,
    diff,
    newContent,
    language,
    linesAdded = 0,
    linesRemoved = 0,
  } = segment;

  const displayTitle = getFileName(filePath) || fileName || "file";

  const displayDiff = diff ? decodeStreamContent(diff) : undefined;
  const displayContent = newContent
    ? decodeStreamContent(newContent)
    : undefined;

  // For completed new-file writes (no diff, only newContent), synthesize a
  // full-add unified diff so the body renders as a diff and the header
  // gets the +N badge. During streaming we still show raw content.
  // Only synthesize for actual new-file actions — edit/overwrite events
  // without a diff payload should not get the "New" tag.
  const syntheticAddDiff =
    !isLoading && !displayDiff && displayContent && isNewFile
      ? synthesizeFullAddDiff(displayContent)
      : undefined;

  const resolvedDiff = displayDiff || syntheticAddDiff;
  const resolvedContent = resolvedDiff || displayContent;

  const diffPayload = (() => {
    if (segment.oldContent !== undefined && segment.newContent !== undefined) {
      return {
        oldValue: decodeStreamContent(segment.oldContent),
        newValue: decodeStreamContent(segment.newContent),
        oldStartLine: segment.oldStartLine,
        newStartLine: segment.newStartLine,
      };
    }
    if (!resolvedDiff) return undefined;
    const parsed = parseUnifiedDiffToOldNew(resolvedDiff);
    return {
      oldValue: parsed.oldValue,
      newValue: parsed.newValue,
      oldStartLine: parsed.oldStartLine,
      newStartLine: parsed.newStartLine,
    };
  })();

  const isDiff = Boolean(resolvedDiff || diffPayload);
  const resolvedLanguage = isDiff ? "diff" : language || "text";
  const showResolvedLineCount = isDiff || !isLoading;

  const resolvedLinesAdded =
    syntheticAddDiff && !linesAdded
      ? (displayContent ?? "").split("\n").length
      : linesAdded;

  // For new-file writes, append a muted "New" suffix next to the green `+N` count.
  const trailingTags = syntheticAddDiff
    ? ([{ tone: "secondary", text: t("tools.new") }] as const)
    : undefined;

  if (resolvedContent) {
    const content = (
      <ChatCodeBlock
        code={resolvedContent}
        language={resolvedLanguage}
        filePath={filePath}
        title={displayTitle}
        separateTitle={false}
        showLineNumbers
        defaultCollapsed={false}
        visibleLines={VISIBLE_LINES}
        linesAdded={resolvedLinesAdded}
        linesRemoved={linesRemoved}
        diffPayload={diffPayload}
        showLineCount={showResolvedLineCount}
        trailingTags={trailingTags}
        eventId={eventId}
        isLoading={isLoading}
        showFileTreeHover={false}
      />
    );

    if (!filePath) return content;

    return (
      <EventFileHoverPreview path={filePath}>{content}</EventFileHoverPreview>
    );
  }

  if (isLoading) {
    const content = (
      <ChatCodeBlock
        code=""
        language={resolvedLanguage}
        filePath={filePath}
        title={displayTitle}
        separateTitle={false}
        defaultCollapsed
        eventId={eventId}
        isLoading
        showFileTreeHover={false}
      />
    );

    if (!filePath) return content;

    return (
      <EventFileHoverPreview path={filePath}>{content}</EventFileHoverPreview>
    );
  }

  return null;
};

interface CompactSegmentViewProps {
  segment: ExtractedEditData;
  eventId: string;
  status: EventStatus;
  isLoading: boolean;
  isNewFile?: boolean;
}

const CompactSegmentView: React.FC<CompactSegmentViewProps> = ({
  segment,
  eventId,
  status,
  isLoading,
  isNewFile,
}) => {
  const { t } = useTranslation("sessions");
  const displayTitle =
    getFileName(segment.filePath) || segment.fileName || "file";
  const decodedContent = segment.newContent
    ? decodeStreamContent(segment.newContent)
    : undefined;
  const linesAdded =
    isNewFile && !segment.linesAdded && decodedContent
      ? decodedContent.split("\n").length
      : (segment.linesAdded ?? 0);
  const linesRemoved = segment.linesRemoved ?? 0;
  const hasInfo = linesAdded > 0 || linesRemoved > 0 || segment.isDeleted;
  const compactLabelState =
    status === "running" ? "compact_running" : "compact_done";
  const compactTitle = useToolLabelText("edit_file", compactLabelState);

  const {
    isHeaderHovered,
    handleHeaderMouseEnter,
    handleHeaderMouseLeave,
    handleLocate,
  } = useBlockHeader({ eventId });

  const editIcon = useMemo(
    () =>
      getToolIcon("edit_file", {
        size: SESSION_UI_TOKENS.ICON.SIZE_SM,
        className: "text-text-2",
      }),
    []
  );

  const content = (
    <div className={`${getEventBlockContainerClasses(false)} animate-fade-in`}>
      <EventBlockHeader
        isCollapsed
        withHover={false}
        onClick={handleLocate}
        onNavigate={handleLocate}
        onMouseEnter={handleHeaderMouseEnter}
        onMouseLeave={handleHeaderMouseLeave}
      >
        <EventBlockHeaderIcon
          icon={editIcon}
          isCollapsed
          isHeaderHovered={isHeaderHovered}
          hasContent={false}
          revealChevronOnIconHoverOnly={Boolean(eventId)}
          isLoading={isLoading}
        />
        <EventBlockHeaderTitle isLoading={isLoading}>
          {compactTitle}
        </EventBlockHeaderTitle>
        <EventBlockHeaderSubtitle isLoading={isLoading} className="text-text-1">
          <FileTypeIcon
            fileName={displayTitle}
            size="small"
            className="mr-1.5 shrink-0"
          />
          <span className="min-w-0 truncate text-text-1">{displayTitle}</span>
          {hasInfo && (
            <span className="ml-2 inline-flex shrink-0 items-center gap-1 whitespace-nowrap">
              <DiffStatsBadge
                additions={linesAdded}
                deletions={linesRemoved}
                variant="plain"
                className="translate-y-px gap-0"
              />
              {segment.isDeleted && (
                <span className="text-danger-6">{t("tools.deleted")}</span>
              )}
            </span>
          )}
        </EventBlockHeaderSubtitle>
      </EventBlockHeader>
    </div>
  );

  if (!segment.filePath) return content;

  return (
    <EventFileHoverPreview path={segment.filePath}>
      {content}
    </EventFileHoverPreview>
  );
};

export interface DiffBlockProps extends UniversalEventProps {
  /**
   * Pre-translated header title for the current lifecycle state.
   * Adapter resolves via `resolveLifecycleLabelKeys` + `t(key, { name })`
   * and picks running / done / failed. Block renders this verbatim.
   */
  title: string;
}

function isDeleteFileEvent(props: UniversalEventProps): boolean {
  if (props.rustExtracted?.kind === "deleteFile") return true;
  if (props.eventType === "delete_file") return true;
  if (props.args?.action === "delete") return true;
  return false;
}

const DeleteFileView: React.FC<DiffBlockProps> = (props) => {
  const { t } = useTranslation("sessions");
  const { status, title } = props;

  let filePath = "";
  let fileName = "";

  if (props.rustExtracted?.kind === "deleteFile") {
    filePath = props.rustExtracted.filePath;
    fileName = props.rustExtracted.fileName;
  } else {
    filePath =
      (props.args?.path as string) ||
      (props.args?.file_path as string) ||
      (props.args?.target_file as string) ||
      "";
    fileName = filePath ? getFileName(filePath) || "file" : "file";
  }

  const displayTitle = getFileName(filePath) || fileName || "file";

  if (status === "running") {
    const deleteIcon = getToolIcon("delete_file", {
      size: SESSION_UI_TOKENS.ICON.SIZE_SM,
    });
    const isLoading = props.showActiveEventPainting === true;
    return (
      <EventBlockHeader isCollapsed withHover={false}>
        <EventBlockHeaderIcon icon={deleteIcon} isLoading={isLoading} />
        <EventBlockHeaderTitle isLoading={isLoading}>
          {title}
        </EventBlockHeaderTitle>
      </EventBlockHeader>
    );
  }

  if (status === "failed") {
    return <FailedEventRow toolName="delete_file" label={title} />;
  }

  return (
    <ChatCodeBlock
      code=""
      filePath={filePath}
      title={displayTitle}
      hasContent={false}
      defaultCollapsed
      trailingTags={[{ tone: "danger", text: t("tools.deleted") }]}
    />
  );
};

interface EditViewProps extends UniversalEventProps {
  title: string;
}

const EditView: React.FC<EditViewProps> = (props) => {
  const { t } = useTranslation("sessions");
  const displayMode = useChatHistoryDisplayMode();
  const { eventId, status, title } = props;

  const isNewFile = props.args?.action === "create";

  const editData = useMemo(() => extractEditData(props), [props]);

  const segments = useMemo<ExtractedEditData[]>(() => {
    if (editData.applyPatchSegments && editData.applyPatchSegments.length > 0) {
      return editData.applyPatchSegments;
    }
    return [editData];
  }, [editData]);

  const editIcon = useMemo(
    () =>
      getToolIcon("edit_file", {
        size: SESSION_UI_TOKENS.ICON.SIZE_SM,
        className: "text-text-2",
      }),
    []
  );

  const {
    isHeaderHovered,
    handleHeaderMouseEnter,
    handleHeaderMouseLeave,
    handleLocate,
  } = useBlockHeader({ eventId });

  if (status === "failed") {
    const displayTitle =
      getFileName(editData.filePath) || editData.fileName || "file";
    return (
      <div
        className={`${getEventBlockContainerClasses(false)} animate-fade-in`}
      >
        <EventBlockHeader
          isCollapsed
          withHover={false}
          onClick={handleLocate}
          onNavigate={handleLocate}
          onMouseEnter={handleHeaderMouseEnter}
          onMouseLeave={handleHeaderMouseLeave}
        >
          <EventBlockHeaderIcon
            icon={editIcon}
            isCollapsed
            isHeaderHovered={isHeaderHovered}
            isFailed
            hasContent={false}
            revealChevronOnIconHoverOnly={Boolean(eventId)}
          />
          <EventBlockHeaderTitle className="text-text-3">
            {title}
          </EventBlockHeaderTitle>
          <EventBlockHeaderSubtitle className="text-text-3">
            <FileTypeIcon
              fileName={displayTitle}
              size="small"
              className="mr-1.5 shrink-0"
            />
            <span className="min-w-0 truncate">{displayTitle}</span>
          </EventBlockHeaderSubtitle>
        </EventBlockHeader>
      </div>
    );
  }

  const isLoading =
    status === "running" && props.showActiveEventPainting === true;

  if (status === "running" && !hasStreamingContent(segments)) {
    return (
      <EventBlockHeader isCollapsed withHover={false}>
        <EventBlockHeaderIcon icon={editIcon} isLoading={isLoading} />
        <EventBlockHeaderTitle isLoading={isLoading}>
          {title}
        </EventBlockHeaderTitle>
      </EventBlockHeader>
    );
  }

  if (displayMode === "compact") {
    return (
      <div className="flex flex-col gap-2">
        {segments.map((segment, segmentIndex) => (
          <CompactSegmentView
            key={`${eventId}-compact-segment-${segmentIndex}`}
            segment={segment}
            eventId={eventId}
            status={status}
            isLoading={isLoading}
            isNewFile={isNewFile}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {segments.map((segment, segmentIndex) => {
        const segmentKey = `${eventId}-segment-${segmentIndex}`;
        if (segment.isDeleted) {
          const displayTitle =
            getFileName(segment.filePath) || segment.fileName || "file";
          return (
            <ChatCodeBlock
              key={segmentKey}
              code=""
              filePath={segment.filePath}
              title={displayTitle}
              hasContent={false}
              defaultCollapsed
              trailingTags={[{ tone: "danger", text: t("tools.deleted") }]}
            />
          );
        }
        return (
          <SegmentView
            key={segmentKey}
            segment={segment}
            isLoading={isLoading}
            eventId={eventId}
            isNewFile={isNewFile}
          />
        );
      })}
    </div>
  );
};

export const DiffBlock: React.FC<DiffBlockProps> = (props) => {
  if (isDeleteFileEvent(props)) return <DeleteFileView {...props} />;
  return <EditView {...props} title={props.title} />;
};

DiffBlock.displayName = "DiffBlock";

export default DiffBlock;
