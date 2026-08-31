import { DISPATCH_CATEGORY } from "@src/api/tauri/session";
import type { CliAgentType } from "@src/api/types/keys";
import type { AgentSelection } from "@src/scaffold/GlobalSpotlight/palettes/DispatchCategoryPalette";
import { SESSION_TARGET_KIND } from "@src/store/session/creatorStateAtom";

import {
  CLI_AVAILABILITY,
  MULTI_RUNNER_LAUNCH_ERROR,
  MULTI_RUNNER_MAX,
  MULTI_RUNNER_PROMPT_MAX_LENGTH,
  RUNNER_BLOCKER,
  type Runner,
  applyAgentSelection,
  canAddRunner,
  canLaunchGroup,
  canRemoveRunner,
  createRunner,
  hasAgentSelected,
  isMultiRunnerCategory,
  partitionRunners,
  resolveRunnerBlocker,
  resolveRunnerConfig,
  validateMultiRunnerLaunch,
} from "./contract";

const CLAUDE_CODE = "claude_code" as CliAgentType;
const CODEX = "codex" as CliAgentType;

function cliRunner(overrides: Partial<Runner> = {}): Runner {
  return {
    id: overrides.id ?? "runner-1",
    dispatchCategory: DISPATCH_CATEGORY.CLI_AGENT,
    cliAgentType: CLAUDE_CODE,
    runtimeConfig: { model: "opus-5" },
    ...overrides,
  };
}

const ALL_AVAILABLE = () => CLI_AVAILABILITY.OK;

describe("runner list bounds", () => {
  it("holds the floor at two — one runner is not a comparison", () => {
    expect(canRemoveRunner([cliRunner(), cliRunner({ id: "runner-2" })])).toBe(
      false
    );
    expect(
      canRemoveRunner([
        cliRunner(),
        cliRunner({ id: "runner-2" }),
        cliRunner({ id: "runner-3" }),
      ])
    ).toBe(true);
  });

  it("stops accepting runners at the cap", () => {
    const atCap = Array.from({ length: MULTI_RUNNER_MAX }, (_unused, index) =>
      cliRunner({ id: `runner-${index}` })
    );
    expect(canAddRunner(atCap.slice(0, MULTI_RUNNER_MAX - 1))).toBe(true);
    expect(canAddRunner(atCap)).toBe(false);
  });

  it("needs two eligible runners to launch a group", () => {
    expect(canLaunchGroup(0)).toBe(false);
    expect(canLaunchGroup(1)).toBe(false);
    expect(canLaunchGroup(2)).toBe(true);
  });
});

describe("createRunner", () => {
  it("mints distinct ids so the same harness can appear twice", () => {
    const first = createRunner({ cliAgentType: CLAUDE_CODE });
    const second = createRunner({ cliAgentType: CLAUDE_CODE });
    expect(first.id).not.toBe(second.id);
    expect(first.cliAgentType).toBe(second.cliAgentType);
  });

  it("starts with no harness selected when given no seed", () => {
    expect(hasAgentSelected(createRunner())).toBe(false);
  });
});

describe("supported categories", () => {
  it("accepts CLI and Rust agents and rejects the rest", () => {
    expect(isMultiRunnerCategory(DISPATCH_CATEGORY.CLI_AGENT)).toBe(true);
    expect(isMultiRunnerCategory(DISPATCH_CATEGORY.RUST_AGENT)).toBe(true);
    expect(isMultiRunnerCategory(DISPATCH_CATEGORY.CURSOR_IDE)).toBe(false);
    expect(isMultiRunnerCategory(DISPATCH_CATEGORY.HUMAN_SESSION)).toBe(false);
  });
});

describe("applyAgentSelection", () => {
  const selectCodex: AgentSelection = {
    category: DISPATCH_CATEGORY.CLI_AGENT,
    targetKind: SESSION_TARGET_KIND.AGENT,
    cliAgentType: CODEX,
    agentName: "Codex",
  };

  it("keeps the row identity when the harness changes", () => {
    const next = applyAgentSelection(cliRunner({ id: "row-9" }), selectCodex);
    expect(next.id).toBe("row-9");
    expect(next.cliAgentType).toBe(CODEX);
  });

  it("drops the model when the harness changes", () => {
    // Model catalogues are per harness: carrying Opus onto Codex would launch
    // that row against a model it cannot serve.
    const next = applyAgentSelection(cliRunner(), selectCodex);
    expect(next.runtimeConfig).toBeUndefined();
  });

  it("keeps the model when the same harness is re-picked", () => {
    const next = applyAgentSelection(cliRunner(), {
      ...selectCodex,
      cliAgentType: CLAUDE_CODE,
    });
    expect(next.runtimeConfig).toEqual({ model: "opus-5" });
  });

  it("falls back to a CLI row for a category that cannot fan out", () => {
    const next = applyAgentSelection(cliRunner(), {
      category: DISPATCH_CATEGORY.CURSOR_IDE,
      targetKind: SESSION_TARGET_KIND.AGENT,
      agentName: "Cursor IDE",
    });
    expect(next.dispatchCategory).toBe(DISPATCH_CATEGORY.CLI_AGENT);
  });
});

