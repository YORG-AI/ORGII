/**
 * orgtrack (`org2-pm`) envelope parser — turns the CLI's JSON envelope printed
 * on stdout into a navigable result card.
 */
import type { OrgtrackEnvelopeData } from "../../types";
import { asRecord, getString } from "./primitives";
import { parseWorkItem } from "./workItem";

const ORGTRACK_OP_LABELS: Record<string, string> = {
  "work.create": "Created work item",
  "work.update": "Updated work item",
  "work.transition": "Transitioned work item",
  "work.claim": "Claimed work item",
  "work.release": "Released work item",
  "work.assign": "Assigned work item",
  "work.note": "Noted work item",
  "project.create": "Created project",
  "project.update": "Updated project",
};

function inferOrgtrackOperation(command: string): string {
  const tokens = command.trim().split(/\s+/);
  const idx = tokens.findIndex((t) => t.endsWith("org2-pm") || t === "org2");
  if (idx < 0) return "";
  const noun = tokens[idx + 1];
  const verb = tokens[idx + 2];
  if (!noun || !verb) return noun ?? "";
  return `${noun}.${verb}`;
}

export interface OrgtrackEnvelopeContext {
  projectSlug?: string;
  projectName?: string;
  projectId?: string;
  orgId?: string;
}

function extractShellResult(
  args: Record<string, unknown>,
  result: Record<string, unknown>
): {
  command: string | null;
  stdout: string;
  exitCode: number | undefined;
} {
  const output = asRecord(result.output);
  const success = asRecord(output?.success) ?? asRecord(result.success);
  const failure = asRecord(output?.failure) ?? asRecord(result.failure);
  const payload = success ?? failure ?? result;
  const command =
    getString(args.command) ??
    getString(args.cmd) ??
    getString(payload.command) ??
    null;
  const stdout =
    getString(payload.stdout) ??
    getString(result.stdout) ??
    (typeof result.output === "string" ? result.output : null) ??
    getString(result.content) ??
    "";
  const rawExit =
    payload.exit_code ??
    payload.exitCode ??
    result.exit_code ??
    result.exitCode ??
    result.code;
  return {
    command,
    stdout,
    exitCode:
      typeof rawExit === "number"
        ? rawExit
        : success
          ? 0
          : failure
            ? -1
            : undefined,
  };
}

function parseScopeFlag(command: string): string | undefined {
  const match = command.match(
    /(?:^|\s)--scope(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s]+))/
  );
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function hasStandaloneFlag(command: string): boolean {
  return /(?:^|\s)--standalone(?:\s|$)/.test(command);
}

function parseTitleFlag(command: string): string | undefined {
  const match = command.match(
    /(?:^|\s)--title(?:=|\s+)(?:"([^"]*)"|'([^']*)'|([^\s|;&]+))/
  );
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function parseUpdatedWorkItemId(command: string): string | undefined {
  const match = command.match(
    /(?:^|\s)(?:[^\s/]*\/)?(?:org2-pm|org2)\s+work\s+update\s+(?:"([^"]+)"|'([^']+)'|([^\s|;&]+))/
  );
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function parseJsonStringPrefix(
  source: string,
  property: string
): string | undefined {
  const match = source.match(
    new RegExp('"' + property + '"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"')
  );
  if (!match) return undefined;
  try {
    return JSON.parse('"' + match[1] + '"') as string;
  } catch {
    return undefined;
  }
}

