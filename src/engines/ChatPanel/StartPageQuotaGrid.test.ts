// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { StartPageQuotaGrid } from "./StartPageQuotaGrid";

const keyVaultMocks = vi.hoisted(() => ({
  accounts: [] as Array<{
    id: string;
    name: string;
    status: "ready" | "needs_setup";
    canRefreshQuota?: boolean;
  }>,
  getAccount: vi.fn(),
  refresh: vi.fn(),
  refreshAccount: vi.fn(),
  resetTime: null as string | null,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      if (key === "chat.startPage.quota.refresh") return "Refresh";
      return key;
    },
  }),
}));

vi.mock("@src/hooks/keyVault", () => ({
  useKeyVault: () => ({
    ...keyVaultMocks,
  }),
}));

vi.mock("@src/components/ModelIcon", () => ({
  default: () => createElement("span", { "data-testid": "model-icon" }),
}));

vi.mock("@src/hooks/keyVault/accountQuotaDisplay", () => ({
  collectAccountQuotaCards: () =>
    Array.from({ length: 5 }, (_, index) => ({
      id: `account-${index + 1}`,
      accountName: index === 0 ? "Codex account" : `Account ${index + 1}`,
      accountPlan: "Plus",
      modelType: "codex",
      metrics: [
        ...(index === 0
          ? [
              {
                kind: "value" as const,
                key: "balance",
                label: "Balance",
                value: "$12.34",
              },
            ]
          : []),
        {
          kind: "percentage" as const,
          key: "weekly",
          label: "Weekly",
          remainingPercent: 75,
          resetTime: keyVaultMocks.resetTime,
        },
      ],
    })),
  formatQuotaResetHint: () => null,
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  keyVaultMocks.accounts = [];
  keyVaultMocks.resetTime = null;
});

afterAll(() => {
  Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
});

describe("StartPageQuotaGrid", () => {
  it("renders a flat quota grid with a labeled refresh action", () => {
    const markup = renderToStaticMarkup(createElement(StartPageQuotaGrid));

    const refreshIndex = markup.indexOf('aria-label="Refresh"');
    const quotaCardIndex = markup.indexOf("Codex account");

    expect(markup).not.toContain("Quota Usage");
    expect(markup).not.toContain("chat-panel-start-page-quota-toggle");
    expect(refreshIndex).toBeGreaterThanOrEqual(0);
    expect(quotaCardIndex).toBeGreaterThan(refreshIndex);
    expect(markup).toContain('data-testid="quota-refresh-controls"');
    expect(markup).toContain(
      'class="sticky top-0 z-20 -mx-4 bg-chat-pane px-4 pb-1"'
    );
    expect(markup).toContain("flex flex-col gap-3 @container/quota");
    expect(markup).toContain("kanban.dataSource.views.quota");
    expect(markup).toContain("flex min-h-9 items-center justify-between gap-3");
    expect(markup).toContain("border-0 bg-transparent text-text-2");
    expect(markup).toContain(
      "truncate text-xs font-semibold leading-4 text-text-1"
    );
    expect(markup).toContain("truncate text-[11px] leading-4 text-text-3");
    expect(markup).toContain("min-w-0 p-3 rounded-lg");
    expect(markup).toContain("mb-2 flex min-w-0 items-center gap-2");
    expect(markup).toContain("space-y-2.5");
    expect(markup).toContain("Balance");
    expect(markup).toContain("$12.34");
    expect(markup).toContain('class="space-y-1"');
    expect(markup).toContain(
      "grid grid-cols-1 gap-3 @[640px]/quota:grid-cols-2"
    );
    expect(markup).not.toContain("grid gap-2");
    expect(markup).toContain(
      "flex items-center justify-between gap-2 text-[11px] leading-4"
    );
  });

  it("renders every quota card without pagination", () => {
    const markup = renderToStaticMarkup(createElement(StartPageQuotaGrid));

    expect(markup).toContain("Account 5");
    expect(markup).not.toContain("chat.startPage.hints.previous");
    expect(markup).not.toContain("chat.startPage.hints.next");
    expect(markup).not.toContain("1 / 2");
  });

  it("bounds account refreshes and stops queued work when unmounted", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(performance.now()), 0)
    );
    vi.stubGlobal("cancelAnimationFrame", (handle: number) =>
      window.clearTimeout(handle)
    );
    const pendingRefreshes: Array<() => void> = [];
    keyVaultMocks.refreshAccount.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          pendingRefreshes.push(() => resolve(true));
        })
    );

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(StartPageQuotaGrid));
    });
    const refreshButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Refresh"]'
    );
    expect(refreshButton).not.toBeNull();

    await act(async () => {
      refreshButton?.click();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(keyVaultMocks.refreshAccount).toHaveBeenCalledTimes(3);
    expect(keyVaultMocks.refreshAccount).toHaveBeenNthCalledWith(
      1,
      "account-1",
      true
    );

    act(() => root.unmount());
    await act(async () => {
      pendingRefreshes.forEach((resolve) => resolve());
      await Promise.resolve();
    });

    expect(keyVaultMocks.refreshAccount).toHaveBeenCalledTimes(3);
    expect(keyVaultMocks.refresh).not.toHaveBeenCalled();
    container.remove();
  });

  it("uses the freshness cache for automatic visible-window refreshes", async () => {
    vi.useFakeTimers();
    keyVaultMocks.refreshAccount.mockResolvedValue(true);

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(StartPageQuotaGrid));
    });
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(50);
    });

    expect(keyVaultMocks.refreshAccount).toHaveBeenCalledTimes(5);
    for (const call of keyVaultMocks.refreshAccount.mock.calls) {
      expect(call[1]).toBe(false);
    }
    expect(keyVaultMocks.refresh).not.toHaveBeenCalled();

    act(() => root.unmount());
    container.remove();
  });

  it("discovers refreshable accounts before they have quota cards", async () => {
    vi.useFakeTimers();
    keyVaultMocks.accounts = [
      {
        id: "deepseek-without-quota",
        name: "DeepSeek",
        status: "ready",
        canRefreshQuota: true,
      },
    ];
    keyVaultMocks.refreshAccount.mockResolvedValue(true);

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(StartPageQuotaGrid));
    });
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(50);
    });

    expect(keyVaultMocks.refreshAccount).toHaveBeenCalledWith(
      "deepseek-without-quota",
      false
    );

    act(() => root.unmount());
    container.remove();
  });

  it("refreshes through the cache just after the next quota reset", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-31T00:00:00.000Z"));
    keyVaultMocks.resetTime = "2026-07-31T00:00:01.000Z";
    keyVaultMocks.refreshAccount.mockResolvedValue(true);

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(StartPageQuotaGrid));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    expect(keyVaultMocks.refreshAccount).toHaveBeenCalledTimes(5);
    for (const call of keyVaultMocks.refreshAccount.mock.calls) {
      expect(call[1]).toBe(false);
    }

    act(() => root.unmount());
    container.remove();
  });
});
