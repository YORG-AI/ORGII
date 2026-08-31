// @vitest-environment jsdom
import { Provider, createStore } from "jotai";
import React, { act, useEffect } from "react";
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

import type { CliVersionSnapshot } from "@src/api/tauri/rpc/schemas/validation";
import {
  CLI_UPDATE_ALERT_SNOOZE_MS,
  cliUpdateAlertSuppressionsAtom,
  cliUpdateAlertsEnabledAtom,
} from "@src/store/session";

import { useCliAgentConfiguration } from "./useCliAgentConfiguration";

const mocks = vi.hoisted(() => ({
  getVersion: vi.fn(),
  isVersionRecheckPending: vi.fn(),
  scanVersion: vi.fn(),
  subscribeVersionRecheck: vi.fn(),
  unsubscribeVersionRecheck: vi.fn(),
}));

vi.mock("@src/hooks/cliVersions/useCliVersions", () => ({
  useCliVersions: () => ({
    getVersion: mocks.getVersion,
    isVersionRecheckPending: mocks.isVersionRecheckPending,
    scanVersion: mocks.scanVersion,
    subscribeVersionRecheck: mocks.subscribeVersionRecheck,
  }),
}));

vi.mock(
  "@src/modules/MainApp/Integrations/KeyVault/CliClients/hooks/useCliAgents",
  () => ({
    useCliAgents: () => ({
      agents: [
        {
          name: "codex",
          displayName: "Codex",
          installed: true,
          supportsGui: true,
        },
      ],
    }),
  })
);

vi.mock("@src/hooks/logger", () => ({
  createLogger: () => ({ warn: vi.fn() }),
}));

const codexSnapshot: CliVersionSnapshot = {
  agent_type: "codex",
  installed_version: "0.1.5",
  latest_version: "0.1.6",
  installed_version_error: null,
  latest_version_error: null,
  status: "outdated",
  scanned_at: "2026-08-22T00:00:00.000Z",
  stale: false,
};

describe("useCliAgentConfiguration CLI update alerts", () => {
  let container: HTMLDivElement;
  let root: Root;
  let store: ReturnType<typeof createStore>;
  let hook: ReturnType<typeof useCliAgentConfiguration> | null;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  const Harness = ({ revision = 0 }: { revision?: number }) => {
    const value = useCliAgentConfiguration({
      cliAgentType: "codex",
      isCliMode: true,
    });
    useEffect(() => {
      hook = value;
    }, [revision, value]);
    return null;
  };

  const renderHarness = (revision = 0) => {
    act(() => {
      root.render(
        React.createElement(
          Provider,
          { store },
          React.createElement(Harness, { revision })
        )
      );
    });
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-22T00:00:00.000Z"));
    localStorage.clear();
    mocks.getVersion.mockReset();
    mocks.getVersion.mockReturnValue(codexSnapshot);
    mocks.isVersionRecheckPending.mockReset();
    mocks.isVersionRecheckPending.mockReturnValue(false);
    mocks.scanVersion.mockReset();
    mocks.scanVersion.mockResolvedValue(codexSnapshot);
    mocks.subscribeVersionRecheck.mockReset();
    mocks.unsubscribeVersionRecheck.mockReset();
    mocks.subscribeVersionRecheck.mockReturnValue(
      mocks.unsubscribeVersionRecheck
    );
    hook = null;
    store = createStore();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  afterAll(() => {
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("does not check or manually refresh while alerts are off", async () => {
    store.set(cliUpdateAlertsEnabledAtom, false);
    renderHarness();

    expect(mocks.scanVersion).not.toHaveBeenCalled();
    await act(async () => {
      await hook?.refreshSelectedCliVersion();
    });
    expect(mocks.scanVersion).not.toHaveBeenCalled();
    expect(hook?.showCliVersionOutdatedAlert).toBe(false);

    await act(async () => {
      store.set(cliUpdateAlertsEnabledAtom, true);
    });
    expect(mocks.scanVersion).toHaveBeenCalledTimes(1);
    expect(mocks.scanVersion).toHaveBeenCalledWith("codex");
  });

  it("subscribes the selected CLI to a shared six-hour recheck", () => {
    store.set(cliUpdateAlertsEnabledAtom, true);
    renderHarness();
    expect(hook?.showCliVersionOutdatedAlert).toBe(true);

    act(() => hook?.snoozeSelectedCliVersionAlert());
    expect(hook?.showCliVersionOutdatedAlert).toBe(false);
    expect(store.get(cliUpdateAlertSuppressionsAtom).codex?.snoozedUntil).toBe(
      Date.now() + CLI_UPDATE_ALERT_SNOOZE_MS
    );
    expect(mocks.subscribeVersionRecheck).toHaveBeenCalledWith(
      "codex",
      Date.now() + CLI_UPDATE_ALERT_SNOOZE_MS
    );
  });

  it("cancels the shared snooze recheck when alerts are switched off", () => {
    store.set(cliUpdateAlertsEnabledAtom, true);
    renderHarness();
    act(() => hook?.snoozeSelectedCliVersionAlert());

    act(() => store.set(cliUpdateAlertsEnabledAtom, false));

    expect(mocks.unsubscribeVersionRecheck).toHaveBeenCalledTimes(1);
    expect(mocks.scanVersion).toHaveBeenCalledTimes(1);
    expect(hook?.showCliVersionOutdatedAlert).toBe(false);
  });

  it("mutes only the currently advertised latest version", () => {
    store.set(cliUpdateAlertsEnabledAtom, true);
    renderHarness();

    act(() => hook?.muteSelectedCliVersionAlertUntilNextVersion());
    expect(hook?.showCliVersionOutdatedAlert).toBe(false);
    expect(
      store.get(cliUpdateAlertSuppressionsAtom).codex?.mutedLatestVersion
    ).toBe("0.1.6");

    mocks.getVersion.mockReturnValue({
      ...codexSnapshot,
      latest_version: "0.1.7",
    });
    renderHarness(1);

    expect(hook?.showCliVersionOutdatedAlert).toBe(true);
  });
});
