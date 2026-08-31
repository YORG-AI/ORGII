/**
 * Multi-runner contract — one prompt fanned out to several harnesses.
 *
 * A **runner** is a complete, self-sufficient launch config: a harness plus the
 * model / account / tier that harness should run with. Multi-runner is its own
 * launcher surface (the Compare-runners entry under **More**), so the list is
 * never empty there — it seeds itself and refuses to drop below
 * `MULTI_RUNNER_MIN`, because one runner is not a comparison.
 *
 * Everything here is pure — no atoms, no React — so the eligibility rules that
 * gate a fan-out can be unit-tested without a store.
 */
import {
  DISPATCH_CATEGORY,
  type DispatchCategory,
} from "@src/api/tauri/session";
import type { CliAgentType } from "@src/api/types/keys";
import type { OrgMemberRuntimeConfig } from "@src/modules/MainApp/AgentOrgs/types";
import type { AgentSelection } from "@src/scaffold/GlobalSpotlight/palettes/DispatchCategoryPalette";

import { hasResolvedModel } from "../agentRuntimeConfig";
import type { AdvancedConfig } from "../types";

/**
 * Upper bound on runners in one group. Each runner is a real background
 * session on its own git worktree hitting a real provider, so the cap keeps
 * worktree churn and simultaneous provider bursts inside sane limits.
 */
export const MULTI_RUNNER_MAX = 6;

/** Fewest runners a comparison can consist of; also the seeded row count. */
export const MULTI_RUNNER_MIN = 2;

/**
 * Delay between consecutive launches in a fan-out. These hit N different
 * providers' auth and rate limits; a synchronous burst is the fastest way to
 * get one of them throttled.
 */
export const MULTI_RUNNER_LAUNCH_STAGGER_MS = 150;

/**
 * Dispatch categories a runner may use.
 *
 * `cursor_ide` hands off to an external editor and owns no ORGII-side process,
 * and `human_session` is not an agent — neither can accept a fanned-out prompt.
 */
export const MULTI_RUNNER_CATEGORIES: readonly DispatchCategory[] = [
  DISPATCH_CATEGORY.CLI_AGENT,
  DISPATCH_CATEGORY.RUST_AGENT,
];

/** Why a configured runner cannot take part in a launch. */
export const RUNNER_BLOCKER = {
  /** No harness picked yet (a freshly added, untouched row). */
  NO_AGENT: "no_agent",
  /** Harness picked but no model resolved for it. */
  NO_MODEL: "no_model",
  /** The selected CLI is not installed on this machine. */
  CLI_NOT_INSTALLED: "cli_not_installed",
  /**
   * The CLI is installed but runs TUI-only. A TUI launch opens a terminal on
   * the agent's bare command and never delivers the prompt programmatically,
   * so it cannot take part in "the same prompt to every runner".
   */
  CLI_NO_GUI: "cli_no_gui",
} as const;

export type RunnerBlocker =
  (typeof RUNNER_BLOCKER)[keyof typeof RUNNER_BLOCKER];

/** Whether a CLI harness can serve a fanned-out prompt on this machine. */
export const CLI_AVAILABILITY = {
  OK: "ok",
  NOT_INSTALLED: "not_installed",
  NO_GUI: "no_gui",
} as const;

export type CliAvailability =
  (typeof CLI_AVAILABILITY)[keyof typeof CLI_AVAILABILITY];

export interface Runner {
  /** Stable row identity — NOT the harness id, so the same harness can repeat. */
  id: string;
  dispatchCategory: DispatchCategory;
  /** Set when `dispatchCategory === "cli_agent"`. */
  cliAgentType?: CliAgentType;
  /** Set when `dispatchCategory === "rust_agent"`. */
  agentDefinitionId?: string;
  /** Per-runner model override folded over the global creator config. */
  runtimeConfig?: OrgMemberRuntimeConfig;
}

export function createRunner(seed: Partial<Omit<Runner, "id">> = {}): Runner {
  return {
    id: crypto.randomUUID(),
    dispatchCategory: seed.dispatchCategory ?? DISPATCH_CATEGORY.CLI_AGENT,
    cliAgentType: seed.cliAgentType,
    agentDefinitionId: seed.agentDefinitionId,
    runtimeConfig: seed.runtimeConfig,
  };
}

