// @vitest-environment jsdom
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import SessionUsagePanel from "./SessionUsagePanel";

const mocks = vi.hoisted(() => ({
  usageDashboardOverview: vi.fn(),
}));

vi.mock("@src/api/tauri/usageDashboard", () => ({
  USAGE_BUCKETS: ["codex"],
  usageDashboardOverview: mocks.usageDashboardOverview,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en", resolvedLanguage: "en" },
  }),
}));

vi.mock("./UsageRoundsTable", () => ({
  default: ({
    loaded,
    onOpenChange,
    onRefresh,
    rows,
  }: {
    loaded: boolean;
    onOpenChange: (open: boolean) => void;
    onRefresh: () => void;
    rows: unknown[];
  }) =>
    createElement(
      "div",
      {
        "data-loaded": String(loaded),
        "data-round-count": String(rows.length),
        "data-testid": "usage-rounds-table",
      },
      createElement("button", {
        "data-testid": "usage-rounds-toggle",
        onClick: () => onOpenChange(true),
      }),
      createElement("button", {
        "data-testid": "usage-rounds-close",
        onClick: () => onOpenChange(false),
      }),
      createElement("button", {
        "data-testid": "usage-rounds-refresh",
        onClick: onRefresh,
      })
    ),
  USAGE_ROUNDS_DEFAULT_PAGE_SIZE: 10,
}));

vi.mock("./UsageStatCards", () => ({ default: () => null }));
vi.mock("./UsageTrendChart", () => ({ default: () => null }));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

const createOverview = (rounds: unknown[] = []) => ({
  summary: { sessionCount: 1 },
  trends: [],
  rounds,
  roundTotal: rounds.length,
  roundModels: [],
  hasUnknownRoundModel: false,
});

describe("SessionUsagePanel", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.stubGlobal(
      "ResizeObserver",
      class ResizeObserverMock {
        observe = vi.fn();
        unobserve = vi.fn();
        disconnect = vi.fn();
      }
    );
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    mocks.usageDashboardOverview
      .mockReset()
      .mockResolvedValue(createOverview());
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  afterAll(() => {
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("pins the source and range controls above the scrolling usage content", () => {
    const markup = renderToStaticMarkup(createElement(SessionUsagePanel));

    expect(markup).toContain('data-testid="usage-source-controls"');
    expect(markup).toContain(
      'class="sticky top-0 z-20 -mx-4 bg-chat-pane px-4 pb-1"'
    );
    expect(markup).toContain("flex flex-col gap-3");
    expect(markup).toContain("flex min-h-9 flex-wrap items-center");
    expect(markup).toContain('data-testid="usage-source-range-controls"');
    expect(markup).toContain("h-4 w-px shrink-0 bg-border-2");
    expect(markup).toContain("select-size-small");
    expect(markup).toContain("bg-fill-1 font-semibold text-primary-6");
    expect(markup).toContain('data-testid="usage-title-controls"');
    expect(markup).toContain('data-testid="usage-refresh"');
    expect(markup).toContain('aria-label="usage.refresh"');
    expect(markup).toContain("usage.title");
  });

  it("refreshes headline data and an open request page together", async () => {
    await act(async () => {
      root.render(createElement(SessionUsagePanel));
    });

    const open = container.querySelector<HTMLButtonElement>(
      '[data-testid="usage-rounds-toggle"]'
    );
    await act(async () => open?.click());
    expect(mocks.usageDashboardOverview).toHaveBeenCalledTimes(2);

    const refresh = container.querySelector<HTMLButtonElement>(
      '[data-testid="usage-refresh"]'
    );
    expect(refresh).not.toBeNull();

    await act(async () => refresh?.click());
    expect(mocks.usageDashboardOverview).toHaveBeenCalledTimes(4);
    expect(mocks.usageDashboardOverview.mock.calls[2]?.[1]).toMatchObject({
      includeRounds: false,
    });
    expect(mocks.usageDashboardOverview.mock.calls[3]?.[1]).toMatchObject({
      includeHeadline: false,
      includeRounds: true,
    });
  });

  it("loads requests on expansion and refreshes them only after a click", async () => {
    mocks.usageDashboardOverview.mockImplementation(
      (_scope: unknown, options?: { includeRounds?: boolean }) =>
        Promise.resolve(
          createOverview(options?.includeRounds ? [{ roundId: "round-1" }] : [])
        )
    );

    await act(async () => {
      root.render(createElement(SessionUsagePanel));
    });

    expect(mocks.usageDashboardOverview).toHaveBeenCalledTimes(1);
    expect(mocks.usageDashboardOverview.mock.calls[0]?.[1]).toMatchObject({
      includeRounds: false,
    });

    vi.useFakeTimers();
    act(() => vi.advanceTimersByTime(5 * 60 * 1_000));
    expect(mocks.usageDashboardOverview).toHaveBeenCalledTimes(1);
    vi.useRealTimers();

    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="usage-rounds-toggle"]'
    );
    expect(toggle).not.toBeNull();

    await act(async () => toggle?.click());
    expect(mocks.usageDashboardOverview).toHaveBeenCalledTimes(2);
    expect(mocks.usageDashboardOverview.mock.calls[1]?.[1]).toMatchObject({
      includeHeadline: false,
      includeRounds: true,
      limit: 10,
      offset: 0,
    });
    expect(
      container
        .querySelector('[data-testid="usage-rounds-table"]')
        ?.getAttribute("data-round-count")
    ).toBe("1");

    const refresh = container.querySelector<HTMLButtonElement>(
      '[data-testid="usage-rounds-refresh"]'
    );
    expect(refresh).not.toBeNull();

    await act(async () => refresh?.click());
    expect(mocks.usageDashboardOverview).toHaveBeenCalledTimes(3);

    const close = container.querySelector<HTMLButtonElement>(
      '[data-testid="usage-rounds-close"]'
    );
    act(() => close?.click());
    const table = container.querySelector('[data-testid="usage-rounds-table"]');
    expect(table?.getAttribute("data-round-count")).toBe("0");
    expect(table?.getAttribute("data-loaded")).toBe("false");
  });

  it("shares an in-flight request page across a close and reopen", async () => {
    let resolveRounds!: (value: ReturnType<typeof createOverview>) => void;
    const pendingRounds = new Promise<ReturnType<typeof createOverview>>(
      (resolve) => {
        resolveRounds = resolve;
      }
    );
    mocks.usageDashboardOverview.mockImplementation(
      (_scope: unknown, options?: { includeRounds?: boolean }) =>
        options?.includeRounds
          ? pendingRounds
          : Promise.resolve(createOverview())
    );

    await act(async () => {
      root.render(createElement(SessionUsagePanel));
    });

    const open = container.querySelector<HTMLButtonElement>(
      '[data-testid="usage-rounds-toggle"]'
    );
    const close = container.querySelector<HTMLButtonElement>(
      '[data-testid="usage-rounds-close"]'
    );

    await act(async () => open?.click());
    expect(mocks.usageDashboardOverview).toHaveBeenCalledTimes(2);

    act(() => close?.click());
    await act(async () => open?.click());
    expect(mocks.usageDashboardOverview).toHaveBeenCalledTimes(2);

    await act(async () => resolveRounds(createOverview()));
  });
});
