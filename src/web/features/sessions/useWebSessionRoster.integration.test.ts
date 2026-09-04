// @vitest-environment jsdom
import { Provider, createStore } from "jotai";
import { act, createElement, useEffect } from "react";
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
  org2CloudOrgsLoadStateAtom,
  org2CloudOrgsLoadedAtom,
} from "@src/features/Org2Cloud/org2CloudOrgsAtom";

import { useWebSessionRoster } from "./useWebSessionRoster";

const mocks = vi.hoisted(() => ({
  ensureFreshSession: vi.fn(),
  listMyOrgs: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@src/features/Org2Cloud/org2CloudClient", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@src/features/Org2Cloud/org2CloudClient")
    >();
  return {
    ...actual,
    ensureFreshSession: mocks.ensureFreshSession,
    listMyOrgs: mocks.listMyOrgs,
  };
});

const AUTH = {
  kind: "org2_cloud" as const,
  supabaseUrl: "https://cloud.example.test",
  supabaseAnonKey: "anon",
  userId: "user-1",
  accessToken: "access",
  refreshToken: "refresh",
  expiresAt: 4_102_444_800,
};

const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe("useWebSessionRoster organization recovery", () => {
  let container: HTMLDivElement;
  let root: Root;
  let store: ReturnType<typeof createStore>;
  let latest: ReturnType<typeof useWebSessionRoster> | null;

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureFreshSession.mockImplementation(async (auth) => auth);
    mocks.listMyOrgs.mockResolvedValue([]);
    latest = null;
    store = createStore();
    store.set(org2CloudAuthAtom, AUTH);
    store.set(org2CloudOrgsAtom, []);
    store.set(org2CloudOrgsLoadedAtom, false);
    store.set(org2CloudOrgsLoadStateAtom, "error");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  function Probe({
    onChange,
  }: {
    onChange: (value: ReturnType<typeof useWebSessionRoster>) => void;
  }) {
    const value = useWebSessionRoster();
    useEffect(() => {
      onChange(value);
    }, [onChange, value]);
    return null;
  }

  it("turns a failed first load into an error and recovers through Retry", async () => {
    act(() => {
      root.render(
        createElement(
          Provider,
          { store },
          createElement(Probe, {
            onChange: (value) => {
              latest = value;
            },
          })
        )
      );
    });

    expect(latest?.status).toBe("error");
    expect(latest?.error).toBe("web.sessionsPage.organizationLoadErrorHint");

    await act(async () => {
      await latest?.refresh();
    });

    expect(mocks.listMyOrgs).toHaveBeenCalledTimes(1);
    expect(store.get(org2CloudOrgsLoadedAtom)).toBe(true);
    expect(store.get(org2CloudOrgsLoadStateAtom)).toBe("ready");
    expect(latest?.status).toBe("loaded");
    expect(latest?.organizationsKnown).toBe(true);
    expect(latest?.hasOrganizations).toBe(false);
  });

  it("preserves an authoritatively empty roster after a later refresh failure", () => {
    store.set(org2CloudOrgsLoadedAtom, true);
    act(() => {
      root.render(
        createElement(
          Provider,
          { store },
          createElement(Probe, {
            onChange: (value) => {
              latest = value;
            },
          })
        )
      );
    });

    expect(latest?.status).toBe("loaded");
    expect(latest?.organizationsKnown).toBe(true);
    expect(latest?.hasOrganizations).toBe(false);
    expect(latest?.error).toBe("web.sessionsPage.organizationRefreshErrorHint");
  });
});