function parseTruncatedOrgtrackSuccess(
  command: string,
  stdout: string,
  exitCode: number | undefined,
  context: OrgtrackEnvelopeContext
): OrgtrackEnvelopeData | null {
  if (
    (exitCode !== undefined && exitCode !== 0) ||
    parseJsonStringPrefix(stdout, "apiVersion") !== "orgtrack/v1" ||
    !/"ok"\s*:\s*true/.test(stdout)
  ) {
    return null;
  }

  const operationId = inferOrgtrackOperation(command);
  if (!["work.create", "work.update"].includes(operationId)) return null;

  const shortId =
    parseJsonStringPrefix(stdout, "short_id") ??
    parseJsonStringPrefix(stdout, "filename") ??
    (operationId === "work.update"
      ? parseUpdatedWorkItemId(command)
      : undefined);
  if (!shortId) return null;

  const explicitProjectSlug = parseScopeFlag(command);
  const projectSlug = explicitProjectSlug ?? context.projectSlug;
  const projectContextMatches =
    !explicitProjectSlug || explicitProjectSlug === context.projectSlug;
  const isStandalone =
    hasStandaloneFlag(command) || (!projectSlug && !context.projectId);

  return {
    command,
    ok: true,
    operationId,
    operation: ORGTRACK_OP_LABELS[operationId] ?? operationId,
    exitCode: exitCode ?? 0,
    shortId,
    title:
      parseJsonStringPrefix(stdout, "title") ??
      parseTitleFlag(command) ??
      shortId,
    status: parseJsonStringPrefix(stdout, "status"),
    projectSlug: isStandalone ? undefined : projectSlug,
    projectName:
      isStandalone || !projectContextMatches ? undefined : context.projectName,
    projectId:
      isStandalone || !projectContextMatches ? undefined : context.projectId,
    orgId: context.orgId,
    isStandalone,
  };
}

export function parseOrgtrackEnvelope(
  args: Record<string, unknown>,
  result: Record<string, unknown>,
  context: OrgtrackEnvelopeContext = {}
): OrgtrackEnvelopeData | null {
  const shell = extractShellResult(args, result);
  const { command } = shell;
  if (!command || !/\borg2-pm\b|\borg2\b/.test(command)) return null;

  const trimmed = shell.stdout.trim();
  if (!trimmed.startsWith("{")) return null;

  let envelope: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object") return null;
    envelope = parsed as Record<string, unknown>;
  } catch {
    return parseTruncatedOrgtrackSuccess(
      command,
      trimmed,
      shell.exitCode,
      context
    );
  }
  if (envelope.apiVersion !== "orgtrack/v1") return null;

  const exitCode = shell.exitCode ?? (envelope.ok === true ? 0 : -1);
  const operationId = inferOrgtrackOperation(command);
  const operation = ORGTRACK_OP_LABELS[operationId] ?? operationId ?? "org2-pm";

  if (envelope.ok === true) {
    const data = (envelope.data ?? {}) as Record<string, unknown>;
    const fm = (data.frontmatter ?? {}) as Record<string, unknown>;
    const items = Array.isArray(data.items) ? data.items : null;
    // Project sessions bootstrap their root Work Item in the host before the
    // agent turn starts. The first visible mutation is therefore normally a
    // `work update`, not a `work create`. Preserve the canonical item for both
    // operations so either path can render the same navigable result card.
    const workItem = ["work.create", "work.update"].includes(operationId)
      ? parseWorkItem(envelope.data)
      : undefined;
    const explicitProjectSlug = parseScopeFlag(command);
    const projectSlug = explicitProjectSlug ?? context.projectSlug;
    const projectContextMatches =
      !explicitProjectSlug || explicitProjectSlug === context.projectSlug;
    const projectId =
      getString(fm.project) ??
      (projectContextMatches ? context.projectId : undefined);
    const isStandalone = workItem
      ? hasStandaloneFlag(command) || (!projectSlug && !projectId)
      : undefined;
    return {
      command,
      ok: true,
      operationId,
      operation,
      exitCode,
      shortId:
        (typeof fm.short_id === "string" ? fm.short_id : undefined) ??
        (typeof data.slug === "string" ? data.slug : undefined),
      title:
        (typeof fm.title === "string" ? fm.title : undefined) ??
        (typeof data.name === "string" ? data.name : undefined),
      status:
        (typeof fm.status === "string" ? fm.status : undefined) ??
        (typeof data.status === "string" ? data.status : undefined),
      itemCount: items ? items.length : undefined,
      workItem,
      projectSlug: isStandalone ? undefined : projectSlug,
      projectName:
        isStandalone || !projectContextMatches
          ? undefined
          : context.projectName,
      projectId: isStandalone ? undefined : projectId,
      orgId: context.orgId,
      isStandalone,
    };
  }

  const error = (envelope.error ?? {}) as Record<string, unknown>;
  return {
    command,
    ok: false,
    operationId,
    operation,
    exitCode,
    errorCode: typeof error.code === "string" ? error.code : undefined,
    errorMessage: typeof error.message === "string" ? error.message : undefined,
    retryable:
      typeof error.retryable === "boolean" ? error.retryable : undefined,
  };
}
