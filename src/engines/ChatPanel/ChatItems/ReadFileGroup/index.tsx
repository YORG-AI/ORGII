/**
 * ReadFileGroup Component
 *
 * Displays a collapsible group of read file events using StackedBlock.
 * Single file with content: renders standalone ChatCodeBlock.
 * Multiple files: renders StackedBlock with ChatCodeBlocks inside.
 */
import { FileText } from "lucide-react";
import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { ChatCodeBlock, StackedBlock } from "@src/engines/ChatPanel/blocks";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { stripLineNumberPrefixes } from "@src/engines/SessionCore/rendering/props/propsDataExtractors";
import { getFileName } from "@src/util/file/pathUtils";

import { getReadFileName, getReadFilePath } from "../readFileEventData";

// ============================================
// Types
// ============================================

export interface ReadFileGroupProps {
  events: SessionEvent[];
}

// ============================================
// Helpers
// ============================================

function hasFileContent(event: SessionEvent): boolean {
  const result = event.result;
  if (!result || Object.keys(result).length === 0) return false;

  const output = result.output as Record<string, unknown> | undefined;
  const outputSuccess = (output?.success as Record<string, unknown>) || {};
  const directSuccess = (result.success as Record<string, unknown>) || {};

  return !!(
    outputSuccess?.content ||
    directSuccess?.content ||
    result?.content ||
    result?.file_content ||
    result?.observation
  );
}

function getFileContent(event: SessionEvent): string | null {
  const result = event.result;
  if (!result) return null;

  const output = result.output as Record<string, unknown> | undefined;
  const outputSuccess = output?.success as Record<string, unknown> | undefined;
  if (typeof outputSuccess?.content === "string")
    return outputSuccess.content as string;

  const directSuccess = result.success as Record<string, unknown> | undefined;
  if (typeof directSuccess?.content === "string")
    return directSuccess.content as string;

  if (typeof result.content === "string") return result.content as string;
  if (typeof result.file_content === "string")
    return result.file_content as string;
  if (typeof result.observation === "string")
    return result.observation as string;

  return null;
}

// Line-number prefixes (`│`/`→` from the Rust `read_file`, `<digits><TAB>` from
// Claude Code's `Read`) and the `[action: ...]` marker are stripped by the
// shared extractor so every read surface agrees on the format list.
function cleanFileContent(rawContent: string): string {
  const withoutReminders = rawContent.replace(
    /<system-reminder>[\s\S]*?<\/system-reminder>\s*/g,
    ""
  );
  return stripLineNumberPrefixes(withoutReminders).content.trimEnd();
}

function formatReadEventName(event: SessionEvent): string {
  const filePath = getReadFilePath(event);
  return getReadFileName(event) || getFileName(filePath) || "file";
}

// ============================================
// Component
// ============================================

const ReadFileGroup: React.FC<ReadFileGroupProps> = ({ events }) => {
  const { t } = useTranslation("sessions");

  const withContent = useMemo(
    () => events.filter((ev) => hasFileContent(ev)),
    [events]
  );

  if (events.length === 0) return null;

  if (events.length === 1 && withContent.length === 1) {
    const event = events[0];
    const content = getFileContent(event);
    const filePath = getReadFilePath(event);
    const displayName = formatReadEventName(event);

    if (content) {
      return (
        <ChatCodeBlock
          code={cleanFileContent(content)}
          filePath={filePath}
          title={displayName}
          defaultCollapsed={false}
          showLineCount={false}
        />
      );
    }
  }

  const groupLabel = t("tools.nFiles", { count: events.length });

  return (
    <StackedBlock
      items={events}
      icon={<FileText size={14} className="text-text-2" />}
      label={`Read ${groupLabel}`}
      eventId={events[0]?.id}
      renderItem={(event) => {
        const content = getFileContent(event);
        const filePath = getReadFilePath(event);
        const displayName = formatReadEventName(event);

        if (!content) {
          return (
            <ChatCodeBlock
              code={displayName}
              language="text"
              title={displayName}
              defaultCollapsed
              showLineCount={false}
              eventId={event.id}
              showCopyButton={false}
            />
          );
        }

        return (
          <ChatCodeBlock
            code={cleanFileContent(content)}
            filePath={filePath}
            title={displayName}
            defaultCollapsed
            showLineCount={false}
            eventId={event.id}
          />
        );
      }}
    />
  );
};

export default ReadFileGroup;
