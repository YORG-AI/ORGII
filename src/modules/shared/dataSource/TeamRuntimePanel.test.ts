// @vitest-environment jsdom
import { getDefaultStore } from "jotai";
import { act, createElement, useState } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  MemberRuntimeListEntry,
  MemberUsageDay,
} from "@src/features/Org2Cloud/memberRuntime/types";
import { utcDayFromMs } from "@src/features/Org2Cloud/memberRuntime/types";
import type { Org2CloudAuthState } from "@src/features/Org2Cloud/org2CloudAuthAtom";
import type { Org2CloudOrg } from "@src/features/Org2Cloud/org2CloudOrgsAtom";
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";

import TeamRuntimePanel from "./TeamRuntimePanel";
import { utcDayStartMs } from "./teamRuntimeData";

const mocks = vi.hoisted(() => ({
  listMemberRuntime: vi.fn(),
  getMemberUsage: vi.fn(),
  getCloudCapabilities: vi.fn(),
  ensureFreshSession: vi.fn(),
  externalCliSourcesDetect: vi.fn(),
  signIn: vi.fn(),
  openCloudSessionReference: vi.fn(),
  useCloudOrgRemoteSessions: vi.fn(),
}));

vi.mock("@src/features/Org2Cloud/memberRuntime/memberRuntimeClient", () => ({
  listMemberRuntime: mocks.listMemberRuntime,
  getMemberUsage: mocks.getMemberUsage,
  upsertMemberRuntime: vi.fn(),
  setOrgRuntimeTelemetry: vi.fn(),
}));

// The auth and orgs atoms are replaced with plain writable atoms so each test
// can seed the default store directly.
vi.mock("@src/features/Org2Cloud/org2CloudAuthAtom", async () => {
  const { atom } = await import("jotai");
  return {
    org2CloudAuthAtom: atom(null),
    org2CloudAuthIdentityKey: (auth: { supabaseUrl: string; userId: string }) =>
      `${auth.supabaseUrl}|${auth.userId}`,
    commitRefreshedAuth: () => true,
  };
});

vi.mock("@src/features/Org2Cloud/org2CloudOrgsAtom", async () => {
  const { atom } = await import("jotai");
  return {
    org2CloudOrgsAtom: atom([]),
    org2CloudOrgsLoadedAtom: atom(true),
    org2CloudMemberRuntimeVersionAtom: atom({}),
  };
});

vi.mock("@src/features/Org2Cloud/org2CloudClient", () => ({
  ensureFreshSession: mocks.ensureFreshSession,
}));

vi.mock("@src/features/Org2Cloud/org2CloudCapabilities", () => ({
  getCloudCapabilities: mocks.getCloudCapabilities,
}));

vi.mock("@src/api/tauri/externalHistory/detection", () => ({
  externalCliSourcesDetect: mocks.externalCliSourcesDetect,
}));

vi.mock("@src/api/tauri/usageDashboard", () => ({
  usageDashboardModelPricing: vi.fn(),
}));

vi.mock("@src/features/Org2Cloud/useOrg2CloudSignIn", () => ({
  useOrg2CloudSignIn: () => mocks.signIn,
}));

vi.mock("@src/features/Org2Cloud/useOpenCloudSessionReference", () => ({
  useOpenCloudSessionReference: () => mocks.openCloudSessionReference,
}));

vi.mock("@src/features/Org2Cloud/org2CloudRemoteSessionsAtom", () => ({
  useCloudOrgRemoteSessions: (orgId: string | null) =>
    mocks.useCloudOrgRemoteSessions(orgId),
}));

