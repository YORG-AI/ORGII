/**
 * Scheduler-level tests. Deliberately mostly bypass the timer chain for the
 * capability/TOO_LARGE tests (they invoke the private `runPass` /
 * `noteOrgFailure` / `pushOrg` directly via a cast, with a manually
 * controllable clock) — the bug being tested lives in what those methods DO
 * with their inputs, not in the setTimeout wiring. The start/stop race tests
 * are the exception: that bug IS about the timer wiring, so those use the
 * public start()/stop() API with fake timers, following the
 * `memberRuntimePushPlanner.test.ts` style of an injected clock and no real
 * timers.
 */
import { createStore } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BuilderProfileOverview } from "@src/api/tauri/builderProfile";
import type { DailyRollupResult } from "@src/api/tauri/usageDashboard";
import {
  settingsAtom,
  settingsLoadedAtom,
} from "@src/store/settings/settingsAtom";

import type { Org2CloudAuthState } from "../org2CloudAuthAtom";
import { org2CloudAuthAtom } from "../org2CloudAuthAtom";
import type { CloudCapabilitiesProbeResult } from "../org2CloudCapabilities";
import { type Org2CloudOrg, org2CloudOrgsAtom } from "../org2CloudOrgsAtom";
import { MemberRuntimeError } from "./memberRuntimeClient";
import {
  UTC_DAY_MS,
  memberRuntimeBackoffDelayMs,
  utcDayFloorMs,
} from "./memberRuntimePushPlanner";
import {
  MEMBER_RUNTIME_CAPABILITY_RECHECK_MS,
  MemberRuntimePushScheduler,
  type MemberRuntimeSchedulerDeps,
} from "./memberRuntimePushScheduler";
import {
  MEMBER_USAGE_DAYS_MAX_PER_PUSH,
  SHARE_RUNTIME_SETTING_KEY,
} from "./types";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));

