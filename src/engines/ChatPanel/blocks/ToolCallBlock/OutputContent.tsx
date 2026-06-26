import {
  Bot,
  CheckCircle,
  Circle,
  Code2,
  Folder,
  LayoutList,
  Pencil,
  Plus,
  SearchX,
  Terminal,
  Trash2,
  XCircle,
} from "lucide-react";
import React from "react";

import FileTypeIcon from "@src/components/FileTypeIcon";
import { getDirectory, getFileName } from "@src/util/file/pathUtils";
import { formatRepoPathForDisplay } from "@src/util/file/repoPathDisplay";

import {
  BlockOutput,
  ComposerStackListRow,
  EventBlockExpandableStackList,
} from "../primitives";
import {
  AgentMessageCard,
  CommandResultCard,
  FileCard,
  ProjectCard,
  WebsiteCard,
  WorkItemCard,
} from "./cards";
import {
  BROWSER_SNAPSHOT_VISIBLE_LINES,
  DEFAULT_VISIBLE_LINES,
} from "./config";
import type {
  BackgroundJobRow,
  LspStatusOutputData,
  OutputContentProps,
  ProjectToolListRow,
  WorkspaceEntry,
  WorkspaceInfoRow,
} from "./types";

const VISIBLE_ITEMS = 6;

function ProjectToolChangeIcon({
  change,
}: {
  change: ProjectToolListRow["change"];
}) {
  if (change === "added") {
    return <Plus size={13} className="text-success-6" />;
  }
  if (change === "updated") {
    return <Pencil size={13} className="text-primary-6" />;
  }
  if (change === "deleted") {
    return <Trash2 size={13} className="text-danger-6" />;
  }
  return null;
}

const SearchFilesEmpty: React.FC = () => (
  <div className="flex items-center justify-center gap-2 px-3 py-3">
    <SearchX size={13} className="text-text-4" />
    <span className="chat-block-content text-text-3">No files found.</span>
  </div>
);

/** Highlight [ref=eN] annotations in browser snapshot text. */
function highlightSnapshotRefs(line: string): React.ReactNode {
  const parts = line.split(/(\[ref=e\d+\])/g);
  if (parts.length === 1) return line;

  return parts.map((part, idx) =>
    /^\[ref=e\d+\]$/.test(part) ? (
      <span key={idx} className="rounded bg-primary-6/15 px-0.5 text-primary-6">
        {part}
      </span>
    ) : (
      <React.Fragment key={idx}>{part}</React.Fragment>
    )
  );
}

// ============================================
// Styled sub-components
// ============================================

const ListWorkspacesOutput: React.FC<{ workspaces: WorkspaceEntry[] }> = ({
  workspaces,
}) => (
  <EventBlockExpandableStackList
    layout="body"
    items={workspaces}
    renderItem={(workspace) => (
      <ComposerStackListRow
        title={workspace.path}
        leading={
          workspace.kind === "git" ? (
            <Code2 size={14} className="shrink-0 text-primary-6" />
          ) : (
            <Folder size={14} className="shrink-0 text-primary-6" />
          )
        }
        primary={workspace.name}
      />
    )}
    getKey={(workspace) => workspace.path}
    visibleCount={VISIBLE_ITEMS}
  />
);

/**
 * Key/value rows for `manage_workspace` mutation actions
 * (add / clone / create / remove). Matches the `list` action's stack
 * geometry — no leading icon, label on the left, value right-aligned.
 * Labels and operation phrases are English literals (not localized).
 */
const WorkspaceInfoOutput: React.FC<{ rows: WorkspaceInfoRow[] }> = ({
  rows,
}) => (
  <EventBlockExpandableStackList
    layout="body"
    items={rows}
    renderItem={(row) => (
      <ComposerStackListRow
        title={row.value}
        leading={null}
        primary={row.label}
        secondary={row.value}
        variant="info"
      />
    )}
    getKey={(row) => row.key}
    visibleCount={VISIBLE_ITEMS}
  />
);

/**
 * Stack rows for `await_output(command=list)` — one row per background
 * job. Mirrors `ListWorkspacesOutput`: a leading icon (Terminal for shells,
 * Bot for subagents) plus `primary` / `secondary`. A tiny terminal-style
 * status glyph (Check / X / Terminal) sits at the right of the primary
 * label for quick status scanning. Labels and handle text are literal —
 * `ageLabel` is pre-formatted by the adapter so this component can stay
 * presentational.
 */
const JobListingOutput: React.FC<{ jobs: BackgroundJobRow[] }> = ({ jobs }) => (
  <EventBlockExpandableStackList
    layout="body"
    items={jobs}
    renderItem={(job) => {
      const kindIcon =
        job.jobKind === "shell" ? (
          <Terminal size={14} className="shrink-0 text-primary-6" />
        ) : (
          <Bot size={14} className="shrink-0 text-primary-6" />
        );
      const statusGlyph =
        job.status === "succeeded" ? (
          <CheckCircle size={12} className="text-green-500" />
        ) : job.status === "failed" ? (
          <XCircle size={12} className="text-red-400" />
        ) : null;
      const primary = statusGlyph ? (
        <span className="inline-flex items-center gap-1">
          {job.handle}
          {statusGlyph}
        </span>
      ) : (
        job.handle
      );
      return (
        <ComposerStackListRow
          title={job.label}
          leading={kindIcon}
          primary={primary}
          secondary={`${job.label} · ${job.ageLabel}`}
        />
      );
    }}
    getKey={(job) => job.handle}
    visibleCount={VISIBLE_ITEMS}
  />
);

