import {
  ROUTINE_CATCH_UP_POLICY,
  ROUTINE_CONCURRENCY_POLICY,
  ROUTINE_OUTPUT_MODE,
  type RoutineCatchUpPolicy,
  type RoutineConcurrencyPolicy,
  type RoutineDefinition,
  type RoutineOutputMode,
  type RoutineRunTarget,
  type RoutineWorkspaceTarget,
} from "@src/api/http/project";
import { parseCron } from "@src/modules/ProjectManager/WorkItems/components/ScheduleEditor/cronUtils";

const ROUTINE_TRIGGER_KIND = {
  ONE_TIME: "one_time",
  CRON: "cron",
} as const;

export const ROUTINE_TARGET_KIND = {
  AGENT_DEFINITION: "agent_definition",
  AGENT_ORG: "agent_org",
} as const;

const ROUTINE_WORKSPACE_KIND = {
  NONE: "none",
  LOCAL_WORKSPACE: "local_workspace",
  WORKTREE: "worktree",
} as const;

/**
 * Stored representation of the consolidated "Agent responsible" selection.
 * Mirrors the two shapes of `RoutineRunTarget` so save-time mapping is a
 * trivial passthrough.
 */
type RoutineAgentTarget =
  | {
      kind: typeof ROUTINE_TARGET_KIND.AGENT_DEFINITION;
      agentDefinitionId: string;
    }
  | { kind: typeof ROUTINE_TARGET_KIND.AGENT_ORG; agentOrgId: string };

export interface RoutineDraft {
  name: string;
  description: string;
  enabled: boolean;
  triggerKind: keyof typeof ROUTINE_TRIGGER_KIND;
  at: string;
  cron: string;
  /** IANA timezone used to evaluate the cron schedule. */
  timezone: string;
  /** Whether the user is typing a raw cron instead of using the builder. */
  customCron: boolean;
  /** Consolidated "Agent responsible for this routine" — agent def or org. */
  target: RoutineAgentTarget | null;
  /** Display label for the agent trigger row (built-in name or custom). */
  targetLabel: string;
  /** Icon id for the agent trigger row (matches `AgentDefinition.iconId`). */
  targetIconId?: string;
  /** Whether the selection is an org (drives the trigger icon). */
  targetIsOrg: boolean;
  prompt: string;
  workspaceKind: keyof typeof ROUTINE_WORKSPACE_KIND;
  workspacePath: string;
  /** Display name for the workspace trigger row. */
  workspaceLabel: string;
  branch: string;
  mode: string;
  model: string;
  accountId: string;
  /** Display label for the model trigger row. */
  modelLabel: string;
  /** Provider/model type for the model trigger icon. */
  modelType?: string;
  outputMode: RoutineOutputMode;
  concurrencyPolicy: RoutineConcurrencyPolicy;
  catchUpPolicy: RoutineCatchUpPolicy;
  createWorkItemProjectSlug: string;
  autoStart: boolean;
  updateWorkItemProjectSlug: string;
  updateWorkItemShortId: string;
}

export interface RoutineProjectOption {
  slug: string;
  name: string;
}

export type UpdateRoutineDraft = <Key extends keyof RoutineDraft>(
  key: Key,
  value: RoutineDraft[Key]
) => void;

/** file:// URIs land in `RepoItem.fs_uri`; the wire format wants a plain path. */
export function normalizeFsUri(uri: string | undefined): string {
  if (!uri) return "";
  const stripped = uri.startsWith("file://")
    ? uri.slice("file://".length)
    : uri;
  return stripped.replace(/\/+$/, "");
}

function isoForInput(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 16);
}

function inputToIso(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return new Date().toISOString();
  return date.toISOString();
}

