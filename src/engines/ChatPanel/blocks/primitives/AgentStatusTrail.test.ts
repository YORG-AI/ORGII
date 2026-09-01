// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type AgentStatusTrailState,
  HIDDEN_AGENT_STATUS_TRAIL_STATE,
} from "@src/engines/ChatPanel/hooks/agentStatusTrailMath";
import {
  type SmokeRoot,
  createSmokeRoot,
  settle,
} from "@src/test/reactSmokeHarness";

import AgentStatusTrail from "./AgentStatusTrail";
import type { PlanningIndicatorMode } from "./chatActivityLabel";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      switch (key) {
        case "planning.statusTrail.agentWorking":
          return "Agent working";
        case "planning.statusTrail.agentWorkingFor":
          return `Agent working for ${options?.value}`;
        case "planning.statusTrail.runningTask":
          return `${options?.count} running task${options?.count === 1 ? "" : "s"}`;
        case "planning.statusTrail.idle":
          return "Agent is idle";
        case "planning.statusTrail.asking":
          return "Waiting for your reply";
        case "planning.statusTrail.lastRefreshed":
          return `Last refreshed ${options?.value}`;
        case "planning.agentTyping":
          return "Agent is typing...";
        case "planning.compacting":
          return "Compacting context...";
        case "planning.nextStepVariants":
          return ["Planning next step...", "Thinking it through..."];
        default:
          return key;
      }
    },
  }),
}));

// The glyph itself is `SessionIdentityIcon`'s job — it runs the same
// projection as the sidebar row. What the trail owns is delegating to it with
// the right session, and wrapping it in the phase's motion.
vi.mock("@src/engines/ChatPanel/components/SessionIdentityIcon", () => ({
  default: (props: { sessionId: string }) =>
    createElement("span", {
      "data-testid": "session-identity-icon",
      "data-session-id": props.sessionId,
    }),
}));

/** Fixed "now" so the elapsed readout is deterministic. */
const NOW_MS = 1_800_000_000_000;

function state(
  overrides: Partial<AgentStatusTrailState>
): AgentStatusTrailState {
  return {
    phase: "running",
    startedAtMs: null,
    runningTasks: 0,
    isExternal: false,
    lastRefreshedAtMs: null,
    ...overrides,
  };
}

/** A round that started `elapsedMs` ago, relative to the pinned clock. */
function startedAgo(elapsedMs: number): number {
  return NOW_MS - elapsedMs;
}

let smoke: SmokeRoot;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS);
  smoke = createSmokeRoot();
});

afterEach(async () => {
  await smoke.unmount();
  vi.useRealTimers();
});

interface RenderOptions {
  sessionId?: string | null;
  planningCount?: number;
  planningVariantIndex?: number;
  planningMode?: PlanningIndicatorMode;
}

async function render(
  trailState: AgentStatusTrailState,
  options: RenderOptions = {}
): Promise<string> {
  await smoke.render(
    createElement(AgentStatusTrail, {
      state: trailState,
      sessionId: options.sessionId ?? null,
      planningCount: options.planningCount ?? 0,
      planningVariantIndex: options.planningVariantIndex ?? 0,
      planningMode: options.planningMode ?? "planning",
    })
  );
  // The component opens its clock on the next macrotask rather than
  // synchronously in the effect body, so let that timer land.
  await settle(0);
  return smoke.container.textContent ?? "";
}