export function isMultiRunnerCategory(category: DispatchCategory): boolean {
  return MULTI_RUNNER_CATEGORIES.includes(category);
}

export function canAddRunner(runners: readonly Runner[]): boolean {
  return runners.length < MULTI_RUNNER_MAX;
}

/**
 * The last two rows cannot be removed.
 *
 * Deleting down to one runner would leave the Compare-runners surface showing
 * something that is not a comparison, with a permanently disabled launch
 * button and no way to tell why. Holding the floor at two keeps the surface
 * always launchable-in-principle; a row you no longer want gets its harness
 * swapped instead.
 */
export function canRemoveRunner(runners: readonly Runner[]): boolean {
  return runners.length > MULTI_RUNNER_MIN;
}

/** Build a runner from a harness-palette selection, preserving row identity. */
export function applyAgentSelection(
  runner: Runner,
  selection: AgentSelection
): Runner {
  const nextCategory = isMultiRunnerCategory(selection.category)
    ? selection.category
    : DISPATCH_CATEGORY.CLI_AGENT;
  const harnessChanged =
    nextCategory !== runner.dispatchCategory ||
    selection.cliAgentType !== runner.cliAgentType ||
    selection.agentDefinitionId !== runner.agentDefinitionId;
  return {
    ...runner,
    dispatchCategory: nextCategory,
    cliAgentType: selection.cliAgentType,
    agentDefinitionId: selection.agentDefinitionId,
    // A model chosen for the previous harness is meaningless for the new one:
    // model catalogues are scoped per harness, so carrying it over would
    // launch the row against a model that harness cannot serve.
    runtimeConfig: harnessChanged ? undefined : runner.runtimeConfig,
  };
}

export function hasAgentSelected(runner: Runner): boolean {
  return runner.dispatchCategory === DISPATCH_CATEGORY.CLI_AGENT
    ? Boolean(runner.cliAgentType)
    : Boolean(runner.agentDefinitionId);
}

/**
 * The launch config for one runner, built from the runner ALONE.
 *
 * It deliberately does not fall back to the launcher's global
 * `AdvancedConfig`. That global model was chosen for whatever harness the
 * Session launcher last pointed at, and model catalogues are scoped per
 * harness — inheriting it would show (and then launch) a row against a model
 * its harness cannot serve. A runner with no `runtimeConfig` has no model,
 * full stop, and `resolveRunnerBlocker` says so.
 *
 * This is also why the row asks for a harness before it offers a model: the
 * harness is what scopes the model list.
 */
export function resolveRunnerConfig(runner: Runner): AdvancedConfig {
  const runtimeConfig = runner.runtimeConfig;
  return {
    keySource: runtimeConfig?.keySource,
    selectedAccountId: runtimeConfig?.accountId,
    model: runtimeConfig?.model,
    nativeHarnessType: runtimeConfig?.nativeHarnessType,
    tier: runtimeConfig?.tier,
    listingModel: runtimeConfig?.listingModel,
    listingModelDisplay: runtimeConfig?.listingModelDisplay,
    listingModelType: runtimeConfig?.listingModelType,
    selectedSourceLabel: runtimeConfig?.selectedSourceLabel,
    selectedSourceModelType: runtimeConfig?.selectedSourceModelType,
    cliAgentType:
      runner.dispatchCategory === DISPATCH_CATEGORY.CLI_AGENT
        ? runner.cliAgentType
        : undefined,
  };
}

export interface RunnerEligibilityInput {
  runner: Runner;
  resolveCliAvailability: (cliAgentType: CliAgentType) => CliAvailability;
}

/**
 * Why this runner cannot launch, or `null` when it can.
 *
 * Ordered the way the row is filled in, harness first: which harness, then
 * whether that harness can actually run here, and only then its model. Asking
 * for a model before the harness is settled would be asking a question with no
 * answer — the harness is what scopes the model list — and asking for one
 * before knowing the CLI is installed wastes the choice.
 */