export function createRoutineDraft(
  routine?: RoutineDefinition,
  defaultTimezone = "utc"
): RoutineDraft {
  const isCron = routine?.trigger.kind === ROUTINE_TRIGGER_KIND.CRON;
  const target = routine?.runTemplate.target;
  const workspace = routine?.runTemplate.workspace;
  const workspacePath =
    workspace?.kind === ROUTINE_WORKSPACE_KIND.LOCAL_WORKSPACE ||
    workspace?.kind === ROUTINE_WORKSPACE_KIND.WORKTREE
      ? workspace.workspacePath
      : "";

  let storedTarget: RoutineAgentTarget | null = null;
  if (target?.kind === ROUTINE_TARGET_KIND.AGENT_ORG) {
    storedTarget = {
      kind: ROUTINE_TARGET_KIND.AGENT_ORG,
      agentOrgId: target.agentOrgId,
    };
  } else if (
    target?.kind === ROUTINE_TARGET_KIND.AGENT_DEFINITION &&
    target.agentDefinitionId
  ) {
    storedTarget = {
      kind: ROUTINE_TARGET_KIND.AGENT_DEFINITION,
      agentDefinitionId: target.agentDefinitionId,
    };
  }

  const existingCron =
    routine?.trigger.kind === ROUTINE_TRIGGER_KIND.CRON
      ? routine.trigger.cron
      : "";

  return {
    name: routine?.name ?? "",
    description: routine?.description ?? "",
    enabled: routine?.enabled ?? true,
    triggerKind: isCron ? "CRON" : "ONE_TIME",
    at:
      routine?.trigger.kind === ROUTINE_TRIGGER_KIND.ONE_TIME
        ? isoForInput(routine.trigger.at)
        : "",
    cron: existingCron,
    timezone:
      routine?.trigger.kind === ROUTINE_TRIGGER_KIND.CRON
        ? routine.trigger.timezone.toLowerCase() === "utc"
          ? "utc"
          : routine.trigger.timezone
        : defaultTimezone,
    customCron: existingCron !== "" && parseCron(existingCron) === null,
    target: storedTarget,
    targetLabel: "",
    targetIconId: undefined,
    targetIsOrg: storedTarget?.kind === ROUTINE_TARGET_KIND.AGENT_ORG,
    prompt: routine?.runTemplate.prompt ?? "",
    workspaceKind:
      workspace?.kind === ROUTINE_WORKSPACE_KIND.WORKTREE
        ? "WORKTREE"
        : workspace?.kind === ROUTINE_WORKSPACE_KIND.LOCAL_WORKSPACE
          ? "LOCAL_WORKSPACE"
          : "NONE",
    workspacePath,
    workspaceLabel: workspacePath,
    branch:
      workspace?.kind === ROUTINE_WORKSPACE_KIND.WORKTREE
        ? (workspace.branch ?? "")
        : "",
    mode: routine?.runTemplate.mode ?? "build",
    model: routine?.runTemplate.resources.model ?? "",
    accountId: routine?.runTemplate.resources.accountId ?? "",
    modelLabel: routine?.runTemplate.resources.model ?? "",
    modelType: undefined,
    outputMode:
      routine?.outputPolicy.mode ?? ROUTINE_OUTPUT_MODE.DIRECT_SESSION,
    concurrencyPolicy:
      routine?.outputPolicy.concurrencyPolicy ??
      ROUTINE_CONCURRENCY_POLICY.COALESCE_IF_ACTIVE,
    catchUpPolicy:
      routine?.outputPolicy.catchUpPolicy ?? ROUTINE_CATCH_UP_POLICY.RUN_ONCE,
    createWorkItemProjectSlug:
      routine?.outputPolicy.createWorkItemProjectSlug ?? "",
    autoStart: routine?.outputPolicy.autoStart ?? true,
    updateWorkItemProjectSlug:
      routine?.outputPolicy.updateWorkItemProjectSlug ?? "",
    updateWorkItemShortId: routine?.outputPolicy.updateWorkItemShortId ?? "",
  };
}

export function isRoutineDraftValid(draft: RoutineDraft): boolean {
  const outputConfigValid =
    draft.outputMode === ROUTINE_OUTPUT_MODE.UPDATE_EXISTING_WORK_ITEM
      ? draft.updateWorkItemProjectSlug.trim() !== "" &&
        draft.updateWorkItemShortId.trim() !== ""
      : true;

  return (
    draft.name.trim() !== "" &&
    draft.prompt.trim() !== "" &&
    draft.target !== null &&
    (draft.triggerKind === "CRON"
      ? draft.cron.trim() !== ""
      : draft.at.trim() !== "") &&
    (draft.workspaceKind === "NONE" || draft.workspacePath.trim() !== "") &&
    outputConfigValid
  );
}