describe("resolveRunnerBlocker", () => {
  it("passes a fully configured, installed CLI runner", () => {
    expect(
      resolveRunnerBlocker({
        runner: cliRunner(),
        resolveCliAvailability: ALL_AVAILABLE,
      })
    ).toBeNull();
  });

  it("asks for a harness before anything else", () => {
    expect(
      resolveRunnerBlocker({
        runner: createRunner(),
        resolveCliAvailability: ALL_AVAILABLE,
      })
    ).toBe(RUNNER_BLOCKER.NO_AGENT);
  });

  it("asks for a model when neither the row nor the base config names one", () => {
    expect(
      resolveRunnerBlocker({
        runner: cliRunner({ runtimeConfig: undefined }),
        resolveCliAvailability: ALL_AVAILABLE,
      })
    ).toBe(RUNNER_BLOCKER.NO_MODEL);
  });

  it("never inherits a model from the launcher's global selection", () => {
    // The global model was chosen for whatever harness the Session launcher
    // last pointed at. Model catalogues are per harness, so inheriting it
    // would launch this row against a model its harness cannot serve.
    expect(
      resolveRunnerBlocker({
        runner: cliRunner({ runtimeConfig: undefined }),
        resolveCliAvailability: ALL_AVAILABLE,
      })
    ).toBe(RUNNER_BLOCKER.NO_MODEL);
  });

  it("asks about the harness before the model", () => {
    // A model question has no answer until the harness that scopes the model
    // list is settled.
    expect(
      resolveRunnerBlocker({
        runner: createRunner(),
        resolveCliAvailability: ALL_AVAILABLE,
      })
    ).toBe(RUNNER_BLOCKER.NO_AGENT);
  });

  it("reports a missing CLI before asking for a model", () => {
    expect(
      resolveRunnerBlocker({
        runner: cliRunner({ runtimeConfig: undefined }),
        resolveCliAvailability: () => CLI_AVAILABILITY.NOT_INSTALLED,
      })
    ).toBe(RUNNER_BLOCKER.CLI_NOT_INSTALLED);
  });

  it("accepts a hosted listing model as a model selection", () => {
    expect(
      resolveRunnerBlocker({
        runner: cliRunner({ runtimeConfig: { listingModel: "auto" } }),
        resolveCliAvailability: ALL_AVAILABLE,
      })
    ).toBeNull();
  });

  it("reports a missing CLI separately from a TUI-only CLI", () => {
    expect(
      resolveRunnerBlocker({
        runner: cliRunner(),
        resolveCliAvailability: () => CLI_AVAILABILITY.NOT_INSTALLED,
      })
    ).toBe(RUNNER_BLOCKER.CLI_NOT_INSTALLED);
    expect(
      resolveRunnerBlocker({
        runner: cliRunner(),
        resolveCliAvailability: () => CLI_AVAILABILITY.NO_GUI,
      })
    ).toBe(RUNNER_BLOCKER.CLI_NO_GUI);
  });

  it("never checks CLI availability for a Rust-native runner", () => {
    const blocker = resolveRunnerBlocker({
      runner: {
        id: "rust-1",
        dispatchCategory: DISPATCH_CATEGORY.RUST_AGENT,
        agentDefinitionId: "builtin:sde",
        runtimeConfig: { model: "opus-5" },
      },
      resolveCliAvailability: () => CLI_AVAILABILITY.NOT_INSTALLED,
    });
    expect(blocker).toBeNull();
  });
});

describe("partitionRunners", () => {
  it("keeps blocked rows out of the launch without dropping them", () => {
    const ready = cliRunner({ id: "ready" });
    const blocked = createRunner({
      dispatchCategory: DISPATCH_CATEGORY.CLI_AGENT,
    });
    blocked.id = "blocked";

    const { eligible, blocked: blockedRows } = partitionRunners(
      [ready, blocked],
      (runner) => (runner.id === "blocked" ? RUNNER_BLOCKER.NO_AGENT : null)
    );

    expect(eligible.map((runner) => runner.id)).toEqual(["ready"]);
    expect(blockedRows).toEqual([
      { runner: blocked, blocker: RUNNER_BLOCKER.NO_AGENT },
    ]);
  });
});