export function resolveRunnerBlocker({
  runner,
  resolveCliAvailability,
}: RunnerEligibilityInput): RunnerBlocker | null {
  if (!hasAgentSelected(runner)) return RUNNER_BLOCKER.NO_AGENT;

  if (
    runner.dispatchCategory === DISPATCH_CATEGORY.CLI_AGENT &&
    runner.cliAgentType !== undefined
  ) {
    const availability = resolveCliAvailability(runner.cliAgentType);
    if (availability === CLI_AVAILABILITY.NOT_INSTALLED) {
      return RUNNER_BLOCKER.CLI_NOT_INSTALLED;
    }
    if (availability === CLI_AVAILABILITY.NO_GUI) {
      return RUNNER_BLOCKER.CLI_NO_GUI;
    }
  }

  if (!hasResolvedModel(resolveRunnerConfig(runner))) {
    return RUNNER_BLOCKER.NO_MODEL;
  }

  return null;
}

/**
 * Split a runner list into what will launch and what will not.
 *
 * A blocked row never aborts its siblings — the whole point of a fan-out is
 * that one missing CLI does not cost you the other two runs.
 */
export function partitionRunners(
  runners: readonly Runner[],
  resolveBlocker: (runner: Runner) => RunnerBlocker | null
): {
  eligible: Runner[];
  blocked: Array<{ runner: Runner; blocker: RunnerBlocker }>;
} {
  const eligible: Runner[] = [];
  const blocked: Array<{ runner: Runner; blocker: RunnerBlocker }> = [];
  for (const runner of runners) {
    const blocker = resolveBlocker(runner);
    if (blocker === null) {
      eligible.push(runner);
    } else {
      blocked.push({ runner, blocker });
    }
  }
  return { eligible, blocked };
}

/**
 * A launch may proceed when at least two runners are eligible.
 *
 * One eligible runner is not a comparison; rather than silently degrading to a
 * single ordinary launch (which would quietly ignore the rows the user set
 * up), the launcher blocks and shows why each blocked row is blocked.
 */
export function canLaunchGroup(eligibleCount: number): boolean {
  return eligibleCount >= MULTI_RUNNER_MIN;
}

/** Same bound the single-launch validator enforces on the prompt. */
export const MULTI_RUNNER_PROMPT_MAX_LENGTH = 10_000;

/** What stops the whole group (as opposed to one row) from launching. */
export const MULTI_RUNNER_LAUNCH_ERROR = {
  NO_PROMPT: "no_prompt",
  PROMPT_TOO_LONG: "prompt_too_long",
  NO_REPO: "no_repo",
  NOT_ENOUGH_RUNNERS: "not_enough_runners",
} as const;

export type MultiRunnerLaunchError =
  (typeof MULTI_RUNNER_LAUNCH_ERROR)[keyof typeof MULTI_RUNNER_LAUNCH_ERROR];

/**
 * Group-level pre-flight.
 *
 * Deliberately NOT `useSessionValidation`. That validator checks the *global*
 * creator selection — provider, account, cliAgentType, market-key rules — and
 * in multi-runner mode those belong to each row, not to the launcher. Running
 * it here would reject a perfectly configured group because the launcher's own
 * (now hidden) single selection happened to be empty or set to Cursor IDE.
 * Per-row config is covered by `resolveRunnerBlocker`; what remains group-wide
 * is the prompt and the repo.
 *
 * The repo is required unconditionally: every runner is isolated into its own
 * git worktree, and there is nothing to cut a worktree from without one.
 */
export function validateMultiRunnerLaunch(input: {
  editorContent: string;
  repoId: string | undefined;
  eligibleCount: number;
}): MultiRunnerLaunchError[] {
  const errors: MultiRunnerLaunchError[] = [];
  if (input.editorContent.trim().length === 0) {
    errors.push(MULTI_RUNNER_LAUNCH_ERROR.NO_PROMPT);
  } else if (input.editorContent.length > MULTI_RUNNER_PROMPT_MAX_LENGTH) {
    errors.push(MULTI_RUNNER_LAUNCH_ERROR.PROMPT_TOO_LONG);
  }
  if (!input.repoId?.trim()) {
    errors.push(MULTI_RUNNER_LAUNCH_ERROR.NO_REPO);
  }
  if (!canLaunchGroup(input.eligibleCount)) {
    errors.push(MULTI_RUNNER_LAUNCH_ERROR.NOT_ENOUGH_RUNNERS);
  }
  return errors;
}
