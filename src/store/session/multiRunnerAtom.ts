/**
 * Multi-runner launcher state.
 *
 * The list belongs to the Compare-runners launcher surface, which seeds it on
 * arrival and holds it at `MULTI_RUNNER_MIN` rows or more.
 *
 * Persisted so a configured comparison survives an app restart, using the
 * zod-validated localStorage idiom (`localChannelsAtom` precedent): garbage
 * bytes hydrate to an empty list instead of crashing, and a single malformed
 * row degrades just that row.
 */
import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { z } from "zod/v4";

import {
  ModelTypeSchema,
  NativeHarnessTypeSchema,
} from "@src/api/tauri/rpc/schemas/validationEnums";
import { CliAgentTypeSchema } from "@src/api/tauri/rpc/schemas/validationEnums";
import { DISPATCH_CATEGORY, KEY_SOURCE } from "@src/api/tauri/session";
import {
  MULTI_RUNNER_MAX,
  type Runner,
  applyAgentSelection,
  canAddRunner,
  createRunner,
} from "@src/features/SessionCreator/multiRunner/contract";
import type { OrgMemberRuntimeConfig } from "@src/modules/MainApp/AgentOrgs/types";
import type { AgentSelection } from "@src/scaffold/GlobalSpotlight/palettes/DispatchCategoryPalette";
import { createZodJsonStorage } from "@src/util/core/storage/zodStorage";

import { saveDraft, sessionCreatorDraftAtom } from "./creatorDraftAtom";

export const MULTI_RUNNER_STORAGE_KEY = "orgii:multiRunner:v1";

export const AgentRuntimeConfigSchema: z.ZodType<OrgMemberRuntimeConfig> =
  z.object({
    keySource: z
      .union([z.literal(KEY_SOURCE.OWN), z.literal(KEY_SOURCE.HOSTED)])
      .optional(),
    accountId: z.string().optional(),
    model: z.string().optional(),
    nativeHarnessType: NativeHarnessTypeSchema.optional(),
    tier: z.string().optional(),
    listingModel: z.string().optional(),
    listingModelDisplay: z.string().optional(),
    listingModelType: ModelTypeSchema.optional(),
    selectedSourceLabel: z.string().optional(),
    selectedSourceModelType: ModelTypeSchema.optional(),
  });

export const RunnerSchema: z.ZodType<Runner> = z.object({
  id: z.string().min(1),
  dispatchCategory: z.union([
    z.literal(DISPATCH_CATEGORY.CLI_AGENT),
    z.literal(DISPATCH_CATEGORY.RUST_AGENT),
  ]),
  cliAgentType: CliAgentTypeSchema.optional(),
  agentDefinitionId: z.string().optional(),
  runtimeConfig: AgentRuntimeConfigSchema.optional(),
});

/** Tolerant list schema: drop malformed rows (logged), keep the rest. */
const StoredRunnersSchema: z.ZodType<Runner[]> = z
  .array(z.unknown())
  .transform((rows) =>
    rows.flatMap((row) => {
      const parsed = RunnerSchema.safeParse(row);
      if (!parsed.success) {
        console.warn("[multiRunner] dropped malformed stored runner", row);
        return [];
      }
      return [parsed.data];
    })
  )
  // A hand-edited store must not be able to exceed the launch cap.
  .transform((runners) => runners.slice(0, MULTI_RUNNER_MAX));

export const sessionCreatorRunnersAtom = atomWithStorage<Runner[]>(
  MULTI_RUNNER_STORAGE_KEY,
  [],
  createZodJsonStorage(StoredRunnersSchema, {
    onInvalid: (key, _rawValue, error) => {
      console.warn(`[multiRunner] invalid stored payload for ${key}`, error);
    },
  }),
  { getOnInit: true }
);
sessionCreatorRunnersAtom.debugLabel = "sessionCreatorRunnersAtom";

/** Append one runner, seeded from the launcher's current single selection. */
export const addRunnerAtom = atom(
  null,
  (get, set, seed: Partial<Omit<Runner, "id">> = {}) => {
    const runners = get(sessionCreatorRunnersAtom);
    if (!canAddRunner(runners)) return null;
    const runner = createRunner(seed);
    set(sessionCreatorRunnersAtom, [...runners, runner]);
    return runner.id;
  }
);
addRunnerAtom.debugLabel = "addRunnerAtom";

export const removeRunnerAtom = atom(null, (get, set, runnerId: string) => {
  set(
    sessionCreatorRunnersAtom,
    get(sessionCreatorRunnersAtom).filter((runner) => runner.id !== runnerId)
  );
});
removeRunnerAtom.debugLabel = "removeRunnerAtom";

/** Leave multi-runner mode; the launcher falls back to its single selection. */
export const clearRunnersAtom = atom(null, (_get, set) => {
  set(sessionCreatorRunnersAtom, []);
});
clearRunnersAtom.debugLabel = "clearRunnersAtom";

export const setRunnerAgentAtom = atom(
  null,
  (get, set, input: { runnerId: string; selection: AgentSelection }) => {
    set(
      sessionCreatorRunnersAtom,
      get(sessionCreatorRunnersAtom).map((runner) =>
        runner.id === input.runnerId
          ? applyAgentSelection(runner, input.selection)
          : runner
      )
    );
  }
);
setRunnerAgentAtom.debugLabel = "setRunnerAgentAtom";

export const setRunnerRuntimeConfigAtom = atom(
  null,
  (
    get,
    set,
    input: { runnerId: string; runtimeConfig: OrgMemberRuntimeConfig }
  ) => {
    set(
      sessionCreatorRunnersAtom,
      get(sessionCreatorRunnersAtom).map((runner) =>
        runner.id === input.runnerId
          ? { ...runner, runtimeConfig: input.runtimeConfig }
          : runner
      )
    );
  }
);
setRunnerRuntimeConfigAtom.debugLabel = "setRunnerRuntimeConfigAtom";

/**
 * Refill the launcher from a finished group: same prompt, same runners.
 *
 * This is how a group is re-run. Reconstructing the launcher rather than
 * re-launching in place means the user sees exactly what is about to run and
 * can fix whatever went wrong first — install the missing CLI, swap a model,
 * drop a runner — with the composer's normal attachment and context controls
 * available. Runner ids are minted fresh so restored rows cannot collide with
 * whatever the launcher already held.
 */
export const seedLauncherFromRunGroupAtom = atom(
  null,
  (_get, set, input: { prompt: string; runners: readonly Runner[] }) => {
    set(
      sessionCreatorRunnersAtom,
      input.runners
        .slice(0, MULTI_RUNNER_MAX)
        .map((runner) => ({ ...runner, id: crypto.randomUUID() }))
    );
    set(
      sessionCreatorDraftAtom,
      saveDraft({
        sessionName: "",
        editorContent: input.prompt,
        uploadedFiles: [],
      })
    );
  }
);
seedLauncherFromRunGroupAtom.debugLabel = "seedLauncherFromRunGroupAtom";
