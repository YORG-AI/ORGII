/**
 * ExploreAdapter — renders `list_dir`-shaped events.
 *
 * `list_dir` itself is collapsed to a title-only header row (no expandable
 * body). Matched entries remain inspectable in the simulator's Files tab,
 * so the chat panel stays compact for what is usually a high-volume,
 * low-information event.
 *
 * `query_lsp` (also routed through `CbExplore`) keeps the full `ExploreBlock`
 * because its diagnostic text lines are the actual deliverable to the user
 * — there is no equivalent surface in the simulator to fall back to.
 */
import React from "react";

import {
  statusToLifecycle,
  useLifecycleLabels,
} from "@src/engines/SessionCore/rendering/registry";
import type { UniversalEventProps } from "@src/engines/SessionCore/rendering/types/universalProps";
import { formatToolTargetPath } from "@src/util/file/repoPathDisplay";
import { getToolDisplayLabelFromRegistry } from "@src/util/ui/rendering/registryToolLabel";

import ExploreBlock from "../../blocks/ExploreBlock";
import ListDirBlock from "../../blocks/ListDirBlock";
import { extractResultText } from "../../blocks/ToolCallBlock/helpers";
import { FailedEventRow } from "../../blocks/primitives";

const BRACKETED_DIR_RE = /^\[dir\]\s+(.+)$/i;
const BRACKETED_FILE_RE = /^\[file\]\s+(.+)$/i;

/**
 * Matches the Rust `query_lsp` error format:
 *   "Failed to start LSP server for '<language>': <error>"
 * The language slug (e.g. "typescript") is what `lsp_get_install_command`
 * expects.
 */

interface DirEntry {
  name: string;
  isDirectory: boolean;
}

function parseTextEntries(text: string): DirEntry[] {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) return [];

  const entries: DirEntry[] = [];
  let hasBracketFormat = false;

  for (const line of lines) {
    const trimmed = line.trim();
    const dirMatch = BRACKETED_DIR_RE.exec(trimmed);
    if (dirMatch) {
      hasBracketFormat = true;
      entries.push({ name: dirMatch[1].trim(), isDirectory: true });
      continue;
    }
    const fileMatch = BRACKETED_FILE_RE.exec(trimmed);
    if (fileMatch) {
      hasBracketFormat = true;
      entries.push({ name: fileMatch[1].trim(), isDirectory: false });
      continue;
    }
  }

  if (hasBracketFormat) return entries;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.endsWith("/")) {
      entries.push({ name: trimmed.slice(0, -1), isDirectory: true });
    } else {
      entries.push({ name: trimmed, isDirectory: false });
    }
  }

  return entries;
}

function parseToolSearchEntries(text: string): DirEntry[] {
  return text
    .split("\n")
    .map((line) =>
      line
        .trim()
        .match(/^\*\*([^*]+)\*\*/)?.[1]
        ?.trim()
    )
    .filter((name): name is string => Boolean(name))
    .map((name) => ({ name, isDirectory: false }));
}

function extractListDirData(props: UniversalEventProps) {
  const { args, result } = props;

  if (props.eventType === "tool_search") {
    const textSources = [
      result?.output,
      result?.content,
      result?.observation,
    ].filter(
      (source): source is string =>
        typeof source === "string" && source.trim().length > 0
    );
    const entries = textSources.flatMap(parseToolSearchEntries);
    return {
      directory: (args?.query as string) || ".",
      entries,
      contentSummary: undefined,
    };
  }

  if (props.rustExtracted?.kind === "listDir") {
    const extracted = props.rustExtracted;
    return {
      directory: extracted.directory,
      entries: extracted.entries.map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory,
      })),
      contentSummary: extracted.contentSummary,
    };
  }

  const directory =
    (args?.target_directory as string) ||
    (args?.targetDirectory as string) ||
    (args?.path as string) ||
    (args?.dir as string) ||
    (args?.dir_path as string) ||
    (args?.file_path as string) ||
    ".";

  let entries: DirEntry[] = [];

  const outputObj = result?.output as Record<string, unknown> | undefined;
  const successObj = outputObj?.success as Record<string, unknown> | undefined;
  const directoryTreeRoot = successObj?.directoryTreeRoot as
    | Record<string, unknown>
    | undefined;

  if (directoryTreeRoot) {
    const rootPath = directoryTreeRoot.absPath as string;
    const childrenFiles = directoryTreeRoot.childrenFiles as
      | Array<Record<string, unknown>>
      | undefined;
    const childrenDirs = directoryTreeRoot.childrenDirs as
      | Array<Record<string, unknown>>
      | undefined;

    if (Array.isArray(childrenFiles)) {
      for (const file of childrenFiles) {
        const name = file.name as string;
        if (name) entries.push({ name, isDirectory: false });
      }
    }

    if (Array.isArray(childrenDirs)) {
      for (const dir of childrenDirs) {
        const dirPath = dir.absPath as string;
        if (dirPath) {
          const name = dirPath.split("/").pop() || dirPath;
          entries.push({ name, isDirectory: true });
        }
      }
    }
    return {
      directory: rootPath || directory,
      entries,
      contentSummary: undefined,
    };
  }

  const rawEntries = result?.output || result?.entries || result?.files || [];
  const entriesArray = Array.isArray(rawEntries) ? rawEntries : [];

  entries = entriesArray.map((entry) => {
    if (typeof entry === "string") {
      const isDir = entry.endsWith("/");
      return { name: isDir ? entry.slice(0, -1) : entry, isDirectory: isDir };
    }
    const obj = entry as Record<string, unknown>;
    return {
      name: (obj.name as string) || "",
      isDirectory: Boolean(
        obj.is_directory || obj.isDirectory || obj.type === "directory"
      ),
    };
  });

  if (entries.length === 0 && typeof result?.content === "string") {
    const parsed = parseTextEntries(result.content as string);
    if (parsed.length > 0) entries = parsed;
  }

  if (entries.length === 0 && typeof result?.observation === "string") {
    const parsed = parseTextEntries(result.observation as string);
    if (parsed.length > 0) entries = parsed;
  }

  const contentSummary =
    entries.length === 0 && typeof result?.content === "string"
      ? (result.content as string)
      : undefined;

  return { directory, entries, contentSummary };
}