vi.mock("@src/hooks/ui", () => ({
  useRefreshSpin: (onRefresh: () => void) => ({
    spinClass: undefined,
    handleClick: onRefresh,
  }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: { language: "en", resolvedLanguage: "en" },
    // Echo interpolation so assertions can see the values that were passed.
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}:${Object.values(vars).join(",")}` : key,
  }),
}));

vi.mock("@src/components/Button", () => ({
  default: ({
    children,
    onClick,
    disabled,
    "data-testid": dataTestId,
  }: {
    children?: unknown;
    onClick?: () => void;
    disabled?: boolean;
    "data-testid"?: string;
  }) =>
    createElement(
      "button",
      { onClick, disabled, "data-testid": dataTestId },
      children as never
    ),
}));

vi.mock("@src/components/Select", () => ({
  default: ({
    value,
    dataTestId,
    options = [],
    onChange,
  }: {
    value?: unknown;
    dataTestId?: string;
    options?: Array<{ value: unknown; label: string }>;
    onChange?: (value: unknown) => void;
  }) =>
    createElement(
      "select",
      {
        "data-testid": dataTestId ?? "select",
        value: String(value),
        onChange: (event: { target: { value: string } }) =>
          onChange?.(event.target.value),
      },
      options.map((option) =>
        createElement(
          "option",
          { key: String(option.value), value: String(option.value) },
          option.label
        )
      )
    ),
}));

vi.mock("@src/components/TabPill", () => ({
  default: ({ activeTab }: { activeTab?: string }) =>
    createElement("div", {
      "data-testid": "tab-pill",
      "data-active": activeTab,
    }),
}));

vi.mock("@src/components/Avatar", () => ({
  default: ({ children }: { children?: unknown }) =>
    createElement("span", { "data-testid": "avatar" }, children as never),
}));

vi.mock("@src/components/ModelIcon", () => ({
  default: ({ provider }: { provider?: string }) =>
    createElement("span", { "data-testid": `model-icon-${provider}` }),
}));

vi.mock("@src/components/Tooltip", () => ({
  default: ({ children }: { children?: unknown }) =>
    createElement("span", null, children as never),
}));

vi.mock("@src/components/ProgressBar", () => ({
  default: ({ percent }: { percent: number }) =>
    createElement("div", {
      "data-testid": "progress",
      "data-percent": percent,
    }),
}));

vi.mock("@src/components/SettingsTable", () => ({
  default: ({ rows }: { rows?: unknown[] }) =>
    createElement("table", { "data-rows": rows?.length ?? 0 }),
  SETTINGS_TABLE_CELL: { primary: "", value: "", muted: "" },
  SETTINGS_TABLE_COL: { fill: "", valueSm: "", valueMd: "" },
}));

vi.mock("./UsageTrendChart", () => ({
  default: ({
    points,
    hourly,
    startMs,
    endMs,
  }: {
    points: unknown[];
    hourly?: boolean;
    startMs?: number | null;
    endMs?: number | null;
  }) =>
    createElement("div", {
      "data-testid": "team-usage-trend-chart",
      "data-points": JSON.stringify(points),
      "data-hourly": hourly ? "true" : "false",
      "data-start-ms": startMs == null ? "" : String(startMs),
      "data-end-ms": endMs == null ? "" : String(endMs),
    }),
}));

vi.mock("@src/modules/shared/layouts/blocks", () => ({
  Placeholder: ({
    variant,
    title,
    subtitle,
    action,
    onRetry,
  }: {
    variant: string;
    title?: string;
    subtitle?: string;
    action?: { label: string; onClick: () => void; dataTestId?: string };
    onRetry?: () => void;
  }) =>
    createElement(
      "div",
      { "data-testid": `placeholder-${variant}` },
      title ?? "",
      subtitle ?? "",
      action
        ? createElement(
            "button",
            { "data-testid": action.dataTestId, onClick: action.onClick },
            action.label
          )
        : null,
      onRetry
        ? createElement("button", { "data-testid": "retry", onClick: onRetry })
        : null
    ),
  CollapsibleSection: ({
    title,
    children,
    defaultOpen = true,
  }: {
    title?: string;
    children?: unknown;
    defaultOpen?: boolean;
  }) => {
    const [open] = useState(defaultOpen);
    return createElement(
      "section",
      null,
      title ?? "",
      open ? (children as never) : null
    );
  },
  STAT_GRID_TOKENS: { cols3: "", cols4: "" },
}));

vi.mock("@src/components/Placeholder", () => ({
  Placeholder: ({
    variant,
    title,
    subtitle,
    action,
    onRetry,
  }: {
    variant: string;
    title?: string;
    subtitle?: string;
    action?: { label: string; onClick: () => void; dataTestId?: string };
    onRetry?: () => void;
  }) =>
    createElement(
      "div",
      { "data-testid": `placeholder-${variant}` },
      title ?? "",
      subtitle ?? "",
      action
        ? createElement(
            "button",
            { "data-testid": action.dataTestId, onClick: action.onClick },
            action.label
          )
        : null,
      onRetry
        ? createElement("button", { "data-testid": "retry", onClick: onRetry })
        : null
    ),
}));

vi.mock("@src/modules/shared/layouts/SectionLayout", () => ({
  SECTION_GAP_CLASSES: "",
  SECTION_SUBHEADING_CLASSES: "",
  SectionContainer: ({ children }: { children?: unknown }) =>
    createElement("section", null, children as never),
  SectionRow: ({
    label,
    description,
    children,
  }: {
    label?: unknown;
    description?: string;
    children?: unknown;
  }) =>
    createElement(
      "div",
      null,
      label as never,
      description ?? "",
      children as never
    ),
  ExpandableTableRow: ({
    label,
    extraControls,
    children,
    expanded,
  }: {
    label?: string;
    extraControls?: unknown;
    children?: unknown;
    expanded?: boolean;
  }) =>
    createElement(
      "div",
      null,
      label ?? "",
      extraControls as never,
      expanded ? (children as never) : null
    ),
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

const store = getDefaultStore();

// Resolved lazily so vi.mock module state applies.
async function seedAtoms(
  auth: Org2CloudAuthState | null,
  orgs: Org2CloudOrg[],
  // Defaults to true (the mocked atom's own default) so every existing
  // call site is unaffected; the org-load-stall tests below pass false to
  // simulate the atom never resolving.
  orgsLoaded = true
) {
  const { org2CloudAuthAtom } =
    await import("@src/features/Org2Cloud/org2CloudAuthAtom");
  const { org2CloudOrgsAtom, org2CloudOrgsLoadedAtom } =
    await import("@src/features/Org2Cloud/org2CloudOrgsAtom");
  store.set(org2CloudAuthAtom, auth);
  store.set(org2CloudOrgsAtom, orgs);
  store.set(org2CloudOrgsLoadedAtom, orgsLoaded);
}

const AUTH: Org2CloudAuthState = {
  kind: "org2_cloud",
  supabaseUrl: "https://cloud.example",
  supabaseAnonKey: "anon",
  userId: "me",
  accessToken: "token-1",
  refreshToken: "refresh-1",
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
};

function org(over: Record<string, unknown> = {}): Org2CloudOrg {
  return {
    orgId: "org-1",
    name: "Example Team",
    role: "member",
    runtimeTelemetry: { enabled: true, intervalMinutes: 60 },
    ...over,
  } as unknown as Org2CloudOrg;
}

function usageDay(over: Partial<MemberUsageDay> = {}): MemberUsageDay {
  return {
    day: utcDayFromMs(Date.now()),
    bucket: "claude",
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 150,
    costUsd: 2,
    sessions: 1,
    requests: 4,
    ...over,
  };
}

function recentUsage24h(
  inputTokens: number,
  costUsd: number,
  bucketMs = Math.floor(Date.now() / 3_600_000) * 3_600_000
): NonNullable<MemberRuntimeListEntry["stats"]>["recentUsage24h"] {
  return {
    startMs: Date.now() - 86_400_000,
    endMs: Date.now(),
    summary: {
      sessionCount: 1,
      requestCount: 1,
      inputTokens,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      realTotalTokens: inputTokens,
      totalTokens: inputTokens,
      costUsd,
      estimatedCostUsd: costUsd,
      recordedCostUsd: 0,
      cacheHitRate: 0,
      byBucket: [],
    },
    trends: [
      {
        bucketMs,
        inputTokens,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd,
      },
    ],
  };
}

function member(
  over: Partial<MemberRuntimeListEntry> = {}
): MemberRuntimeListEntry {
  return {
    userId: "user-a",
    displayName: "Ada",
    avatarUrl: null,
    role: "member",
    reportedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    machine: {
      deviceId: "device-a",
      machineLabel: "Ada's MacBook",
      osName: "macOS",
      osVersion: "15.5",
      chipType: "Apple M3",
      totalRamGb: 32,
      appVersion: "1.2.3",
    },
    sample: {
      cpuPercent: 42.4,
      memUsedMb: 12_800,
      memTotalMb: 32_768,
      gpuPercent: null,
      sampledOverMs: 1500,
      sampledAtMs: Date.now(),
    },
    stats: { totalSessions: 128 },
    builderTypeCode: "EAWH",
    profile: null,
    installedAgents: [
      { id: "claude", status: "importable_history_found" },
      { id: "mystery-cli", status: "detected_no_importer" },
      { id: "codex", status: "not_detected" },
    ],
    profileUpdatedAt: null,
    agentsUpdatedAt: null,
    recentDays: [],
    ...over,
  };
}

function remoteSession(
  id: string,
  ownerUserId: string,
  over: Partial<RemoteTeammateSessionMetadata> = {}
): RemoteTeammateSessionMetadata {
  return {
    id,
    orgId: "org-1",
    ownerMemberId: `member-${ownerUserId}`,
    ownerUserId,
    ownerDisplayName: ownerUserId === "user-a" ? "Ada" : "Lin",
    ownerIdentityKind: "human",
    sourceSessionId: `source-${id}`,
    title: `Session ${id}`,
    lastActivityAt: new Date(
      Date.now() - Number.parseInt(id, 10) * 60_000
    ).toISOString(),
    eventsEpoch: 0,
    eventsFrozenSeq: 0,
    eventsCount: 12,
    eventsTailHash: "tail",
    ...over,
  };
}

let container: HTMLDivElement;
let root: Root;

// Drains a handful of microtask ticks so chained promise hops (token →
// capabilities → roster) settle. Shared by `mount()` below and by tests that
// mutate atoms mid-test and need the resulting re-render/effects to land.
async function drainMicrotasks(times = 6) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function mount(
  props: { orgId?: string; view?: "today" | "members" } = {}
) {
  await act(async () => {
    root.render(createElement(TeamRuntimePanel, props));
  });
  // Drain the fetch chain (token → capabilities → roster) microtask by
  // microtask; each hop queues the next.
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

beforeEach(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  mocks.ensureFreshSession.mockImplementation(async (auth: unknown) => auth);
  mocks.getCloudCapabilities.mockResolvedValue({ memberRuntime: true });
  mocks.listMemberRuntime.mockResolvedValue([]);
  mocks.getMemberUsage.mockResolvedValue([]);
  mocks.useCloudOrgRemoteSessions.mockReturnValue({
    rows: [],
    state: "ready",
    fetchedAt: Date.now(),
    documentVisible: true,
    refresh: vi.fn(),
  });
  mocks.externalCliSourcesDetect.mockResolvedValue([
    {
      sourceId: "claude",
      displayName: "Claude Code",
      iconId: "claude",
    },
  ]);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
});

describe("TeamRuntimePanel states", () => {
  it("prompts for sign-in when signed out and never calls the cloud", async () => {
    await seedAtoms(null, []);
    await mount();

    expect(
      container.querySelector('[data-testid="team-runtime-sign-in"]')
    ).not.toBeNull();
    expect(mocks.listMemberRuntime).not.toHaveBeenCalled();
    expect(mocks.getCloudCapabilities).not.toHaveBeenCalled();
  });

  it("explains when the backend lacks the memberRuntime capability", async () => {
    mocks.getCloudCapabilities.mockResolvedValue({ memberRuntime: false });
    await seedAtoms(AUTH, [org()]);
    await mount();

    expect(
      container.querySelector('[data-testid="placeholder-empty"]')?.textContent
    ).toContain("unsupported.title");
    expect(mocks.listMemberRuntime).not.toHaveBeenCalled();
  });

  it("explains when org telemetry is disabled without fetching the roster", async () => {
    await seedAtoms(AUTH, [
      org({ runtimeTelemetry: { enabled: false, intervalMinutes: 60 } }),
    ]);
    await mount();

    expect(
      container.querySelector('[data-testid="placeholder-empty"]')?.textContent
    ).toContain("disabled.title");
    expect(mocks.listMemberRuntime).not.toHaveBeenCalled();
  });

  it("treats a missing runtimeTelemetry field as disabled", async () => {
    await seedAtoms(AUTH, [org({ runtimeTelemetry: undefined })]);
    await mount();

    expect(
      container.querySelector('[data-testid="placeholder-empty"]')?.textContent
    ).toContain("disabled.title");
  });

  it("keeps the org Today view useful when no member has reported yet", async () => {
    await seedAtoms(AUTH, [org()]);
    await mount();

    expect(mocks.listMemberRuntime).toHaveBeenCalledWith("token-1", "org-1");
    expect(
      container.querySelector('[data-testid="team-runtime-today"]')
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="team-runtime-today-members"]')
        ?.textContent
    ).toContain("0/0");
    expect(mocks.externalCliSourcesDetect).not.toHaveBeenCalled();
  });

  it("surfaces a roster failure with retry", async () => {
    mocks.listMemberRuntime.mockRejectedValue(new Error("boom"));
    await seedAtoms(AUTH, [org()]);
    await mount();

    const error = container.querySelector('[data-testid="placeholder-error"]');
    expect(error?.textContent).toContain("loadError");
    expect(error?.textContent).toContain("boom");
  });
});

describe("TeamRuntimePanel roster", () => {
  it("uses the organization controlled by Runtime without rendering a nested org picker", async () => {
    await seedAtoms(AUTH, [
      org(),
      org({ orgId: "org-2", name: "Second Team" }),
    ]);
    await mount({ orgId: "org-2" });

    expect(mocks.listMemberRuntime).toHaveBeenCalledWith("token-1", "org-2");
    expect(
      container.querySelector('[data-testid="team-runtime-org-select"]')
    ).toBeNull();
  });

  it("shows a Today aggregate, latest five shared sessions, and scopes both by person", async () => {
    const today = utcDayFromMs(Date.now());
    mocks.listMemberRuntime.mockResolvedValue([
      member({
        userId: "user-a",
        displayName: "Ada",
        stats: {
          totalSessions: 128,
          recentUsage24h: recentUsage24h(1_000, 4),
        },
        recentDays: [
          usageDay({
            day: today,
            inputTokens: 100,
            outputTokens: 50,
            totalTokens: 150,
            costUsd: 2,
            sessions: 1,
            requests: 4,
          }),
        ],
      }),
      member({
        userId: "user-b",
        displayName: "Lin",
        stats: {
          totalSessions: 64,
          recentUsage24h: recentUsage24h(2_000, 6),
        },
        recentDays: [
          usageDay({
            day: today,
            bucket: "codex",
            inputTokens: 200,
            outputTokens: 100,
            totalTokens: 300,
            costUsd: 3,
            sessions: 2,
            requests: 8,
          }),
        ],
      }),
    ]);
    const remoteRows = [
      remoteSession("1", "user-a"),
      remoteSession("2", "user-b"),
      remoteSession("3", "user-a"),
      remoteSession("4", "user-b"),
      remoteSession("5", "user-a"),
      remoteSession("6", "user-b"),
    ];
    mocks.useCloudOrgRemoteSessions.mockReturnValue({
      rows: remoteRows,
      state: "ready",
      fetchedAt: Date.now(),
      documentVisible: true,
      refresh: vi.fn(),
    });
    await seedAtoms(AUTH, [org()]);
    await mount();

    expect(
      container.querySelector('[data-testid="team-runtime-today-cost"]')
        ?.textContent
    ).toContain("$5.00");
    expect(
      container.querySelectorAll(
        '[data-testid^="team-runtime-recent-session-"]'
      )
    ).toHaveLength(5);
    expect(container.textContent).not.toContain("overview.recentHint");
    expect(
      container
        .querySelector('[data-testid="team-runtime-title-row"]')
        ?.querySelector('[data-testid="team-runtime-refresh"]')
    ).not.toBeNull();
    const titleRow = container.querySelector(
      '[data-testid="team-runtime-title-row"]'
    );
    expect(titleRow?.firstElementChild?.tagName).toBe("H3");
    expect(titleRow?.textContent).toContain("overview.today");
    expect(titleRow?.textContent).not.toContain("overview.todayUtc");
    expect(titleRow?.textContent).not.toContain("overview.person");
    const initialChart = container.querySelector(
      '[data-testid="team-usage-trend-chart"]'
    );
    expect(initialChart?.getAttribute("data-hourly")).toBe("true");
    const initialPoints = JSON.parse(
      initialChart?.getAttribute("data-points") ?? "[]"
    ) as Array<{ inputTokens: number; costUsd: number }>;
    expect(initialPoints).toHaveLength(1);
    expect(initialPoints[0]).toMatchObject({ inputTokens: 3_000, costUsd: 10 });
    expect(
      container.querySelectorAll('[data-testid^="team-runtime-member-usage-"]')
    ).toHaveLength(2);
    expect(
      container.querySelector(
        '[data-testid="team-runtime-member-usage-user-b"]'
      )?.textContent
    ).toContain("2.0K");

    const personSelect = container.querySelector<HTMLSelectElement>(
      '[data-testid="team-runtime-person-select"]'
    );
    await act(async () => {
      if (!personSelect) return;
      personSelect.value = "user-b";
      personSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(
      container.querySelector('[data-testid="team-runtime-today-cost"]')
        ?.textContent
    ).toContain("$3.00");
    expect(
      container.querySelectorAll(
        '[data-testid^="team-runtime-recent-session-"]'
      )
    ).toHaveLength(3);
    const selectedPoints = JSON.parse(
      container
        .querySelector('[data-testid="team-usage-trend-chart"]')
        ?.getAttribute("data-points") ?? "[]"
    ) as Array<{ inputTokens: number; costUsd: number }>;
    expect(selectedPoints[0]).toMatchObject({ inputTokens: 2_000, costUsd: 6 });
    expect(
      container
        .querySelector('[data-testid="team-runtime-member-usage-user-b"]')
        ?.getAttribute("aria-pressed")
    ).toBe("true");

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="team-runtime-recent-session-2"]'
        )
        ?.click();
    });
    expect(mocks.openCloudSessionReference).toHaveBeenCalledWith(
      {
        version: 1,
        orgId: "org-1",
        ownerUserId: "user-b",
        sourceSessionId: "source-2",
      },
      { autoReplay: true }
    );
  });

  it("folds recentDays into today and 7d headlines by UTC day string", async () => {
    const today = utcDayFromMs(Date.now());
    const yesterday = utcDayFromMs(Date.now() - 86_400_000);
    const tenDaysAgo = utcDayFromMs(Date.now() - 10 * 86_400_000);
    mocks.listMemberRuntime.mockResolvedValue([
      member({
        recentDays: [
          usageDay({ day: today, totalTokens: 1_000, costUsd: 2 }),
          usageDay({
            day: today,
            bucket: "other",
            totalTokens: 500,
            costUsd: 1,
          }),
          usageDay({ day: yesterday, totalTokens: 2_000, costUsd: 3 }),
          usageDay({ day: tenDaysAgo, totalTokens: 9_000, costUsd: 90 }),
        ],
      }),
    ]);
    await seedAtoms(AUTH, [org()]);
    await mount({ view: "members" });

    const todayLine = container.querySelector(
      '[data-testid="team-member-today-user-a"]'
    );
    const weekLine = container.querySelector(
      '[data-testid="team-member-week-user-a"]'
    );
    expect(todayLine?.textContent).toContain("$3.00");
    expect(todayLine?.textContent).toContain("1.5K");
    expect(weekLine?.textContent).toContain("$6.00");
    expect(weekLine?.textContent).toContain("3.5K");
  });

  it("puts the title and refresh on one row and groups members by today's activity", async () => {
    const yesterday = utcDayFromMs(Date.now() - 86_400_000);
    mocks.listMemberRuntime.mockResolvedValue([
      member({
        userId: "active",
        recentDays: [usageDay()],
      }),
      member({
        userId: "zero-today",
        recentDays: [
          usageDay({
            totalTokens: 0,
            costUsd: 0,
            sessions: 0,
            requests: 0,
          }),
        ],
      }),
      member({
        userId: "yesterday",
        recentDays: [usageDay({ day: yesterday })],
      }),
    ]);
    await seedAtoms(AUTH, [org()]);
    await mount({ view: "members" });

    const titleRow = container.querySelector(
      '[data-testid="team-runtime-members-title-row"]'
    );
    expect(titleRow?.firstElementChild?.tagName).toBe("H3");
    expect(titleRow?.textContent).toContain("overview.members");
    expect(
      titleRow?.querySelector('[data-testid="team-runtime-refresh"]')
    ).not.toBeNull();
    expect(
      container.querySelectorAll('[data-testid="team-runtime-refresh"]')
    ).toHaveLength(1);

    const active = container.querySelector(
      '[data-testid="team-runtime-active-today"]'
    );
    const inactive = container.querySelector(
      '[data-testid="team-runtime-inactive-today"]'
    );
    expect(active?.textContent).toContain("overview.activeToday");
    expect(
      active?.querySelector('[data-testid="team-member-card-active"]')
    ).not.toBeNull();
    expect(
      active?.querySelectorAll('[data-testid^="team-member-card-"]')
    ).toHaveLength(1);
    expect(inactive?.textContent).toContain("overview.inactiveToday");
    expect(
      inactive?.querySelector('[data-testid="team-member-card-zero-today"]')
    ).not.toBeNull();
    expect(
      inactive?.querySelector('[data-testid="team-member-card-yesterday"]')
    ).not.toBeNull();
  });

  it("keeps stale cards fully visible while preserving freshness metadata", async () => {
    mocks.listMemberRuntime.mockResolvedValue([
      member({ userId: "fresh" }),
      member({
        userId: "sleepy",
        reportedAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
      }),
      member({
        userId: "silent",
        reportedAt: null,
        machine: null,
        sample: null,
      }),
    ]);
    await seedAtoms(AUTH, [org()]);
    await mount({ view: "members" });

    const fresh = container.querySelector(
      '[data-testid="team-member-card-fresh"]'
    );
    const sleepy = container.querySelector(
      '[data-testid="team-member-card-sleepy"]'
    );
    const silent = container.querySelector(
      '[data-testid="team-member-card-silent"]'
    );
    expect(fresh?.getAttribute("data-stale")).toBe("false");
    expect(sleepy?.getAttribute("data-stale")).toBe("true");
    expect(sleepy?.className).not.toContain("opacity-60");
    expect(silent?.getAttribute("data-stale")).toBe("true");
    expect(silent?.className).not.toContain("opacity-60");
    expect(silent?.textContent).toContain("card.neverReported");
  });

  it("renders builder type, machine chips, and installed agents from the catalog", async () => {
    mocks.listMemberRuntime.mockResolvedValue([member()]);
    await seedAtoms(AUTH, [org()]);
    await mount({ view: "members" });

    expect(mocks.useCloudOrgRemoteSessions).not.toHaveBeenCalled();
    const card = container.querySelector(
      '[data-testid="team-member-card-user-a"]'
    );
    // Builder type: portrait + code + archetype name from the shared catalog.
    expect(
      card?.querySelector('[data-testid="builder-type-avatar-EAWH"]')
    ).not.toBeNull();
    expect(card?.textContent).toContain("EAWH");
    expect(card?.textContent).toContain("Swarm Founder");
    // CPU% and RAM used-of-total (GPU absent: no name, null percent).
    expect(card?.textContent).toContain("card.cpu 42%");
    expect(card?.textContent).toContain("card.ram 13/32 GB");
    // Known id → icon; unknown id → raw id; not_detected → hidden.
    expect(
      card?.querySelector('[data-testid="model-icon-claude"]')
    ).not.toBeNull();
    expect(
      card?.querySelector('[data-testid="team-agent-mystery-cli"]')?.textContent
    ).toBe("mystery-cli");
    expect(card?.querySelector('[data-testid="team-agent-codex"]')).toBeNull();
    // Lifetime session census + explicit last-synced line.
    expect(
      card?.querySelector('[data-testid="team-member-sessions-user-a"]')
        ?.textContent
    ).toContain("128");
    expect(
      card?.querySelector('[data-testid="team-member-synced-user-a"]')
        ?.textContent
    ).toContain("card.lastSynced");
  });
});

describe("TeamRuntimePanel drilldown", () => {
  it("defaults to 7d daily usage and switches to the inline rolling-24h view", async () => {
    const today = utcDayFromMs(Date.now());
    const yesterday = utcDayFromMs(Date.now() - 86_400_000);
    mocks.listMemberRuntime.mockResolvedValue([
      member({
        stats: {
          totalSessions: 128,
          recentUsage24h: recentUsage24h(77, 1.5),
        },
      }),
    ]);
    mocks.getMemberUsage.mockResolvedValue([
      usageDay({ day: yesterday, inputTokens: 10, costUsd: 1 }),
      usageDay({ day: today, inputTokens: 20, costUsd: 2 }),
      usageDay({ day: today, bucket: "other", inputTokens: 5, costUsd: 0.5 }),
    ]);
    await seedAtoms(AUTH, [org()]);
    await mount({ view: "members" });

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="team-member-card-user-a"]'
        )
        ?.click();
    });
    for (let i = 0; i < 6; i += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }

    expect(mocks.getMemberUsage).toHaveBeenCalledTimes(1);
    const [token, orgId, userId, fromDay, toDay] =
      mocks.getMemberUsage.mock.calls[0];
    expect(token).toBe("token-1");
    expect(orgId).toBe("org-1");
    expect(userId).toBe("user-a");
    expect(toDay).toBe(today);
    expect(fromDay).toBe(utcDayFromMs(Date.now() - 6 * 86_400_000));

    const rangeSelect = container.querySelector<HTMLSelectElement>(
      '[data-testid="team-member-usage-range"]'
    );
    expect(rangeSelect?.value).toBe("7");

    const chart = container.querySelector(
      '[data-testid="team-usage-trend-chart"]'
    );
    expect(chart).not.toBeNull();
    const points = JSON.parse(chart?.getAttribute("data-points") ?? "[]") as {
      bucketMs: number;
      inputTokens: number;
    }[];
    expect(points).toHaveLength(2);
    expect(points[0].bucketMs).toBe(utcDayStartMs(yesterday));
    expect(points[1].bucketMs).toBe(utcDayStartMs(today));
    expect(points[1].inputTokens).toBe(25);

    const detailHeader = container.querySelector(
      '[data-testid="team-member-detail-header"]'
    );
    expect(
      detailHeader?.querySelector('[data-testid="team-member-back"]')
    ).not.toBeNull();
    expect(
      detailHeader?.querySelector('[data-testid="team-runtime-refresh"]')
    ).not.toBeNull();
    expect(
      container.querySelectorAll('[data-testid="team-runtime-refresh"]')
    ).toHaveLength(1);

    await act(async () => {
      if (!rangeSelect) return;
      rangeSelect.value = "24h";
      rangeSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const hourlyChart = container.querySelector(
      '[data-testid="team-usage-trend-chart"]'
    );
    expect(hourlyChart?.getAttribute("data-hourly")).toBe("true");
    expect(
      JSON.parse(hourlyChart?.getAttribute("data-points") ?? "[]")[0]
        ?.inputTokens
    ).toBe(77);
    expect(mocks.getMemberUsage).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="tab-pill"]')).toBeNull();

    // Member without a shared profile degrades gracefully.
    expect(
      container.querySelector('[data-testid="team-member-no-profile"]')
        ?.textContent
    ).toContain("detail.noProfile");

    // Back returns to the roster grid.
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="team-member-back"]')
        ?.click();
    });
    expect(
      container.querySelector('[data-testid="team-runtime-grid"]')
    ).not.toBeNull();
  });

  it("shows an empty 24h state for a peer that has not pushed the additive snapshot yet", async () => {
    mocks.listMemberRuntime.mockResolvedValue([member()]);
    mocks.getMemberUsage.mockResolvedValue([usageDay()]);
    await seedAtoms(AUTH, [org()]);
    await mount({ view: "members" });

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="team-member-card-user-a"]'
        )
        ?.click();
    });
    await drainMicrotasks();

    const rangeSelect = container.querySelector<HTMLSelectElement>(
      '[data-testid="team-member-usage-range"]'
    );
    await act(async () => {
      if (!rangeSelect) return;
      rangeSelect.value = "24h";
      rangeSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(
      container.querySelector('[data-testid="placeholder-empty"]')?.textContent
    ).toContain("detail.usageEmpty");
    expect(
      container.querySelector('[data-testid="placeholder-loading"]')
    ).toBeNull();
  });
});

// Covers the live bug: cloud auth exists but `org2CloudOrgsAtom`'s token
// refresh silently failed (auth was NOT cleared), so `org2CloudOrgsLoadedAtom`
// never flips true. Without a stall bound, the panel spun on "loading"
// forever with no recovery affordance.
describe("TeamRuntimePanel org load stall", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("flips to an error phase with retry if cloud orgs never load", async () => {
    vi.useFakeTimers();
    await seedAtoms(AUTH, [], /* orgsLoaded */ false);
    await mount();

    expect(
      container.querySelector('[data-testid="placeholder-loading"]')
    ).not.toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });

    const error = container.querySelector('[data-testid="placeholder-error"]');
    expect(error).not.toBeNull();
    expect(error?.textContent).toContain("loadError");
    expect(error?.textContent).toContain(
      "Couldn't load your cloud organizations"
    );
    expect(container.querySelector('[data-testid="retry"]')).not.toBeNull();
  });

  it("does not error out if orgs load before the stall window elapses", async () => {
    vi.useFakeTimers();
    await seedAtoms(AUTH, [], /* orgsLoaded */ false);
    await mount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    const { org2CloudOrgsAtom, org2CloudOrgsLoadedAtom } =
      await import("@src/features/Org2Cloud/org2CloudOrgsAtom");
    await act(async () => {
      store.set(org2CloudOrgsAtom, [org()]);
      store.set(org2CloudOrgsLoadedAtom, true);
    });
    await drainMicrotasks();

    // Past the original 20s window from mount, but the stall condition
    // lifted once the org arrived, so no error should ever have latched.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });

    expect(
      container.querySelector('[data-testid="placeholder-error"]')
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="team-runtime-today-members"]')
        ?.textContent
    ).toContain("0/0");
  });

  it("retry resets the stall window instead of latching the error forever", async () => {
    vi.useFakeTimers();
    await seedAtoms(AUTH, [], /* orgsLoaded */ false);
    await mount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(
      container.querySelector('[data-testid="placeholder-error"]')
    ).not.toBeNull();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="retry"]')
        ?.click();
    });
    await drainMicrotasks();

    // Retry re-armed the window: back to loading, not stuck on error.
    expect(
      container.querySelector('[data-testid="placeholder-error"]')
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="placeholder-loading"]')
    ).not.toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(19_000);
    });
    expect(
      container.querySelector('[data-testid="placeholder-error"]')
    ).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(
      container.querySelector('[data-testid="placeholder-error"]')
    ).not.toBeNull();
  });
});
