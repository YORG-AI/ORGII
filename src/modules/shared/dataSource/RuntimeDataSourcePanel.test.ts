// @vitest-environment jsdom
import { getDefaultStore } from "jotai";
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

import { org2CloudAuthAtom } from "@src/features/Org2Cloud/org2CloudAuthAtom";
import {
  org2CloudOrgsAtom,
  org2CloudOrgsLoadedAtom,
  sidebarActiveCloudOrgIdAtom,
} from "@src/features/Org2Cloud/org2CloudOrgsAtom";
import { GUIDE_TARGETS } from "@src/scaffold/Tutorials/guideTargets";
import { runtimeNavigationIntentAtom } from "@src/store/ui/runtimeNavigationAtom";

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

vi.mock("@src/features/Org2Cloud/org2CloudAuthAtom", async () => {
  const { atom } = await import("jotai");
  return { org2CloudAuthAtom: atom(null) };
});

vi.mock("@src/features/Org2Cloud/org2CloudOrgsAtom", async () => {
  const { atom } = await import("jotai");
  return {
    org2CloudOrgsAtom: atom([]),
    org2CloudOrgsLoadedAtom: atom(true),
    sidebarActiveCloudOrgIdAtom: atom(null),
    buildCloudOrgSelectorValue: (orgId: string) => `cloud:${orgId}`,
    parseCloudOrgSelectorValue: (value: string) =>
      value.startsWith("cloud:") ? value.slice("cloud:".length) : null,
  };
});

