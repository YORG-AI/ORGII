// @vitest-environment jsdom
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
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

import SessionProvenanceRecentSignalsTable from "./SessionProvenanceRecentSignalsTable";

const mocks = vi.hoisted(() => ({
  recentSignals: vi.fn(),
}));

vi.mock("@src/api/tauri/rpc", () => ({
  rpc: {
    agentOrgs: {
      sessionProvenance: {
        recentSignals: mocks.recentSignals,
      },
    },
  },
}));

vi.mock("@src/api/tauri/lineage", () => ({
  getOrgtrackSessionFinalDiffs: vi.fn().mockResolvedValue([]),
}));

vi.mock("@src/hooks/ui/tabs/useSessionView", () => ({
  useSessionView: () => ({ openSession: vi.fn() }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en", resolvedLanguage: "en" },
  }),
}));

vi.mock("@src/components/SettingsTable", () => ({
  default: ({
    pageSize,
    pageSizeOptions,
    rows,
  }: {
    pageSize?: number;
    pageSizeOptions?: number[];
    rows: unknown[];
  }) =>
    createElement("div", {
      "data-page-size": String(pageSize),
      "data-page-size-options": pageSizeOptions?.join(","),
      "data-row-count": String(rows.length),
      "data-testid": "recent-signals-table",
    }),
  SETTINGS_TABLE_CELL: { primaryIcon: "primary-icon" },
  SETTINGS_TABLE_COL: { valueLg: "160px", valueMd: "120px" },
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

function createSignals(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    source: "codex_app",
    sessionId: `session-${index}`,
    sessionTitle: `Session ${index}`,
    filePath: `src/file-${index}.ts`,
    workspacePath: "/workspace",
    action: "read",
    outcome: "succeeded",
    occurredAt: "2026-07-23T00:00:00.000Z",
    captureMethod: "hook",
  }));
}

describe("SessionProvenanceRecentSignalsTable", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.recentSignals.mockReset().mockResolvedValue(createSignals(11));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("stays collapsed and defers its bounded query until expansion", async () => {
    await act(async () => {
      root.render(createElement(SessionProvenanceRecentSignalsTable));
    });

    expect(mocks.recentSignals).not.toHaveBeenCalled();
    expect(
      container.querySelector('[data-testid="recent-signals-table"]')
    ).toBeNull();

    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="session-provenance-recent-signals-toggle"]'
    );
    await act(async () => toggle?.click());

    expect(mocks.recentSignals).toHaveBeenCalledTimes(1);
    expect(mocks.recentSignals).toHaveBeenCalledWith({ limit: 50 });
    const table = container.querySelector(
      '[data-testid="recent-signals-table"]'
    );
    expect(table?.getAttribute("data-row-count")).toBe("11");
    expect(table?.getAttribute("data-page-size")).toBe("10");
    expect(table?.getAttribute("data-page-size-options")).toBe("10,25,50");

    await act(async () => toggle?.click());
    expect(
      container.querySelector('[data-testid="recent-signals-table"]')
    ).toBeNull();

    mocks.recentSignals.mockResolvedValue(createSignals(3));
    await act(async () => toggle?.click());
    expect(mocks.recentSignals).toHaveBeenCalledTimes(2);
    expect(
      container
        .querySelector('[data-testid="recent-signals-table"]')
        ?.getAttribute("data-row-count")
    ).toBe("3");
  });

  it("shares an in-flight query across a close and reopen", async () => {
    let resolveSignals!: (value: ReturnType<typeof createSignals>) => void;
    mocks.recentSignals.mockReturnValue(
      new Promise<ReturnType<typeof createSignals>>((resolve) => {
        resolveSignals = resolve;
      })
    );

    await act(async () => {
      root.render(createElement(SessionProvenanceRecentSignalsTable));
    });

    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="session-provenance-recent-signals-toggle"]'
    );
    await act(async () => toggle?.click());
    expect(mocks.recentSignals).toHaveBeenCalledTimes(1);

    await act(async () => toggle?.click());
    await act(async () => toggle?.click());
    expect(mocks.recentSignals).toHaveBeenCalledTimes(1);

    await act(async () => resolveSignals(createSignals(12)));
    expect(
      container
        .querySelector('[data-testid="recent-signals-table"]')
        ?.getAttribute("data-row-count")
    ).toBe("12");
  });
});