const mocks = vi.hoisted(() => ({
  logWarn: vi.fn(),
}));
vi.mock("@src/hooks/logger", () => ({
  createLogger: () => ({
    warn: mocks.logWarn,
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

const NOW = Date.UTC(2026, 6, 29, 12, 0, 0);

const AUTH: Org2CloudAuthState = {
  kind: "org2_cloud",
  supabaseUrl: "https://cloud.example",
  supabaseAnonKey: "anon",
  userId: "user-1",
  accessToken: "token-1",
  refreshToken: "refresh-1",
  expiresAt: Math.floor(NOW / 1000) + 3600,
};

function makeOrg(overrides: Partial<Org2CloudOrg> = {}): Org2CloudOrg {
  return {
    orgId: "org-1",
    name: "Org",
    role: "member",
    runtimeTelemetry: { enabled: true, intervalMinutes: 60 },
    ...overrides,
  };
}

function makeStore(orgs: Org2CloudOrg[]): ReturnType<typeof createStore> {
  const store = createStore();
  store.set(org2CloudAuthAtom, AUTH);
  store.set(org2CloudOrgsAtom, orgs);
  store.set(settingsLoadedAtom, true);
  store.set(settingsAtom, {
    ...store.get(settingsAtom),
    [SHARE_RUNTIME_SETTING_KEY]: true,
  } as never);
  return store as never;
}

const CONFIRMED_MEMBER_RUNTIME_TRUE: CloudCapabilitiesProbeResult = {
  capabilities: {
    broadcastSignals: false,
    storageSegments: false,
    homeEndpoints: false,
    teamInboxMentions: false,
    memberRuntime: true,
    sessionTurnIndex: false,
    offlineSync: false,
    orgChannels: false,
    orgChannelMessages: false,
  },
  confirmed: true,
};

function makeProfileOverview(
  overrides: Partial<BuilderProfileOverview["profile"]> = {}
): BuilderProfileOverview {
  return {
    profile: {
      code: "",
      archetype: null,
      blurbs: [],
      confidence: 0,
      sessions: 0,
      hasEnoughSessions: false,
      axes: [],
      secondary: [],
      subagentSessionShare: 0,
      startedAtMs: 0,
      endedAtMs: 0,
      ...overrides,
    },
    bySourceCount: 0,
    bySource: [],
    driftCount: 0,
    drift: [],
    coverage: { extractedNow: 0, unreadable: 0, total: 0 } as never,
    highlights: [],
  };
}

function makeRollupDays(count: number): DailyRollupResult["days"] {
  return Array.from({ length: count }, (_, index) => ({
    dayStartMs: utcDayFloorMs(NOW) - index * UTC_DAY_MS,
    bucket: "claude",
    inputTokens: 10 + index,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 11 + index,
    costUsd: 1,
    sessions: 1,
    requests: 1,
  }));
}

function makeDeps(
  overrides: Partial<MemberRuntimeSchedulerDeps> = {}
): MemberRuntimeSchedulerDeps {
  return {
    now: () => Date.now(),
    random: () => 0,
    getMachine: vi.fn().mockResolvedValue({
      deviceId: "device-1",
      machineLabel: "Test Machine",
      osName: "macOS",
      osVersion: "15.0",
      chipType: "Apple M3",
      appVersion: "1.0.0",
    }),
    getSample: vi.fn().mockResolvedValue({
      cpuPercent: 10,
      memUsedMb: 1000,
      memTotalMb: 2000,
      gpuPercent: null,
      sampledOverMs: 1000,
      sampledAtMs: NOW,
    }),
    getDailyRollup: vi.fn().mockResolvedValue({ days: [], totalSessions: 0 }),
    getProfileOverview: vi.fn().mockResolvedValue(makeProfileOverview()),
    detectInstalledAgents: vi.fn().mockResolvedValue([]),
    upsert: vi.fn().mockResolvedValue(undefined),
    getCapabilities: vi.fn().mockResolvedValue(CONFIRMED_MEMBER_RUNTIME_TRUE),
    ensureFresh: vi.fn().mockImplementation(async (auth: unknown) => auth),
    ...overrides,
  };
}

/** A `deps.now()` the test controls directly — no real or fake timers
 * involved, so the capability/TOO_LARGE tests below don't have to reason
 * about setTimeout at all. */
function makeControllableClock(startMs: number) {
  let current = startMs;
  return {
    now: () => current,
    advanceTo: (ms: number) => {
      current = ms;
    },
    advanceBy: (ms: number) => {
      current += ms;
    },
  };
}

/**
 * A standalone shape (deliberately NOT intersected with
 * `MemberRuntimePushScheduler`) exposing the private internals these tests
 * need direct access to. Intersecting with the real class type instead would
 * collapse to `never` — TS treats a class's private members as nominally
 * typed, so re-declaring `generation` etc. as public in an intersected
 * object type conflicts with the private declaration and the whole
 * intersection becomes uninhabitable.
 */
interface SchedulerTestAccess {
  start: (store: ReturnType<typeof createStore>) => void;
  stop: () => void;
  generation: number;
  running: boolean;
  usageDaysCapByOrg: Map<string, number>;
  dropOptionalSectionsByOrg: Set<string>;
  capabilityRecheckAtMs: number;
  capabilityUnconfirmedFailures: number;
  runPass: (generation: number) => Promise<void>;
  noteOrgFailure: (org: Org2CloudOrg, error: unknown) => void;
  pushOrg: (
    accessToken: string,
    identityKey: string,
    org: Org2CloudOrg,
    probeAgentsOnce: () => Promise<null>
  ) => Promise<void>;
}

function asPrivate(scheduler: MemberRuntimePushScheduler): SchedulerTestAccess {
  return scheduler as unknown as SchedulerTestAccess;
}

beforeEach(() => {
  localStorage.clear();
  mocks.logWarn.mockClear();
});

describe("start/stop race (generation vs. running)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function flush(times = 5): Promise<void> {
    for (let i = 0; i < times; i += 1) {
      await Promise.resolve();
    }
  }

  it("re-arms a timer for the new generation once a pass that hung across stop()/start() settles", async () => {
    const store = makeStore([makeOrg()]);
    let releaseEnsureFresh!: (value: unknown) => void;
    const hangingEnsureFresh = new Promise((resolve) => {
      releaseEnsureFresh = resolve;
    });
    const deps = makeDeps({
      ensureFresh: vi.fn().mockReturnValue(hangingEnsureFresh),
    });
    const scheduler = new MemberRuntimePushScheduler(deps);

    scheduler.start(store);
    // The immediate trigger() inside start() finds no due org yet (the
    // launch jitter hasn't elapsed) and settles almost immediately; flush
    // that first so the initial timer gets armed.
    await flush();
    expect(vi.getTimerCount()).toBe(1);

    // Advance to the due deadline: the armed timer fires, trigger() begins
    // a pass, and that pass suspends on ensureFresh — simulating a slow
    // token refresh round-trip that hasn't come back yet.
    vi.advanceTimersByTime(30_000);
    await flush();
    expect(vi.getTimerCount()).toBe(0); // no timer while a pass is in flight
    expect(deps.getCapabilities).not.toHaveBeenCalled();

    // stop() lands while that pass is still in flight (bumps the
    // generation but — correctly — does NOT touch `running`)...
    scheduler.stop();
    // ...and a fresh start() races ahead of it settling.
    scheduler.start(store);
    await flush();
    // The new start()'s own immediate trigger() no-ops because `running`
    // is still true from the stale pass: nothing is armed yet. This is the
    // exact state the bug used to leave permanently stuck in.
    expect(vi.getTimerCount()).toBe(0);

    // The stale pass finally resolves.
    releaseEnsureFresh(AUTH);
    await flush();

    // Fixed behavior: the pass's `finally` unconditionally clears `running`
    // and reschedules because the scheduler is still `started` — so a timer
    // ends up armed for the new generation instead of the scheduler being
    // left with neither a running pass nor a timer.
    expect(vi.getTimerCount()).toBe(1);
  });

  it("clears the armed timer on teardown", async () => {
    const store = makeStore([makeOrg()]);
    const deps = makeDeps();
    const scheduler = new MemberRuntimePushScheduler(deps);

    scheduler.start(store);
    await flush();
    expect(vi.getTimerCount()).toBe(1);

    scheduler.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("capability blackout: confirmed vs. unconfirmed", () => {
  it("holds the long 6h recheck blackout for a CONFIRMED legacy backend", async () => {
    const clock = makeControllableClock(NOW);
    const getCapabilities = vi.fn().mockResolvedValue({
      capabilities: {
        broadcastSignals: false,
        storageSegments: false,
        homeEndpoints: false,
        teamInboxMentions: false,
        memberRuntime: false,
        sessionTurnIndex: false,
        offlineSync: false,
        orgChannels: false,
        orgChannelMessages: false,
      },
      confirmed: true,
    } satisfies CloudCapabilitiesProbeResult);
    const deps = makeDeps({ now: clock.now, getCapabilities });
    const store = makeStore([makeOrg()]);
    const scheduler = asPrivate(new MemberRuntimePushScheduler(deps));

    scheduler.start(store);
    // The org is due once the launch jitter (30s at random()=0) elapses.
    clock.advanceBy(30_000);

    await scheduler.runPass(scheduler.generation);

    expect(getCapabilities).toHaveBeenCalledTimes(1);
    expect(scheduler.capabilityUnconfirmedFailures).toBe(0);
    expect(scheduler.capabilityRecheckAtMs).toBe(
      clock.now() + MEMBER_RUNTIME_CAPABILITY_RECHECK_MS
    );
  });

  it("uses the short exponential backoff — NOT the 6h blackout — when the probe never got an answer", async () => {
    const clock = makeControllableClock(NOW);
    const getCapabilities = vi.fn().mockResolvedValue({
      capabilities: {
        broadcastSignals: false,
        storageSegments: false,
        homeEndpoints: false,
        teamInboxMentions: false,
        memberRuntime: false,
        sessionTurnIndex: false,
        offlineSync: false,
        orgChannels: false,
        orgChannelMessages: false,
      },
      confirmed: false,
    } satisfies CloudCapabilitiesProbeResult);
    const deps = makeDeps({ now: clock.now, getCapabilities });
    const store = makeStore([makeOrg()]);
    const scheduler = asPrivate(new MemberRuntimePushScheduler(deps));

    scheduler.start(store);
    clock.advanceBy(30_000);

    await scheduler.runPass(scheduler.generation);

    expect(scheduler.capabilityUnconfirmedFailures).toBe(1);
    const firstRecheckAt = scheduler.capabilityRecheckAtMs;
    expect(firstRecheckAt).toBe(clock.now() + memberRuntimeBackoffDelayMs(1));
    expect(firstRecheckAt).toBeLessThan(
      clock.now() + MEMBER_RUNTIME_CAPABILITY_RECHECK_MS
    );

    // A second consecutive unconfirmed probe escalates the backoff (still
    // nowhere near the 6h blackout).
    clock.advanceTo(firstRecheckAt + 1);
    await scheduler.runPass(scheduler.generation);

    expect(getCapabilities).toHaveBeenCalledTimes(2);
    expect(scheduler.capabilityUnconfirmedFailures).toBe(2);
    expect(scheduler.capabilityRecheckAtMs).toBe(
      clock.now() + memberRuntimeBackoffDelayMs(2)
    );
  });

  it("resets the unconfirmed-failure counter once a probe is confirmed", async () => {
    const clock = makeControllableClock(NOW);
    const getCapabilities = vi
      .fn()
      .mockResolvedValueOnce({
        capabilities: {
          broadcastSignals: false,
          storageSegments: false,
          homeEndpoints: false,
          teamInboxMentions: false,
          memberRuntime: false,
          sessionTurnIndex: false,
          offlineSync: false,
          orgChannels: false,
          orgChannelMessages: false,
        },
        confirmed: false,
      } satisfies CloudCapabilitiesProbeResult)
      .mockResolvedValueOnce(CONFIRMED_MEMBER_RUNTIME_TRUE);
    const deps = makeDeps({ now: clock.now, getCapabilities });
    const store = makeStore([makeOrg()]);
    const scheduler = asPrivate(new MemberRuntimePushScheduler(deps));

    scheduler.start(store);
    clock.advanceBy(30_000);
    await scheduler.runPass(scheduler.generation);
    expect(scheduler.capabilityUnconfirmedFailures).toBe(1);

    clock.advanceTo(scheduler.capabilityRecheckAtMs + 1);
    await scheduler.runPass(scheduler.generation);

    expect(scheduler.capabilityUnconfirmedFailures).toBe(0);
    expect(scheduler.capabilityRecheckAtMs).toBe(0);
  });
});

describe("ORG2_RUNTIME_TOO_LARGE mitigation", () => {
  it("halves the org's usage-days cap on each TOO_LARGE failure, floored at 1", () => {
    // Guard against silent drift of the constant this test's expectations
    // are hand-derived from.
    expect(MEMBER_USAGE_DAYS_MAX_PER_PUSH).toBe(40);

    const scheduler = asPrivate(new MemberRuntimePushScheduler(makeDeps()));
    const org = makeOrg();
    const tooLarge = new MemberRuntimeError(
      "ORG2_RUNTIME_TOO_LARGE: payload exceeds the size cap"
    );

    const expectedCaps = [20, 10, 5, 2, 1, 1];
    for (const expectedCap of expectedCaps) {
      scheduler.noteOrgFailure(org, tooLarge);
      expect(scheduler.usageDaysCapByOrg.get("org-1")).toBe(expectedCap);
    }
  });

  it("drops profile/installed-agents exactly once, only after the cap floors and it's still too large", () => {
    const scheduler = asPrivate(new MemberRuntimePushScheduler(makeDeps()));
    const org = makeOrg();
    const tooLarge = new MemberRuntimeError(
      "ORG2_RUNTIME_TOO_LARGE: payload exceeds the size cap"
    );
    const dropWarnings = () =>
      mocks.logWarn.mock.calls.filter(
        ([message]) =>
          typeof message === "string" &&
          message.includes("dropping profile/installed-agents")
      );

    // Five failures walk the cap 40 -> 20 -> 10 -> 5 -> 2 -> 1; none of
    // these should touch the optional-sections drop yet.
    for (let i = 0; i < 5; i += 1) scheduler.noteOrgFailure(org, tooLarge);
    expect(scheduler.dropOptionalSectionsByOrg.has("org-1")).toBe(false);
    expect(dropWarnings()).toHaveLength(0);

    // Sixth failure: already at the floor (1) and still too large.
    scheduler.noteOrgFailure(org, tooLarge);
    expect(scheduler.dropOptionalSectionsByOrg.has("org-1")).toBe(true);
    expect(dropWarnings()).toHaveLength(1);

    // A further failure at the floor must not log the transition again.
    scheduler.noteOrgFailure(org, tooLarge);
    expect(dropWarnings()).toHaveLength(1);
  });

  it("pushOrg respects a previously reduced per-org usage-days cap", async () => {
    const upsert = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      now: () => NOW,
      getDailyRollup: vi
        .fn()
        .mockResolvedValue({ days: makeRollupDays(5), totalSessions: 5 }),
      upsert,
    });
    const scheduler = asPrivate(new MemberRuntimePushScheduler(deps));
    scheduler.usageDaysCapByOrg.set("org-1", 2);

    await scheduler.pushOrg(
      "token-1",
      "identity-cap-test",
      makeOrg(),
      async () => null
    );

    expect(upsert).toHaveBeenCalledTimes(1);
    const input = upsert.mock.calls[0][2] as { usageDays?: unknown[] };
    expect(input.usageDays).toHaveLength(2);
  });

  it("pushOrg drops profile/installed-agents once flagged, even though both changed", async () => {
    const upsert = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      now: () => NOW,
      getDailyRollup: vi
        .fn()
        .mockResolvedValue({ days: makeRollupDays(1), totalSessions: 1 }),
      getProfileOverview: vi
        .fn()
        .mockResolvedValue(makeProfileOverview({ code: "EAWH", sessions: 10 })),
      upsert,
    });
    const scheduler = asPrivate(new MemberRuntimePushScheduler(deps));
    scheduler.dropOptionalSectionsByOrg.add("org-1");

    await scheduler.pushOrg(
      "token-1",
      "identity-drop-test",
      makeOrg(),
      async () => [{ id: "claude", status: "installed" }] as never
    );

    expect(upsert).toHaveBeenCalledTimes(1);
    const input = upsert.mock.calls[0][2] as { profile?: unknown };
    expect(input.profile).toBeUndefined();
    // The agents probe callback itself is never even invoked while dropping.
    expect(deps.getProfileOverview).not.toHaveBeenCalled();
  });
});
