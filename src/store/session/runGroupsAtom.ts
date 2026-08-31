/**
 * Run-group registry — the frontend record of each multi-runner fan-out.
 *
 * Deliberately NOT a backend concept. A group's members are ordinary sessions;
 * the group only remembers which runner config produced which session so the
 * comparison surface can line them up. Modelling it as a synthetic
 * "coordinator session" (the approach the retired benchmark runner took) would
 * put a row in the sidebar that is not a conversation and force every session
 * list to special-case it.
 *
 * Persisted because the run-group tab is restorable: a tab that survives a
 * restart with no payload to render would be a dead pill.
 */
import { type Atom, atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { z } from "zod/v4";

import { RUNNER_BLOCKER } from "@src/features/SessionCreator/multiRunner/contract";
import {
  RUN_GROUP_MAX_STORED,
  RUN_OUTCOME,
  type RunGroup,
  type RunGroupEntry,
} from "@src/features/SessionCreator/multiRunner/runGroupContract";
import { createZodJsonStorage } from "@src/util/core/storage/zodStorage";

import { RunnerSchema } from "./multiRunnerAtom";

export const RUN_GROUPS_STORAGE_KEY = "orgii:runGroups:v1";

const RunGroupEntrySchema: z.ZodType<RunGroupEntry> = z.object({
  ordinal: z.number().int().positive(),
  outcome: z.union([
    z.literal(RUN_OUTCOME.LAUNCHED),
    z.literal(RUN_OUTCOME.FAILED),
    z.literal(RUN_OUTCOME.SKIPPED),
  ]),
  sessionId: z.string().optional(),
  error: z.string().optional(),
  blocker: z
    .union([
      z.literal(RUNNER_BLOCKER.NO_AGENT),
      z.literal(RUNNER_BLOCKER.NO_MODEL),
      z.literal(RUNNER_BLOCKER.CLI_NOT_INSTALLED),
      z.literal(RUNNER_BLOCKER.CLI_NO_GUI),
    ])
    .optional(),
  runner: RunnerSchema,
});

const RunGroupSchema: z.ZodType<RunGroup> = z.object({
  id: z.string().min(1),
  prompt: z.string(),
  createdAt: z.string(),
  repoPath: z.string().optional(),
  repoName: z.string().optional(),
  baseBranch: z.string().optional(),
  entries: z.array(RunGroupEntrySchema),
});

/**
 * Drop malformed groups rather than failing the whole store: one unreadable
 * group must not take the user's other comparisons with it.
 */
const StoredRunGroupsSchema: z.ZodType<Record<string, RunGroup>> = z
  .record(z.string(), z.unknown())
  .transform((entries) => {
    const valid: Record<string, RunGroup> = {};
    for (const [key, value] of Object.entries(entries)) {
      const parsed = RunGroupSchema.safeParse(value);
      if (parsed.success) {
        valid[key] = parsed.data;
      } else {
        console.warn(`[runGroups] dropped malformed stored group "${key}"`);
      }
    }
    return valid;
  });

export const runGroupsAtom = atomWithStorage<Record<string, RunGroup>>(
  RUN_GROUPS_STORAGE_KEY,
  {},
  createZodJsonStorage(StoredRunGroupsSchema, {
    onInvalid: (key, _rawValue, error) => {
      console.warn(`[runGroups] invalid stored payload for ${key}`, error);
    },
  }),
  { getOnInit: true }
);
runGroupsAtom.debugLabel = "runGroupsAtom";

/** Newest-first eviction so the registry cannot grow without bound. */
export function pruneRunGroups(
  groups: Record<string, RunGroup>
): Record<string, RunGroup> {
  const ordered = Object.values(groups).sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt)
  );
  if (ordered.length <= RUN_GROUP_MAX_STORED) return groups;
  return Object.fromEntries(
    ordered
      .slice(0, RUN_GROUP_MAX_STORED)
      .map((group) => [group.id, group] as const)
  );
}

export const upsertRunGroupAtom = atom(null, (get, set, group: RunGroup) => {
  set(
    runGroupsAtom,
    pruneRunGroups({ ...get(runGroupsAtom), [group.id]: group })
  );
});
upsertRunGroupAtom.debugLabel = "upsertRunGroupAtom";

/** Replace one entry in place — used when a failed runner is retried. */
export const replaceRunGroupEntryAtom = atom(
  null,
  (get, set, input: { groupId: string; entry: RunGroupEntry }) => {
    const group = get(runGroupsAtom)[input.groupId];
    if (!group) return;
    set(runGroupsAtom, {
      ...get(runGroupsAtom),
      [input.groupId]: {
        ...group,
        entries: group.entries.map((entry) =>
          entry.ordinal === input.entry.ordinal ? input.entry : entry
        ),
      },
    });
  }
);
replaceRunGroupEntryAtom.debugLabel = "replaceRunGroupEntryAtom";

export const removeRunGroupAtom = atom(null, (get, set, groupId: string) => {
  const { [groupId]: _removed, ...rest } = get(runGroupsAtom);
  set(runGroupsAtom, rest);
});
removeRunGroupAtom.debugLabel = "removeRunGroupAtom";

const _runGroupByIdCache = new Map<string, Atom<RunGroup | undefined>>();

/** Per-id atom so a group panel re-renders only for its own group. */
export function runGroupByIdAtom(groupId: string): Atom<RunGroup | undefined> {
  const cached = _runGroupByIdCache.get(groupId);
  if (cached) return cached;
  const derived = atom<RunGroup | undefined>(
    (get) => get(runGroupsAtom)[groupId]
  );
  derived.debugLabel = `runGroup:${groupId}`;
  _runGroupByIdCache.set(groupId, derived);
  return derived;
}