describe("AgentStatusTrail", () => {
  it("renders nothing in the hidden phase", async () => {
    await render(HIDDEN_AGENT_STATUS_TRAIL_STATE);

    expect(smoke.container.innerHTML).toBe("");
  });

  it("names the current activity on the same row", async () => {
    // This phrase used to be its own line above the trail; two stacked rows
    // about one running round read as clutter.
    const text = await render(state({ startedAtMs: startedAgo(31_000) }), {
      planningCount: 1,
      planningMode: "agentTyping",
    });

    expect(text).toBe("Agent working for 31s · Agent is typing...");
  });

  it("picks a planning variant by its stable index", async () => {
    const text = await render(state({ startedAtMs: startedAgo(31_000) }), {
      planningCount: 1,
      planningVariantIndex: 1,
    });

    expect(text).toBe("Agent working for 31s · Thinking it through...");
  });

  it("drops the phrase between beats without dropping the row", async () => {
    // The planning indicator hides itself for a second after every store
    // mutation. The duration has to survive that, or the row would flicker.
    const text = await render(state({ startedAtMs: startedAgo(31_000) }), {
      planningCount: 0,
    });

    expect(text).toBe("Agent working for 31s");
  });

  it("lets an activity replace a resting label it contradicts", async () => {
    // Manual compaction names itself even when the runtime status has not
    // flipped to running; "Agent is idle · Compacting context..." would be
    // two claims that cannot both hold.
    const text = await render(state({ phase: "idle" }), {
      planningCount: 1,
      planningMode: "compacting",
    });

    expect(text).toBe("Compacting context...");
  });

  it("keeps the state at text-2 and the activity a step back", async () => {
    await render(state({ startedAtMs: startedAgo(31_000) }), {
      planningCount: 1,
      planningMode: "agentTyping",
    });

    const html = smoke.container.innerHTML;
    expect(html).toContain("text-text-2");
    expect(html).toContain("text-text-3");
  });

  it("says one thing while a round runs", async () => {
    // The present-tense twin of the finished turn's "Agent worked for X".
    // Background tasks stay off this line: a running round already says work
    // is happening, and what the agent is doing right now is the planning
    // row directly above.
    const text = await render(
      state({
        startedAtMs: startedAgo((80 * 60 + 26) * 1000),
        runningTasks: 1,
      })
    );

    expect(text).toBe("Agent working for 1h 20m 26s");
  });

  it("counts up as the round runs", async () => {
    await render(state({ startedAtMs: startedAgo(26_000) }));
    expect(smoke.container.textContent).toBe("Agent working for 26s");

    await settle(4_000);

    expect(smoke.container.textContent).toBe("Agent working for 30s");
  });

  it("drops the duration rather than showing 0s when the start is unknown", async () => {
    const text = await render(state({ startedAtMs: null }));

    expect(text).toBe("Agent working");
  });

  it("pluralizes the running-task count in the resting phases", async () => {
    const text = await render(state({ phase: "idle", runningTasks: 3 }));

    expect(text).toBe("3 running tasks · Agent is idle");
  });

  it("leads with the session's own harness mark", async () => {
    await render(state({ startedAtMs: startedAgo(1000) }), {
      sessionId: "codexapp-42",
    });

    expect(
      smoke.container
        .querySelector('[data-testid="session-identity-icon"]')
        ?.getAttribute("data-session-id")
    ).toBe("codexapp-42");
  });

  it("keeps the live pulse on the agent mark", async () => {
    await render(state({ startedAtMs: startedAgo(1000) }));

    expect(smoke.container.innerHTML).toContain("animate-agent-pulse");
    // Respects a reduced-motion preference.
    expect(smoke.container.innerHTML).toContain("motion-reduce:animate-none");
  });
});

describe("AgentStatusTrail — idle phase", () => {
  it("holds the mark with a resting label and no metrics", async () => {
    const text = await render(
      // A stale anchor from the round that just ended must not leak
      // through as a frozen, live-looking readout.
      state({ phase: "idle", startedAtMs: startedAgo(26_000) })
    );

    expect(text).toBe("Agent is idle");
  });

  it("stops the pulse but keeps the mark in place", async () => {
    await render(state({ phase: "idle" }));

    const html = smoke.container.innerHTML;
    expect(
      smoke.container.querySelector('[data-testid="session-identity-icon"]')
    ).not.toBeNull();
    expect(html).not.toContain("animate-agent-pulse");
    // Parked at the pulse's own low point, so starting a round does not jump.
    expect(html).toContain("scale-90");
    expect(html).toContain("opacity-50");
  });

  it("does not tick while idle", async () => {
    await render(state({ phase: "idle", startedAtMs: startedAgo(26_000) }));

    await settle(5_000);

    expect(smoke.container.textContent).toBe("Agent is idle");
  });

  it("says what the session is waiting for in the asking phase", async () => {
    const text = await render(state({ phase: "asking" }));

    expect(text).toBe("Waiting for your reply");
    // Parked on a question is not working, however the status is spelled.
    expect(smoke.container.innerHTML).not.toContain("animate-agent-pulse");
  });

  it("reports the last scan instead of idleness for a mirrored transcript", async () => {
    const text = await render(
      state({
        phase: "idle",
        isExternal: true,
        lastRefreshedAtMs: NOW_MS - 5 * 60_000,
      }),
      { sessionId: "codexapp-42" }
    );

    expect(text).toBe("Last refreshed 5 minutes ago");
    expect(text).not.toContain("idle");
  });

  it("shows the bare mark for an external session never scanned here", async () => {
    // Neither "the agent is idle" nor a refresh time is available, so the
    // row says nothing rather than inventing one.
    const text = await render(
      state({ phase: "idle", isExternal: true, lastRefreshedAtMs: null }),
      { sessionId: "codexapp-42" }
    );

    expect(text).toBe("");
    expect(
      smoke.container.querySelector('[data-testid="session-identity-icon"]')
    ).not.toBeNull();
  });

  it("still reports background tasks that outlived the round", async () => {
    // A `background` shell keeps running after its round ends; a bare
    // "Agent is idle" next to two live shells would be false.
    const text = await render(state({ phase: "idle", runningTasks: 2 }));

    expect(text).toBe("2 running tasks · Agent is idle");
  });
});
