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

import RuntimeDataSourcePanel from ".";

const lifecycle = vi.hoisted(() => ({
  usageUnmounted: vi.fn(),
  quotaUnmounted: vi.fn(),
  scanningUnmounted: vi.fn(),
  hooksUnmounted: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("./SessionUsagePanel", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  function UsageSectionMock() {
    React.useEffect(() => lifecycle.usageUnmounted, []);
    return React.createElement("div", {
      "data-testid": "runtime-section-usage",
    });
  }
  return {
    default: UsageSectionMock,
  };
});

vi.mock("@src/engines/ChatPanel/StartPageQuotaGrid", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  function QuotaSectionMock() {
    React.useEffect(() => lifecycle.quotaUnmounted, []);
    return React.createElement("div", {
      "data-testid": "runtime-section-quota",
    });
  }
  return {
    StartPageQuotaGrid: QuotaSectionMock,
  };
});

vi.mock("./RuntimeScanningPanel", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  function ScanningSectionMock() {
    React.useEffect(() => lifecycle.scanningUnmounted, []);
    return React.createElement("div", {
      "data-testid": "runtime-section-scanning",
    });
  }
  return {
    default: ScanningSectionMock,
  };
});

vi.mock("./SessionProvenanceHooksPanel", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  function HooksSectionMock() {
    React.useEffect(() => lifecycle.hooksUnmounted, []);
    return React.createElement("div", {
      "data-testid": "runtime-section-hooks",
    });
  }
  return {
    default: HooksSectionMock,
  };
});

vi.mock(
  "@src/engines/ChatPanel/panels/WorkspaceDashboardPanelView",
  async () => {
    const React = await vi.importActual<typeof import("react")>("react");
    return {
      default: () =>
        React.createElement("div", {
          "data-testid": "runtime-section-assets",
        }),
    };
  }
);

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe("RuntimeDataSourcePanel", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal(
      "ResizeObserver",
      class ResizeObserverMock {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
  });

  beforeEach(async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
    await act(async () => {
      root.render(createElement(RuntimeDataSourcePanel));
    });
    await act(async () => {
      await vi.dynamicImportSettled();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
    vi.unstubAllGlobals();
  });

  const selectSection = async (testId: string) => {
    const button = container.querySelector<HTMLButtonElement>(
      `[data-testid="${testId}"]`
    );
    expect(button).not.toBeNull();
    await act(async () => {
      button?.click();
    });
    await act(async () => {
      await vi.dynamicImportSettled();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  };

  it("mounts only the active lazy section and disposes it on navigation", async () => {
    expect(
      container.querySelector('[data-testid="runtime-section-usage"]')
    ).not.toBeNull();

    await selectSection("data-source-view-quota");
    expect(lifecycle.usageUnmounted).toHaveBeenCalledTimes(1);
    expect(
      container.querySelector('[data-testid="runtime-section-usage"]')
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="runtime-section-quota"]')
    ).not.toBeNull();

    await selectSection("data-source-view-scanning");
    expect(lifecycle.quotaUnmounted).toHaveBeenCalledTimes(1);
    expect(
      container.querySelector('[data-testid="runtime-section-scanning"]')
    ).not.toBeNull();

    await selectSection("data-source-view-hooks");
    expect(lifecycle.scanningUnmounted).toHaveBeenCalledTimes(1);
    expect(
      container.querySelector('[data-testid="runtime-section-hooks"]')
    ).not.toBeNull();

    await selectSection("data-source-view-assets");
    expect(lifecycle.hooksUnmounted).toHaveBeenCalledTimes(1);
    expect(
      container.querySelector('[data-testid="runtime-section-assets"]')
    ).not.toBeNull();
    expect(
      container.querySelectorAll('[data-testid^="runtime-section-"]')
    ).toHaveLength(1);
  });

  it("preserves the Runtime navigation and scroll ownership", () => {
    const usage = container.innerHTML.indexOf("data-source-view-usage");
    const quota = container.innerHTML.indexOf("data-source-view-quota");
    const scanning = container.innerHTML.indexOf("data-source-view-scanning");
    const hooks = container.innerHTML.indexOf("data-source-view-hooks");
    const assets = container.innerHTML.indexOf("data-source-view-assets");

    expect(usage).toBeGreaterThanOrEqual(0);
    expect(quota).toBeGreaterThan(usage);
    expect(scanning).toBeGreaterThan(quota);
    expect(hooks).toBeGreaterThan(scanning);
    expect(assets).toBeGreaterThan(hooks);
    expect(
      container.querySelector('[data-testid="data-source-scroll-region"]')
        ?.className
    ).toContain("overflow-y-auto");
  });
});
