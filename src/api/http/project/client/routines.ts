/**
 * Routine definitions, fires, and the portable (orgtrack/v1) routine run
 * projections.
 */
import { invoke } from "@tauri-apps/api/core";

import { cachedRead, invalidateCache } from "../cache";
import type {
  RoutineDefinition,
  RoutineFire,
  RoutineFireResult,
} from "../types";

export async function listRoutines(): Promise<RoutineDefinition[]> {
  return cachedRead("__routines__:list", () => invoke("project_list_routines"));
}

export async function readRoutine(id: string): Promise<RoutineDefinition> {
  return cachedRead(`__routines__:${id}`, () =>
    invoke("project_read_routine", { id })
  );
}

export async function upsertRoutine(
  routine: RoutineDefinition
): Promise<RoutineDefinition> {
  const result = await invoke<RoutineDefinition>("project_upsert_routine", {
    routine,
  });
  invalidateCache("__routines__");
  return result;
}

export async function deleteRoutine(id: string): Promise<boolean> {
  const result = await invoke<boolean>("project_delete_routine", { id });
  invalidateCache("__routines__");
  return result;
}

export async function listRoutineFires(
  routineId: string
): Promise<RoutineFire[]> {
  return cachedRead(`__routines__:${routineId}:fires`, () =>
    invoke("project_list_routine_fires", { routineId })
  );
}

/** A row from `pm_routine_runs` (portable Routine domain, orgtrack/v1). */
export interface RoutineRunSummary {
  id: string;
  routineName: string;
  routineRevision: number;
  scopeId: string;
  status: string;
  rootWorkItemId?: string | null;
  createdBy?: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Per-run projection: run row + generated WorkItems' portable states. */
export interface RoutineRunStatus {
  id: string;
  routineName: string;
  routineRevision: number;
  snapshotHash: string;
  scopeId: string;
  status: string;
  rootWorkItemId?: string | null;
  workItems: Array<{
    shortId: string;
    title: string;
    status: string;
    portableState?: string | null;
  }>;
}

/** A row from `pm_routines` (portable Routine domain, orgtrack/v1). */
export interface PortableRoutineSummary {
  name: string;
  routineId: string;
  revision: number;
  enabled: boolean;
  specHash: string;
  updatedAt: number;
}

/** List portable routines by name. Backs the Webhooks management surface. */
export async function listPortableRoutines(): Promise<
  PortableRoutineSummary[]
> {
  return invoke("project_list_portable_routines", {});
}

/** List portable routine runs, newest first. Uncached: run status moves
 *  with work-item transitions, and the surface refetches on focus. */
export async function listRoutineRuns(options?: {
  scopeId?: string;
  limit?: number;
}): Promise<RoutineRunSummary[]> {
  return invoke("project_list_routine_runs", {
    scopeId: options?.scopeId ?? null,
    limit: options?.limit,
  });
}

export async function routineRunStatus(
  runId: string
): Promise<RoutineRunStatus> {
  return invoke("project_routine_run_status", { runId });
}

export async function fireRoutine(
  routineId: string
): Promise<RoutineFireResult> {
  const result = await invoke<RoutineFireResult>("project_fire_routine", {
    routineId,
  });
  invalidateCache("__routines__");
  invalidateCache(`__routines__:${routineId}:fires`);
  return result;
}