describe("validateMultiRunnerLaunch", () => {
  const VALID = {
    editorContent: "Fix the auth crash",
    repoId: "repo-1",
    eligibleCount: 2,
  };

  it("passes a prompt, a repo, and two eligible runners", () => {
    expect(validateMultiRunnerLaunch(VALID)).toEqual([]);
  });

  it("requires a prompt", () => {
    expect(
      validateMultiRunnerLaunch({ ...VALID, editorContent: "   " })
    ).toEqual([MULTI_RUNNER_LAUNCH_ERROR.NO_PROMPT]);
  });

  it("bounds the prompt length", () => {
    expect(
      validateMultiRunnerLaunch({
        ...VALID,
        editorContent: "x".repeat(MULTI_RUNNER_PROMPT_MAX_LENGTH + 1),
      })
    ).toEqual([MULTI_RUNNER_LAUNCH_ERROR.PROMPT_TOO_LONG]);
  });

  it("requires a repo, because every runner needs a worktree to be cut from", () => {
    expect(validateMultiRunnerLaunch({ ...VALID, repoId: undefined })).toEqual([
      MULTI_RUNNER_LAUNCH_ERROR.NO_REPO,
    ]);
    expect(validateMultiRunnerLaunch({ ...VALID, repoId: "  " })).toEqual([
      MULTI_RUNNER_LAUNCH_ERROR.NO_REPO,
    ]);
  });

  it("refuses to launch a group of one", () => {
    expect(validateMultiRunnerLaunch({ ...VALID, eligibleCount: 1 })).toEqual([
      MULTI_RUNNER_LAUNCH_ERROR.NOT_ENOUGH_RUNNERS,
    ]);
  });

  it("reports every group-level problem at once", () => {
    expect(
      validateMultiRunnerLaunch({
        editorContent: "",
        repoId: undefined,
        eligibleCount: 0,
      })
    ).toEqual([
      MULTI_RUNNER_LAUNCH_ERROR.NO_PROMPT,
      MULTI_RUNNER_LAUNCH_ERROR.NO_REPO,
      MULTI_RUNNER_LAUNCH_ERROR.NOT_ENOUGH_RUNNERS,
    ]);
  });

  it("does not look at the launcher's global model selection", () => {
    // The whole reason this exists instead of `useSessionValidation`: in multi
    // mode the global selection is hidden and each row owns its own model, so
    // validating it would reject a correctly configured group.
    expect(validateMultiRunnerLaunch(VALID)).toEqual([]);
  });
});

describe("resolveRunnerConfig", () => {
  it("carries the row's own harness onto the launch config", () => {
    expect(resolveRunnerConfig(cliRunner()).cliAgentType).toBe(CLAUDE_CODE);
  });

  it("leaves a Rust-native runner without a CLI agent type", () => {
    const config = resolveRunnerConfig({
      id: "rust-1",
      dispatchCategory: DISPATCH_CATEGORY.RUST_AGENT,
      agentDefinitionId: "builtin:sde",
      runtimeConfig: { model: "opus-5" },
    });
    expect(config.cliAgentType).toBeUndefined();
    expect(config.model).toBe("opus-5");
  });

  it("yields no model at all for a row that has not chosen one", () => {
    const config = resolveRunnerConfig(cliRunner({ runtimeConfig: undefined }));
    expect(config.model).toBeUndefined();
    expect(config.listingModel).toBeUndefined();
    expect(config.selectedAccountId).toBeUndefined();
  });

  it("passes the whole picked selection through, not just the model id", () => {
    const config = resolveRunnerConfig(
      cliRunner({
        runtimeConfig: {
          keySource: "hosted_key",
          model: "auto",
          listingModel: "auto",
          listingModelDisplay: "Auto (Standard)",
          tier: "standard",
          accountId: "acct-1",
          selectedSourceLabel: "Token Market",
        },
      })
    );
    // A model choice is inseparable from where it is billed: dropping the key
    // source or account would launch the row against the wrong credentials.
    expect(config).toMatchObject({
      keySource: "hosted_key",
      model: "auto",
      listingModel: "auto",
      listingModelDisplay: "Auto (Standard)",
      tier: "standard",
      selectedAccountId: "acct-1",
      selectedSourceLabel: "Token Market",
    });
  });
});
