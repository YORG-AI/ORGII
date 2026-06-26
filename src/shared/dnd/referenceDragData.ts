import {
  clearIssueDragStash,
  clearPrDragStash,
  getFreshIssueDragStash,
  getFreshPrDragStash,
  hasFreshReferenceDragStash,
} from "./dragSideChannel";

export type ReferenceDragType = "pr" | "issue";

export type PrReferencePayload = {
  prNumber: number;
  prTitle: string;
  prUrl: string;
  prStatus: string;
  sourceBranch?: string;
  targetBranch?: string;
  additions?: number;
  deletions?: number;
};

export type IssueReferencePayload = {
  issueNumber: number;
  issueTitle: string;
  issueUrl: string;
  issueState: string;
  labels?: string[];
  assignees?: string[];
  comments?: number;
};

export type ReferenceDragPayload = PrReferencePayload | IssueReferencePayload;

export interface ReferenceDragPillData {
  type: ReferenceDragType;
  rawData: string;
  payload: ReferenceDragPayload;
  pillPath: string;
  displayName: string;
  iconType: "pr" | "issue";
}

const REFERENCE_DRAG_MIME_TYPES: Record<ReferenceDragType, string> = {
  pr: "application/x-orgii-pr-reference",
  issue: "application/x-orgii-issue-reference",
};

export function hasReferenceDragData(types?: readonly string[]): boolean {
  return (
    hasFreshReferenceDragStash() ||
    Boolean(
      types?.includes(REFERENCE_DRAG_MIME_TYPES.pr) ||
      types?.includes(REFERENCE_DRAG_MIME_TYPES.issue)
    )
  );
}

export function getReferenceDragData(
  dataTransfer: DataTransfer,
  type: ReferenceDragType
): string {
  const data =
    dataTransfer.getData(REFERENCE_DRAG_MIME_TYPES[type]) ||
    getPlainTextReferenceDragData(dataTransfer, type);
  if (data) return data;

  const stash =
    type === "pr" ? getFreshPrDragStash() : getFreshIssueDragStash();
  return stash ? JSON.stringify(stash) : "";
}

export function getReferenceDragPillData(
  dataTransfer: DataTransfer
): ReferenceDragPillData | null {
  const prData = getReferenceDragData(dataTransfer, "pr");
  if (prData) return parseReferenceDragPillData("pr", prData);

  const issueData = getReferenceDragData(dataTransfer, "issue");
  if (issueData) return parseReferenceDragPillData("issue", issueData);

  return null;
}

export function clearReferenceDragData(type: ReferenceDragType): void {
  if (type === "pr") {
    clearPrDragStash();
  } else {
    clearIssueDragStash();
  }
}

function getPlainTextReferenceDragData(
  dataTransfer: DataTransfer,
  type: ReferenceDragType
): string {
  const text = dataTransfer.getData("text/plain");
  const prefix = `orgii-reference:${type}:`;
  return text.startsWith(prefix) ? text.slice(prefix.length) : "";
}

function parseReferenceDragPillData(
  type: ReferenceDragType,
  rawData: string
): ReferenceDragPillData | null {
  try {
    const rawPayload = JSON.parse(rawData) as Record<string, unknown>;
    return type === "pr"
      ? buildPrReferencePillData(rawData, rawPayload)
      : buildIssueReferencePillData(rawData, rawPayload);
  } catch {
    return null;
  }
}

function buildPrReferencePillData(
  rawData: string,
  rawPayload: Record<string, unknown>
): ReferenceDragPillData | null {
  const payload: PrReferencePayload = {
    prNumber: Number(rawPayload.prNumber),
    prTitle: String(rawPayload.prTitle ?? ""),
    prUrl: String(rawPayload.prUrl ?? ""),
    prStatus: String(rawPayload.prStatus ?? ""),
    sourceBranch:
      typeof rawPayload.sourceBranch === "string"
        ? rawPayload.sourceBranch
        : undefined,
    targetBranch:
      typeof rawPayload.targetBranch === "string"
        ? rawPayload.targetBranch
        : undefined,
    additions:
      typeof rawPayload.additions === "number"
        ? rawPayload.additions
        : undefined,
    deletions:
      typeof rawPayload.deletions === "number"
        ? rawPayload.deletions
        : undefined,
  };

  if (!payload.prNumber || !payload.prTitle) return null;

  return {
    type: "pr",
    rawData,
    payload,
    pillPath: `pr://${payload.prNumber}`,
    displayName: `#${payload.prNumber} ${payload.prTitle}`,
    iconType: "pr",
  };
}

function buildIssueReferencePillData(
  rawData: string,
  rawPayload: Record<string, unknown>
): ReferenceDragPillData | null {
  const payload: IssueReferencePayload = {
    issueNumber: Number(rawPayload.issueNumber),
    issueTitle: String(rawPayload.issueTitle ?? ""),
    issueUrl: String(rawPayload.issueUrl ?? ""),
    issueState: String(rawPayload.issueState ?? ""),
    labels: Array.isArray(rawPayload.labels)
      ? rawPayload.labels.map(String)
      : undefined,
    assignees: Array.isArray(rawPayload.assignees)
      ? rawPayload.assignees.map(String)
      : undefined,
    comments:
      typeof rawPayload.comments === "number" ? rawPayload.comments : undefined,
  };

  if (!payload.issueNumber || !payload.issueTitle) return null;

  return {
    type: "issue",
    rawData,
    payload,
    pillPath: `issue://${payload.issueNumber}`,
    displayName: `#${payload.issueNumber} ${payload.issueTitle}`,
    iconType: "issue",
  };
}