export const ExploreAdapter: React.FC<UniversalEventProps> = (props) => {
  const exploreAction = (props.args?.action as string) || undefined;
  const labels = useLifecycleLabels(props.eventType, exploreAction);
  const state = statusToLifecycle(props.status);

  // Adapter-resolved title: prefer Rust lifecycle labels, fall back to
  // `formatToolName` so unregistered external tools still show a
  // human-readable header instead of an empty slot.
  const title =
    labels[state] ||
    getToolDisplayLabelFromRegistry(props.eventType, exploreAction);

  // On failure we skip the full ExploreBlock and render a compact
  // title-only row (muted icon + translated "Failed to …" label). The
  // expanded body has no meaningful output on failure, and the shimmering
  // header is misleading once the call resolves.
  if (state === "failed") {
    const detail = extractResultText(props.result);
    return (
      <FailedEventRow
        toolName={props.eventType}
        action={exploreAction}
        label={title}
        detail={detail}
        eventId={props.eventId}
      />
    );
  }

  const toolName = props.functionName || props.eventType;
  const isLoading =
    props.status === "running" && props.showActiveEventPainting === true;

  // `list_dir` renders as a single header row (like Search / Glob). The
  // expanded directory listing is reachable in the simulator's Files tab.
  if (props.eventType === "list_dir" || props.eventType === "tool_search") {
    const { directory } = extractListDirData(props);
    const targetLabel =
      props.eventType === "tool_search"
        ? (props.args?.query as string) || undefined
        : formatToolTargetPath({
            args: props.args,
            repoPath: props.repoPath,
            pathKeys: [
              "target_directory",
              "targetDirectory",
              "dir",
              "dir_path",
              "path",
            ],
          });
    return (
      <div
        data-tool-call-event-id={props.eventId}
        data-tool-call-name={toolName}
      >
        <ListDirBlock
          dirPath={directory}
          isLoading={isLoading}
          eventId={props.eventId}
          title={title}
          targetPath={targetLabel}
          toolUsage={props.toolUsage}
        />
      </div>
    );
  }

  const { directory, entries, contentSummary } = extractListDirData(props);
  const dirs = entries
    .filter((entry) => entry.isDirectory)
    .map((entry) => entry.name);
  const files = entries
    .filter((entry) => !entry.isDirectory)
    .map((entry) => entry.name);

  return (
    <div data-tool-call-event-id={props.eventId} data-tool-call-name={toolName}>
      <ExploreBlock
        dirPath={directory}
        dirs={dirs}
        files={files}
        rawOutput={contentSummary}
        isLoading={isLoading}
        isFailed={false}
        defaultCollapsed={true}
        eventId={props.eventId}
        title={title}
        toolName={props.eventType}
        action={exploreAction}
        toolUsage={props.toolUsage}
        // `query_lsp` is routed through CbExplore but its "entries" are
        // diagnostic text lines (e.g. `L43:36 [hint] ...`), not real files.
        // Suppress the leading file-type icon so rows render as plain text.
        hideEntryIcons={props.eventType === "query_lsp"}
      />
    </div>
  );
};

ExploreAdapter.displayName = "ExploreAdapter";

export default ExploreAdapter;
