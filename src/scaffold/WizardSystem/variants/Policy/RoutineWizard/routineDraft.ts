import {
  ROUTINE_CATCH_UP_POLICY,
  ROUTINE_CONCURRENCY_POLICY,
  ROUTINE_OUTPUT_MODE,
  type RoutineActivation,
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
  PROVIDER_EVENT: "provider_event",
  MANUAL: "manual",
} as const;

const ACTIVATION_TYPE_TO_TRIGGER_KIND: Record<
  RoutineActivation["type"],
  keyof typeof ROUTINE_TRIGGER_KIND
> = {
  schedule: "CRON",
  one_time: "ONE_TIME",
  provider_event: "PROVIDER_EVENT",
  manual: "MANUAL",
};

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

export const ACTIVATION_DRAFT_TYPES = [
  "schedule",
  "one_time",
  "provider_event",
  "manual",
] as const;

export interface ActivationDraft {
  key: string;
  type: (typeof ACTIVATION_DRAFT_TYPES)[number];
  cron: string;
  timezone: string;
  at: string;
  provider: string;
  eventKind: string;
}

export function createActivationDraft(
  type: ActivationDraft["type"] = "schedule"
): ActivationDraft {
  return {
    key: `activation-${Math.random().toString(36).slice(2, 10)}`,
    type,
    cron: "",
    timezone: "UTC",
    at: "",
    provider: "",
    eventKind: "",
  };
}

function activationToDraft(activation: RoutineActivation): ActivationDraft {
  const draft = createActivationDraft(activation.type);
  switch (activation.type) {
    case "schedule":
      return { ...draft, cron: activation.cron, timezone: activation.timezone };
    case "one_time":
      return { ...draft, at: isoForInput(activation.at) };
    case "provider_event":
      return {
        ...draft,
        provider: activation.provider,
        eventKind: activation.eventKind,
      };
    default:
      return draft;
  }
}

export function activationFromDraft(
  draft: ActivationDraft
): RoutineActivation | null {
  switch (draft.type) {
    case "schedule":
      return draft.cron.trim()
        ? {
            type: "schedule",
            cron: draft.cron.trim(),
            timezone: draft.timezone.trim() || "UTC",
          }
        : null;
    case "one_time":
      return draft.at.trim()
        ? { type: "one_time", at: inputToIso(draft.at) }
        : null;
    case "provider_event":
      return draft.provider.trim() && draft.eventKind.trim()
        ? {
            type: "provider_event",
            provider: draft.provider.trim(),
            eventKind: draft.eventKind.trim(),
          }
        : null;
    default:
      return { type: "manual" };
  }
}

export function isActivationDraftValid(draft: ActivationDraft): boolean {
  return activationFromDraft(draft) !== null;
}

export interface RoutineDraft {
  name: string;
  description: string;
  enabled: boolean;
  triggerKind: keyof typeof ROUTINE_TRIGGER_KIND;
  /** Portable activations beyond the primary trigger. */
  extraActivations: ActivationDraft[];
  at: string;
  cron: string;
  /** IANA timezone used to evaluate the cron schedule. */
  timezone: string;
  /** Primary provider-event activation fields. */
  provider: string;
  eventKind: string;
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

function primaryActivationOf(
  routine: RoutineDefinition | undefined
): RoutineActivation | undefined {
  const first = routine?.activations?.[0];
  if (first) return first;
  const trigger = routine?.trigger;
  if (!trigger) return undefined;
  return trigger.kind === ROUTINE_TRIGGER_KIND.CRON
    ? { type: "schedule", cron: trigger.cron, timezone: trigger.timezone }
    : { type: "one_time", at: trigger.at };
}

export function createRoutineDraft(
  routine?: RoutineDefinition,
  defaultTimezone = "utc"
): RoutineDraft {
  const primary = primaryActivationOf(routine);
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

  const existingCron = primary?.type === "schedule" ? primary.cron : "";

  return {
    name: routine?.name ?? "",
    description: routine?.description ?? "",
    enabled: routine?.enabled ?? true,
    triggerKind: primary
      ? ACTIVATION_TYPE_TO_TRIGGER_KIND[primary.type]
      : "ONE_TIME",
    extraActivations: (routine?.activations ?? [])
      .slice(1)
      .map(activationToDraft),
    at: primary?.type === "one_time" ? isoForInput(primary.at) : "",
    cron: existingCron,
    timezone:
      primary?.type === "schedule"
        ? primary.timezone.toLowerCase() === "utc"
          ? "utc"
          : primary.timezone
        : defaultTimezone,
    provider: primary?.type === "provider_event" ? primary.provider : "",
    eventKind: primary?.type === "provider_event" ? primary.eventKind : "",
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

function isPrimaryTriggerValid(draft: RoutineDraft): boolean {
  switch (draft.triggerKind) {
    case "CRON":
      return draft.cron.trim() !== "";
    case "ONE_TIME":
      return draft.at.trim() !== "";
    case "PROVIDER_EVENT":
      return draft.provider.trim() !== "" && draft.eventKind.trim() !== "";
    default:
      return true;
  }
}

export function primaryActivationFromDraft(
  draft: RoutineDraft
): RoutineActivation {
  switch (draft.triggerKind) {
    case "CRON":
      return {
        type: "schedule",
        cron: draft.cron.trim(),
        timezone:
          draft.timezone.toLowerCase() === "utc" ? "UTC" : draft.timezone,
      };
    case "ONE_TIME":
      return { type: "one_time", at: inputToIso(draft.at) };
    case "PROVIDER_EVENT":
      return {
        type: "provider_event",
        provider: draft.provider.trim(),
        eventKind: draft.eventKind.trim(),
      };
    default:
      return { type: "manual" };
  }
}

export function triggerFromActivations(
  activations: RoutineActivation[]
): RoutineDefinition["trigger"] {
  for (const activation of activations) {
    if (activation.type === "schedule") {
      return {
        kind: ROUTINE_TRIGGER_KIND.CRON,
        cron: activation.cron,
        timezone: activation.timezone,
      };
    }
    if (activation.type === "one_time") {
      return { kind: ROUTINE_TRIGGER_KIND.ONE_TIME, at: activation.at };
    }
  }
  return undefined;
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
    isPrimaryTriggerValid(draft) &&
    draft.extraActivations.every(isActivationDraftValid) &&
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

  const extraActivations = draft.extraActivations
    .map(activationFromDraft)
    .filter(
      (activation): activation is RoutineActivation => activation !== null
    );
  const activations = [primaryActivationFromDraft(draft), ...extraActivations];
  const trigger = triggerFromActivations(activations);

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
    activations,
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
