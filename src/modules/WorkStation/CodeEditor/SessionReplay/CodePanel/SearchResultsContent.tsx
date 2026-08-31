/**
 * Search / list_dir / cat / grep result bodies for session replay CodePanel.
 */
import React, { memo, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import FileTypeIcon from "@src/components/FileTypeIcon";
import { Placeholder } from "@src/components/Placeholder";
import { getToolIcon } from "@src/config/toolIcons";
import {
  Cancel01Icon,
  CodeXmlIcon,
  HugeiconsIcon,
  UnfoldMoreIcon,
} from "@src/icons";
import { getToolDisplayLabelFromRegistry } from "@src/util/ui/rendering/registryToolLabel";

import { SIMULATOR_LIST_DIR_DISPLAY_CAP } from "../listDirLimits";
import type { ExploreOperationEntry, SearchResult } from "../types";
import { SessionReplayCodeMirrorViewer } from "./SessionReplayCodeMirrorViewer";
import { searchSnippetOneLine } from "./pathUtils";
import { SEARCH_ROW_ICON_CLASS } from "./searchIcons";
import {
  DiagnosticRow,
  DirectorySummaryHeader,
  ExploreResultRow,
  GroupedExploreResultRows,
  LspSummaryHeader,
  SearchMatchRow,
  SearchSummaryHeader,
} from "./searchResultsComponents";
import type { GroupedExploreResult } from "./searchResultsComponents";
import {
  parseDiagnosticContent,
  parseMatchCountText,
  parseSearchKeywords,
} from "./searchResultsParsers";

const DEFAULT_VISIBLE_EXPLORE_RESULT_COUNT = 25;
const LOAD_MORE_EXPLORE_RESULT_COUNT = 25;

function LoadMoreResultsButton({
  hiddenCount,
  onClick,
}: {
  hiddenCount: number;
  onClick: () => void;
}): React.ReactElement | null {
  const { t } = useTranslation("common");

  if (hiddenCount <= 0) return null;

  return (
    <div className="flex w-full justify-center py-1.5">
      <Button
        htmlType="button"
        variant="tertiary"
        appearance="ghost"
        size="small"
        icon={
          <HugeiconsIcon
            icon={UnfoldMoreIcon}
            data-icon="chevrons-up-down"
            size={14}
          />
        }
        onClick={onClick}
      >
        {t("actions.loadMore")} ({hiddenCount})
      </Button>
    </div>
  );
}

function isDirectoryNotFoundMessage(message: string): boolean {
  return /Execution failed:\s*Directory not found/i.test(message);
}

function groupResultsByFile(
  results: SearchResult[]
): GroupedExploreResult<SearchResult>[] {
  const groupedResults = new Map<string, SearchResult[]>();
  const orderedFiles: string[] = [];

  for (const result of results) {
    if (!groupedResults.has(result.file)) {
      orderedFiles.push(result.file);
      groupedResults.set(result.file, []);
    }
    groupedResults.get(result.file)!.push(result);
  }

  return orderedFiles.map((filePath) => ({
    filePath,
    items: groupedResults.get(filePath) ?? [],
  }));
}

export const SearchResultsContent: React.FC<{
  operation: ExploreOperationEntry;
}> = memo(({ operation }) => {
  const { t } = useTranslation();
  const { t: tSessions } = useTranslation("sessions");
  const {
    exploreType,
    exploreAction,
    query: _query,
    results,
    files,
    totalMatches,
    directory: workspaceDirectoryHint,
    isLoading,
    hasResultPayload,
  } = operation;
  const [visibleExploreResultState, setVisibleExploreResultState] = useState({
    key: operation.eventId,
    count: DEFAULT_VISIBLE_EXPLORE_RESULT_COUNT,
  });
  const visibleExploreResultCount =
    visibleExploreResultState.key === operation.eventId
      ? visibleExploreResultState.count
      : DEFAULT_VISIBLE_EXPLORE_RESULT_COUNT;

  const handleLoadMoreResults = () => {
    setVisibleExploreResultState((currentState) => ({
      key: operation.eventId,
      count:
        (currentState.key === operation.eventId
          ? currentState.count
          : DEFAULT_VISIBLE_EXPLORE_RESULT_COUNT) +
        LOAD_MORE_EXPLORE_RESULT_COUNT,
    }));
  };

  if (isLoading) {
    return (
      <div className="flex min-h-0 min-h-full w-full min-w-0 flex-1 flex-col" />
    );
  }

  if (exploreType === "list_dir") {
    const fileList = files ?? [];
    const directoryNotFoundMessage = fileList.find(isDirectoryNotFoundMessage);
    const visibleFileList = directoryNotFoundMessage ? [] : fileList;
    const fileCount = directoryNotFoundMessage
      ? 0
      : totalMatches > 0
        ? totalMatches
        : visibleFileList.length;
    const showTruncationHint =
      !directoryNotFoundMessage && Boolean(operation.listDirDisplayTruncated);
    const hasVisibleBody =
      Boolean(directoryNotFoundMessage) ||
      visibleFileList.length > 0 ||
      showTruncationHint;
    return (
      <div className="flex w-full min-w-0 flex-col">
        <DirectorySummaryHeader
          directory={workspaceDirectoryHint}
          countLabel={
            hasResultPayload && hasVisibleBody
              ? tSessions("simulator.replay.ide.codePanel.resultCount", {
                  count: fileCount,
                })
              : undefined
          }
        />
        {directoryNotFoundMessage ? (
          <div className="flex w-full min-w-0 flex-col gap-0.5 p-2">
            <div className="flex w-full min-w-0 max-w-full items-center gap-2 rounded px-2 py-1.5 text-[13px] hover:bg-fill-2">
              <HugeiconsIcon
                icon={Cancel01Icon}
                data-icon="x"
                size={14}
                className="shrink-0 text-danger-6"
              />
              <span
                className="min-w-0 flex-1 truncate text-text-1"
                title={directoryNotFoundMessage}
              >
                {directoryNotFoundMessage}
              </span>
            </div>
          </div>
        ) : visibleFileList.length > 0 ? (
          <div className="flex w-full min-w-0 flex-col gap-0.5 p-2">
            {visibleFileList.map((file, idx) => (
              <div
                key={idx}
                className="flex w-full min-w-0 max-w-full items-center gap-2 rounded px-2 py-1.5 text-[13px] hover:bg-fill-2"
              >
                <FileTypeIcon
                  fileName={file}
                  size="small"
                  className={SEARCH_ROW_ICON_CLASS}
                />
                <span
                  className="min-w-0 flex-1 truncate text-text-1"
                  title={file}
                >
                  {file}
                </span>
              </div>
            ))}
          </div>
        ) : null}
        {showTruncationHint ? (
          <p className="border-t border-border-2 px-3 py-2 text-[12px] leading-snug text-text-3">
            {operation.listDirParseSafetyCapped
              ? t("placeholders.listDirParseSafetyHint", {
                  maxShown: SIMULATOR_LIST_DIR_DISPLAY_CAP,
                })
              : t("placeholders.listDirTruncatedHint", {
                  maxShown: SIMULATOR_LIST_DIR_DISPLAY_CAP,
                  total: operation.listDirTotalListedCount ?? fileList.length,
                })}
          </p>
        ) : null}
      </div>
    );
  }

  if (exploreType === "cat" && results.length > 0) {
    const content = results[0].content;
    const filePath = results[0].file;
    return (
      <div className="h-full min-h-0 w-full min-w-0 overflow-hidden">
        <SessionReplayCodeMirrorViewer
          content={content}
          filePath={filePath}
          language="text"
        />
      </div>
    );
  }

  if (exploreType === "tool_search") {
    const toolList = files ?? [];
    const visibleTools = toolList.slice(0, visibleExploreResultCount);
    const hiddenToolCount = Math.max(0, toolList.length - visibleTools.length);
    const toolCount = totalMatches > 0 ? totalMatches : toolList.length;
    const hasVisibleBody = visibleTools.length > 0 || hiddenToolCount > 0;

    return (
      <div className="flex w-full min-w-0 flex-col">
        <SearchSummaryHeader
          query={_query}
          directory={workspaceDirectoryHint}
          toolLabel={getToolDisplayLabelFromRegistry("tool_search")}
          countLabel={
            hasResultPayload && hasVisibleBody
              ? tSessions("simulator.replay.ide.codePanel.resultCount", {
                  count: toolCount,
                })
              : undefined
          }
        />
        {visibleTools.length > 0 ? (
          <div className="flex w-full min-w-0 flex-col gap-0.5 p-2">
            {visibleTools.map((toolName, idx) => (
              <div
                key={`${toolName}-${idx}`}
                className="flex w-full min-w-0 max-w-full items-center gap-2 rounded px-2 py-1.5 text-[13px] hover:bg-fill-2"
              >
                {getToolIcon(toolName, {
                  size: 14,
                  className: SEARCH_ROW_ICON_CLASS,
                })}
                <span
                  className="min-w-0 flex-1 truncate text-text-1"
                  title={toolName}
                >
                  {toolName}
                </span>
              </div>
            ))}
          </div>
        ) : null}
        <LoadMoreResultsButton
          hiddenCount={hiddenToolCount}
          onClick={handleLoadMoreResults}
        />
      </div>
    );
  }

  if (exploreType === "glob" || exploreType === "file_search") {
    const fileList = files ?? [];
    const visibleFiles = fileList.slice(0, visibleExploreResultCount);
    const hiddenFileCount = Math.max(0, fileList.length - visibleFiles.length);
    const fileCount = totalMatches > 0 ? totalMatches : fileList.length;
    const hasVisibleBody = visibleFiles.length > 0 || hiddenFileCount > 0;

    return (
      <div className="flex w-full min-w-0 flex-col">
        <SearchSummaryHeader
          query={_query}
          directory={workspaceDirectoryHint}
          toolLabel={getToolDisplayLabelFromRegistry(
            "code_search",
            exploreType === "file_search" ? "find_files" : "glob"
          )}
          countLabel={
            hasResultPayload && hasVisibleBody
              ? tSessions("simulator.replay.ide.codePanel.resultCount", {
                  count: fileCount,
                })
              : undefined
          }
        />
        {visibleFiles.length > 0 ? (
          <div className="flex w-full min-w-0 flex-col gap-0.5 p-2">
            {visibleFiles.map((file, idx) => (
              <ExploreResultRow
                key={`${file}-${idx}`}
                filePath={file}
                workspaceDirectoryHint={workspaceDirectoryHint}
              />
            ))}
          </div>
        ) : null}
        <LoadMoreResultsButton
          hiddenCount={hiddenFileCount}
          onClick={handleLoadMoreResults}
        />
      </div>
    );
  }

  // manage_workspace: display workspace entries matching chat panel style
  // (shared across list / add / remove actions — each emits the same
  // `[kind] name → path` line format)
  if (exploreType === "manage_workspace" && files && files.length > 0) {
    return (
      <div className="flex w-full min-w-0 flex-col gap-0.5 p-2">
        {files.map((entry, idx) => {
          // Format: "[git] name → path" or "[folder] name → path"
          const kindMatch = entry.match(/^\[(\w+)\]\s*/);
          const isGit = kindMatch?.[1] === "git";
          const rest = kindMatch ? entry.slice(kindMatch[0].length) : entry;
          const [name, ...pathParts] = rest.split("→");
          const path = pathParts.join("→").trim();

          return (
            <div
              key={idx}
              className="flex w-full min-w-0 max-w-full items-center gap-2 rounded px-2 py-1.5 text-[13px] hover:bg-fill-2"
            >
              {isGit ? (
                <HugeiconsIcon
                  icon={CodeXmlIcon}
                  data-icon="code-2"
                  size={14}
                  className="flex-shrink-0 text-primary-6"
                />
              ) : (
                <FileTypeIcon
                  fileName={name.trim()}
                  type="folder"
                  size="small"
                  className={SEARCH_ROW_ICON_CLASS}
                />
              )}
              <span className="flex-shrink-0 font-medium text-text-1">
                {name.trim()}
              </span>
              <span
                className="min-w-0 flex-1 truncate text-[12px] text-text-3"
                title={path}
              >
                {path}
              </span>
            </div>
          );
        })}
      </div>
    );
  }

  if (exploreType === "query_lsp") {
    const fileList = files ?? [];
    const checkedFilesOnly =
      results.length === 1 &&
      results[0].line === 0 &&
      results[0].content.includes("No diagnostics returned.");
    const diagnosticCount = checkedFilesOnly
      ? 0
      : totalMatches > 0
        ? totalMatches
        : results.length;
    const displayFilePath = fileList[0] || results[0]?.file;

    return (
      <div className="flex w-full min-w-0 flex-col">
        <LspSummaryHeader
          filePath={displayFilePath}
          directory={workspaceDirectoryHint}
          fileCountLabel={
            fileList.length > 0
              ? fileList.length === 1
                ? "1 file"
                : `${fileList.length} files`
              : undefined
          }
          countLabel={
            diagnosticCount > 0
              ? tSessions("simulator.replay.ide.codePanel.resultCount", {
                  count: diagnosticCount,
                })
              : tSessions("simulator.replay.ide.codePanel.lspNoDiagnostics")
          }
        />
        {checkedFilesOnly && fileList.length > 0 ? (
          <div className="flex w-full min-w-0 flex-col gap-0.5 p-2">
            {fileList.map((file, idx) => (
              <ExploreResultRow
                key={`${file}-${idx}`}
                filePath={file}
                workspaceDirectoryHint={workspaceDirectoryHint}
              />
            ))}
          </div>
        ) : results.length > 0 ? (
          <GroupedExploreResultRows
            groups={groupResultsByFile(results)}
            workspaceDirectoryHint={workspaceDirectoryHint}
            renderItem={(diagnostic, diagnosticIndex, filePath) => {
              const parsed = parseDiagnosticContent(diagnostic.content);
              return (
                <DiagnosticRow
                  key={`${filePath}-${diagnostic.line}-${diagnosticIndex}`}
                  severity={parsed.severity}
                  message={parsed.message}
                  source={parsed.source}
                  line={diagnostic.line}
                />
              );
            }}
          />
        ) : null}
      </div>
    );
  }

  if (exploreType === "code_search") {
    const visibleSearchResults = results.slice(0, visibleExploreResultCount);
    const fileFallbackList = files ?? [];
    const visibleFileFallbackList = fileFallbackList.slice(
      0,
      visibleExploreResultCount
    );
    const hiddenResultCount = Math.max(
      0,
      (results.length > 0 ? results.length : fileFallbackList.length) -
        (results.length > 0
          ? visibleSearchResults.length
          : visibleFileFallbackList.length)
    );
    const displayResults: SearchResult[] =
      results.length > 0
        ? results
        : fileFallbackList.map((file) => ({ file, line: 0, content: "" }));

    const visibleResultCount = displayResults.reduce((sum, result) => {
      const snippet = searchSnippetOneLine(result.content);
      return sum + (parseMatchCountText(snippet) ?? 1);
    }, 0);
    const resultCount =
      results.length > 0
        ? visibleResultCount
        : totalMatches > 0
          ? totalMatches
          : visibleResultCount;
    const hasVisibleBody =
      visibleSearchResults.length > 0 ||
      visibleFileFallbackList.length > 0 ||
      hiddenResultCount > 0;
    const countLabel =
      hasResultPayload && hasVisibleBody
        ? tSessions("simulator.replay.ide.codePanel.resultCount", {
            count: resultCount,
          })
        : undefined;
    const highlightTerms = parseSearchKeywords(_query);

    return (
      <div className="flex w-full min-w-0 flex-col">
        <SearchSummaryHeader
          query={_query}
          directory={workspaceDirectoryHint}
          toolLabel={getToolDisplayLabelFromRegistry(
            "code_search",
            exploreAction === "grep" ? "grep" : undefined
          )}
          countLabel={countLabel}
        />
        {visibleSearchResults.length > 0 ? (
          <GroupedExploreResultRows
            groups={groupResultsByFile(visibleSearchResults)}
            workspaceDirectoryHint={workspaceDirectoryHint}
            getCount={(group) =>
              group.items.reduce((sum, result) => {
                const snippet = searchSnippetOneLine(result.content);
                return sum + (parseMatchCountText(snippet) ?? 1);
              }, 0)
            }
            renderItem={(result, resultIndex, filePath) => {
              const snippet = searchSnippetOneLine(result.content);
              const explicitGrepCount = parseMatchCountText(snippet);
              if (typeof explicitGrepCount === "number") return null;
              const lineLabel =
                result.line > 0
                  ? tSessions(
                      "simulator.replay.ide.codePanel.searchResultLinePrefix",
                      { line: result.line }
                    )
                  : undefined;
              return (
                <SearchMatchRow
                  key={`${filePath}-${result.line}-${resultIndex}`}
                  message={snippet}
                  lineLabel={lineLabel}
                  highlightTerms={highlightTerms}
                />
              );
            }}
          />
        ) : visibleFileFallbackList.length > 0 ? (
          <div className="flex w-full min-w-0 flex-col gap-0.5 p-2">
            {visibleFileFallbackList.map((file, fileIndex) => (
              <ExploreResultRow
                key={`${file}-${fileIndex}`}
                filePath={file}
                workspaceDirectoryHint={workspaceDirectoryHint}
              />
            ))}
          </div>
        ) : null}
        <LoadMoreResultsButton
          hiddenCount={hiddenResultCount}
          onClick={handleLoadMoreResults}
        />
      </div>
    );
  }

  // No results found (operation completed but returned empty)
  return (
    <Placeholder
      variant="empty"
      placement="detail-panel"
      fillParentHeight
      title={tSessions("tools.noResultsFound")}
    />
  );
});

SearchResultsContent.displayName = "SearchResultsContent";