export function createRoutineDefinition(
  draft: RoutineDraft,
  existingRoutine: RoutineDefinition | undefined,
  updatedAt: string
): RoutineDefinition {
  if (!draft.target) {
    throw new Error("A routine target is required before saving");
  }

  const trigger =
    draft.triggerKind === "CRON"
      ? {
          kind: ROUTINE_TRIGGER_KIND.CRON,
          cron: draft.cron.trim(),
          timezone:
            draft.timezone.toLowerCase() === "utc" ? "UTC" : draft.timezone,
        }
      : { kind: ROUTINE_TRIGGER_KIND.ONE_TIME, at: inputToIso(draft.at) };

  const target: RoutineRunTarget =
    draft.target.kind === ROUTINE_TARGET_KIND.AGENT_ORG
      ? {
          kind: ROUTINE_TARGET_KIND.AGENT_ORG,
          agentOrgId: draft.target.agentOrgId,
        }
      : {
          kind: ROUTINE_TARGET_KIND.AGENT_DEFINITION,
          agentDefinitionId: draft.target.agentDefinitionId,
        };

  const workspace: RoutineWorkspaceTarget =
    draft.workspaceKind === "WORKTREE"
      ? {
          kind: ROUTINE_WORKSPACE_KIND.WORKTREE,
          workspacePath: draft.workspacePath.trim(),
          branch: draft.branch.trim() || undefined,
          createIsolated: true,
          additionalDirectories: [],
        }
      : draft.workspaceKind === "LOCAL_WORKSPACE"
        ? {
            kind: ROUTINE_WORKSPACE_KIND.LOCAL_WORKSPACE,
            workspacePath: draft.workspacePath.trim(),
            additionalDirectories: [],
          }
        : { kind: ROUTINE_WORKSPACE_KIND.NONE };

  return {
    id: existingRoutine?.id ?? "",
    name: draft.name.trim(),
    description: draft.description.trim(),
    enabled: draft.enabled,
    trigger,
    runTemplate: {
      prompt: draft.prompt.trim(),
      target,
      resources: {
        model: draft.model.trim() || undefined,
        accountId: draft.accountId.trim() || undefined,
      },
      workspace,
      mode: draft.mode.trim() || undefined,
      name: draft.name.trim(),
    },
    outputPolicy: {
      mode: draft.outputMode,
      concurrencyPolicy: draft.concurrencyPolicy,
      catchUpPolicy: draft.catchUpPolicy,
      maxCatchUpRuns: existingRoutine?.outputPolicy.maxCatchUpRuns ?? 1,
      idempotencyScope:
        existingRoutine?.outputPolicy.idempotencyScope ?? "routine_fire",
      createWorkItemStatus:
        existingRoutine?.outputPolicy.createWorkItemStatus ?? "planned",
      createWorkItemProjectSlug:
        draft.outputMode === ROUTINE_OUTPUT_MODE.CREATE_WORK_ITEM
          ? draft.createWorkItemProjectSlug.trim() || undefined
          : existingRoutine?.outputPolicy.createWorkItemProjectSlug,
      createWorkItemTitle: existingRoutine?.outputPolicy.createWorkItemTitle,
      createWorkItemBody: existingRoutine?.outputPolicy.createWorkItemBody,
      autoStart: draft.autoStart,
      updateWorkItemShortId:
        draft.outputMode === ROUTINE_OUTPUT_MODE.UPDATE_EXISTING_WORK_ITEM
          ? draft.updateWorkItemShortId.trim() || undefined
          : undefined,
      updateWorkItemProjectSlug:
        draft.outputMode === ROUTINE_OUTPUT_MODE.UPDATE_EXISTING_WORK_ITEM
          ? draft.updateWorkItemProjectSlug.trim() || undefined
          : undefined,
    },
    createdAt: existingRoutine?.createdAt ?? updatedAt,
    updatedAt,
  };
}