vi.mock("@src/components/Select", () => ({
  default: ({
    value,
    options = [],
    onChange,
    dataTestId,
  }: {
    value?: unknown;
    options?: Array<{ value: unknown; label: string }>;
    onChange?: (value: unknown) => void;
    dataTestId?: string;
  }) =>
    createElement(
      "select",
      {
        value: String(value),
        "data-testid": dataTestId,
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

vi.mock("./TeamRuntimePanel", () => ({
  default: ({ orgId, view }: { orgId?: string; view?: string }) =>
    createElement("div", {
      "data-testid": "runtime-section-organization",
      "data-org-id": orgId,
      "data-view": view,
    }),
}));

vi.mock(
  "@src/engines/ChatPanel/panels/CloudOrgPanelView/CloudOrgSyncTab",
  () => ({
    default: ({ orgId }: { orgId: string }) =>
      createElement("div", {
        "data-testid": "runtime-section-org-sync",
        "data-org-id": orgId,
      }),
  })
);

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
const store = getDefaultStore();

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
    store.set(org2CloudAuthAtom, null);
    store.set(org2CloudOrgsAtom, []);
    store.set(org2CloudOrgsLoadedAtom, true);
    store.set(sidebarActiveCloudOrgIdAtom, null);
    store.set(runtimeNavigationIntentAtom, null);
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
    const picker = container.innerHTML.indexOf("runtime-scope-picker");
    const usage = container.innerHTML.indexOf("data-source-view-usage");
    const profile = container.innerHTML.indexOf("data-source-view-profile");
    const quota = container.innerHTML.indexOf("data-source-view-quota");
    const scanning = container.innerHTML.indexOf("data-source-view-scanning");
    const hooks = container.innerHTML.indexOf("data-source-view-hooks");
    const assets = container.innerHTML.indexOf("data-source-view-assets");

    expect(picker).toBeGreaterThanOrEqual(0);
    expect(usage).toBeGreaterThan(picker);
    expect(profile).toBeGreaterThan(usage);
    expect(quota).toBeGreaterThan(profile);
    expect(scanning).toBeGreaterThan(quota);
    expect(hooks).toBeGreaterThan(scanning);
    expect(assets).toBeGreaterThan(hooks);
    expect(
      container.querySelector('[data-testid="data-source-scroll-region"]')
        ?.className
    ).toContain("overflow-y-auto");
  });

  it("keeps type categories out of the Runtime tab bar", () => {
    expect(
      container.querySelector('[data-testid="data-source-view-types"]')
    ).toBeNull();
  });

  it("switches from Personal tabs to the selected organization's Today and Members tabs", async () => {
    await act(async () => {
      store.set(org2CloudAuthAtom, {
        kind: "org2_cloud",
        supabaseUrl: "https://cloud.example",
        supabaseAnonKey: "anon",
        userId: "me",
        accessToken: "token",
        refreshToken: "refresh",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      });
      store.set(org2CloudOrgsAtom, [
        { orgId: "org-1", name: "Example Team", role: "member" },
      ]);
    });

    const scopePicker = container.querySelector<HTMLSelectElement>(
      '[data-testid="runtime-scope-picker"]'
    );
    expect(scopePicker).not.toBeNull();
    await act(async () => {
      if (!scopePicker) return;
      scopePicker.value = "cloud:org-1";
      scopePicker.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      await vi.dynamicImportSettled();
      await Promise.resolve();
    });

    expect(
      container.querySelector('[data-testid="data-source-view-usage"]')
    ).toBeNull();
    expect(
      container
        .querySelector('[data-testid="data-source-view-org-today"]')
        ?.getAttribute("data-active")
    ).toBe("true");
    const orgPanel = container.querySelector(
      '[data-testid="runtime-section-organization"]'
    );
    expect(orgPanel?.getAttribute("data-org-id")).toBe("org-1");
    expect(orgPanel?.getAttribute("data-view")).toBe("today");

    await selectSection("data-source-view-org-members");
    expect(
      container
        .querySelector('[data-testid="runtime-section-organization"]')
        ?.getAttribute("data-view")
    ).toBe("members");

    // Sync is the org-management Sync tab rendered here, so it takes the org
    // id directly instead of a TeamRuntimePanel view.
    await selectSection("data-source-view-org-sync");
    expect(
      container.querySelector('[data-testid="runtime-section-organization"]')
    ).toBeNull();
    expect(
      container
        .querySelector('[data-testid="runtime-section-org-sync"]')
        ?.getAttribute("data-org-id")
    ).toBe("org-1");
  });

  it("consumes a guide intent and opens the requested organization's Members view", async () => {
    await act(async () => {
      store.set(org2CloudAuthAtom, {
        kind: "org2_cloud",
        supabaseUrl: "https://cloud.example",
        supabaseAnonKey: "anon",
        userId: "me",
        accessToken: "token",
        refreshToken: "refresh",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      });
      store.set(org2CloudOrgsAtom, [
        { orgId: "org-1", name: "Example Team", role: "member" },
      ]);
      store.set(runtimeNavigationIntentAtom, {
        requestId: 42,
        scope: "organization",
        orgId: "org-1",
        view: "members",
      });
    });
    await act(async () => {
      await vi.dynamicImportSettled();
      await Promise.resolve();
    });

    expect(
      container
        .querySelector('[data-testid="data-source-view-org-members"]')
        ?.getAttribute("data-active")
    ).toBe("true");
    expect(
      container
        .querySelector('[data-testid="runtime-section-organization"]')
        ?.getAttribute("data-org-id")
    ).toBe("org-1");
    expect(
      container
        .querySelector('[data-testid="runtime-section-organization"]')
        ?.getAttribute("data-view")
    ).toBe("members");
    expect(
      container.querySelector(
        `[data-guide-target="${GUIDE_TARGETS.TEAM_RUNTIME_TABS}"]`
      )
    ).not.toBeNull();
    expect(store.get(runtimeNavigationIntentAtom)).toBeNull();
  });

  it("drops an intent for a removed organization without changing the personal view", async () => {
    await act(async () => {
      store.set(runtimeNavigationIntentAtom, {
        requestId: 43,
        scope: "organization",
        orgId: "removed-org",
        view: "members",
      });
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(
      container.querySelector('[data-testid="runtime-section-usage"]')
    ).not.toBeNull();
    expect(
      container.querySelector(
        `[data-guide-target="${GUIDE_TARGETS.TEAM_RUNTIME_TABS}"]`
      )
    ).toBeNull();
    expect(store.get(runtimeNavigationIntentAtom)).toBeNull();
  });

  it("consumes a scanning intent and returns from an organization scope to the personal Scanning tab", async () => {
    await act(async () => {
      store.set(org2CloudAuthAtom, {
        kind: "org2_cloud",
        supabaseUrl: "https://cloud.example",
        supabaseAnonKey: "anon",
        userId: "me",
        accessToken: "token",
        refreshToken: "refresh",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      });
      store.set(org2CloudOrgsAtom, [
        { orgId: "org-1", name: "Example Team", role: "member" },
      ]);
    });
    const scopePicker = container.querySelector<HTMLSelectElement>(
      '[data-testid="runtime-scope-picker"]'
    );
    await act(async () => {
      if (!scopePicker) return;
      scopePicker.value = "cloud:org-1";
      scopePicker.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      await vi.dynamicImportSettled();
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="runtime-section-organization"]')
    ).not.toBeNull();

    await act(async () => {
      store.set(runtimeNavigationIntentAtom, {
        requestId: 44,
        scope: "personal",
        view: "scanning",
      });
    });
    await act(async () => {
      await vi.dynamicImportSettled();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(
      container.querySelector('[data-testid="runtime-section-scanning"]')
    ).not.toBeNull();
    expect(
      container
        .querySelector('[data-testid="data-source-view-scanning"]')
        ?.getAttribute("data-active")
    ).toBe("true");
    expect(
      container.querySelector('[data-testid="runtime-section-organization"]')
    ).toBeNull();
    expect(store.get(runtimeNavigationIntentAtom)).toBeNull();
  });

  it("opens Scanning without waiting for cloud organizations to load", async () => {
    await act(async () => {
      store.set(org2CloudOrgsLoadedAtom, false);
      store.set(runtimeNavigationIntentAtom, {
        requestId: 45,
        scope: "personal",
        view: "scanning",
      });
    });
    await act(async () => {
      await vi.dynamicImportSettled();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(
      container.querySelector('[data-testid="runtime-section-scanning"]')
    ).not.toBeNull();
    expect(store.get(runtimeNavigationIntentAtom)).toBeNull();
  });
});