const ProjectToolListOutput: React.FC<{ rows: ProjectToolListRow[] }> = ({
  rows,
}) => (
  <EventBlockExpandableStackList
    layout="body"
    items={rows}
    renderItem={(row) => {
      const trailing = row.change ? (
        <ProjectToolChangeIcon change={row.change} />
      ) : null;
      return (
        <ComposerStackListRow
          title={row.name}
          leading={<LayoutList size={14} className="shrink-0 text-primary-6" />}
          primary={row.name}
          trailing={trailing}
        />
      );
    }}
    getKey={(row, index) => `${row.name}:${index}`}
    visibleCount={VISIBLE_ITEMS}
  />
);

const LspStatusOutput: React.FC<{ data: LspStatusOutputData }> = ({ data }) => (
  <EventBlockExpandableStackList
    layout="body"
    items={data.rows}
    renderItem={(row) => {
      const isRunningRow = row.key === "running";
      const running = data.running === true;
      const leading = isRunningRow ? (
        running ? (
          <CheckCircle size={14} className="shrink-0 text-success-6" />
        ) : (
          <Circle size={14} className="shrink-0 text-text-4" />
        )
      ) : null;

      return (
        <ComposerStackListRow
          title={`${row.label}: ${row.value}`}
          leading={leading}
          primary={row.label}
          secondary={row.value}
          variant="info"
        />
      );
    }}
    getKey={(row, index) => `${row.key}:${index}`}
    visibleCount={VISIBLE_ITEMS}
  />
);

const SearchFilesOutput: React.FC<{ files: string[]; repoPath?: string }> = ({
  files,
  repoPath,
}) => (
  <EventBlockExpandableStackList
    layout="body"
    items={files}
    renderItem={(filePath) => {
      const display = formatRepoPathForDisplay({ path: filePath, repoPath });
      const displayPath = display.displayPath || filePath;
      const fileName = getFileName(displayPath);
      const dirPath = getDirectory(displayPath);
      const dir = dirPath
        ? `${dirPath}${displayPath.includes("\\") ? "\\" : "/"}`
        : "";

      return (
        <ComposerStackListRow
          title={display.title || filePath}
          leading={<FileTypeIcon fileName={fileName} size="small" />}
          primary={fileName}
          secondary={dir || undefined}
        />
      );
    }}
    getKey={(filePath) => filePath}
    visibleCount={VISIBLE_ITEMS}
    emptyContent={<SearchFilesEmpty />}
  />
);

const SearchNoResultOutput: React.FC<{ message: string }> = ({ message }) => (
  <div className="flex items-center justify-center gap-2 px-3 py-3">
    <SearchX size={13} className="text-text-4" />
    <span className="chat-block-content text-text-3">{message}</span>
  </div>
);

// ============================================
// Unified output content
// ============================================

const OutputContent: React.FC<OutputContentProps> = ({
  styledOutput,
  isBrowserSnapshot,
  resultContent,
  hasOutput,
  outputText,
  isError,
  hasResult,
  completedLabel,
  sessionId,
  eventId,
  payloadRef,
}) => (
  <>
    {styledOutput?.type === "workspaces" && (
      <ListWorkspacesOutput workspaces={styledOutput.workspaces} />
    )}
    {styledOutput?.type === "workspaceInfo" && (
      <WorkspaceInfoOutput rows={styledOutput.rows} />
    )}
    {styledOutput?.type === "jobListing" && (
      <JobListingOutput jobs={styledOutput.jobs} />
    )}
    {styledOutput?.type === "projectToolList" && (
      <ProjectToolListOutput rows={styledOutput.rows} />
    )}
    {styledOutput?.type === "lspStatus" && (
      <LspStatusOutput data={styledOutput.data} />
    )}
    {styledOutput?.type === "files" && (
      <SearchFilesOutput
        files={styledOutput.files}
        repoPath={styledOutput.repoPath}
      />
    )}
    {styledOutput?.type === "noResult" && (
      <SearchNoResultOutput message={styledOutput.message} />
    )}
    {styledOutput?.type === "fileCard" && <FileCard card={styledOutput.card} />}
    {styledOutput?.type === "websiteCard" && (
      <WebsiteCard card={styledOutput.card} />
    )}
    {styledOutput?.type === "workItemCard" && (
      <WorkItemCard card={styledOutput.card} />
    )}
    {styledOutput?.type === "projectCard" && (
      <ProjectCard card={styledOutput.card} />
    )}
    {styledOutput?.type === "commandResult" && (
      <CommandResultCard card={styledOutput.card} />
    )}
    {styledOutput?.type === "agentMessageCard" && (
      <AgentMessageCard card={styledOutput.card} />
    )}
    {!styledOutput && isBrowserSnapshot && (
      <BlockOutput
        output={resultContent}
        visibleLines={BROWSER_SNAPSHOT_VISIBLE_LINES}
        renderLine={highlightSnapshotRefs}
        withBorder={false}
        sessionId={sessionId}
        eventId={eventId}
        payloadRef={payloadRef}
      />
    )}
    {!styledOutput && hasOutput && !isBrowserSnapshot && (
      <BlockOutput
        output={outputText}
        visibleLines={DEFAULT_VISIBLE_LINES}
        isError={isError}
        status={isError ? "error" : "success"}
        withBorder={false}
        sessionId={sessionId}
        eventId={eventId}
        payloadRef={payloadRef}
      />
    )}
    {hasResult && !hasOutput && !styledOutput && (
      <div className="chat-block-content px-3 py-2 text-text-3">
        {completedLabel}
      </div>
    )}
  </>
);

export default OutputContent;
