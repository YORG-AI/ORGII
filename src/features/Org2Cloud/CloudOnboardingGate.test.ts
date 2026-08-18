// @vitest-environment jsdom
// Rendered lifecycle coverage for the shared Cloud entry boundary.
import { Provider, createStore } from "jotai";
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

import CloudOnboardingGate from "./CloudOnboardingGate";
import {
  ORG2_CLOUD_ONBOARDING_STORAGE_KEY,
  ORG2_CLOUD_ONBOARDING_VERSION,
} from "./cloudOnboardingPreference";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe("CloudOnboardingGate", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  afterAll(() => {
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  function renderGate(
    onConnect = vi.fn(async () => true),
    onContinueLocally?: () => void,
    contextual = false
  ): void {
    act(() => {
      root.render(
        createElement(
          Provider,
          { store: createStore() },
          createElement(CloudOnboardingGate, {
            onConnect,
            onContinueLocally,
            contextual,
          })
        )
      );
    });
  }

  function button(testId: string): HTMLButtonElement {
    const target = container.querySelector<HTMLButtonElement>(
      `[data-testid="${testId}"]`
    );
    expect(target).not.toBeNull();
    return target as HTMLButtonElement;
  }

  it("shows the introduction on first entry without acknowledging on render", () => {
    renderGate();

    expect(
      container.querySelector('[data-testid="org2-cloud-onboarding"]')
    ).not.toBeNull();
    expect(localStorage.getItem(ORG2_CLOUD_ONBOARDING_STORAGE_KEY)).toBeNull();
  });

  it("continues locally and records only the non-sensitive version", () => {
    const onConnect = vi.fn();
    const onContinueLocally = vi.fn();
    renderGate(onConnect, onContinueLocally);

    act(() => button("org2-cloud-continue-local").click());

    expect(onConnect).not.toHaveBeenCalled();
    expect(onContinueLocally).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(ORG2_CLOUD_ONBOARDING_STORAGE_KEY)).toBe(
      JSON.stringify(ORG2_CLOUD_ONBOARDING_VERSION)
    );
    expect(
      container.querySelector('[data-testid="org2-cloud-auth-block"]')
    ).not.toBeNull();
  });

  it("skips the introduction when the current version was acknowledged", () => {
    localStorage.setItem(
      ORG2_CLOUD_ONBOARDING_STORAGE_KEY,
      JSON.stringify(ORG2_CLOUD_ONBOARDING_VERSION)
    );
    renderGate();

    expect(
      container.querySelector('[data-testid="org2-cloud-onboarding"]')
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="org2-cloud-auth-block"]')
    ).not.toBeNull();
  });

  it("starts a business intent with the compact block without acknowledging it", () => {
    const onContinueLocally = vi.fn();
    renderGate(vi.fn(), onContinueLocally, true);

    expect(
      container.querySelector('[data-testid="org2-cloud-auth-block"]')
    ).not.toBeNull();
    expect(localStorage.getItem(ORG2_CLOUD_ONBOARDING_STORAGE_KEY)).toBeNull();

    act(() => button("org2-cloud-back-to-local").click());
    expect(onContinueLocally).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(ORG2_CLOUD_ONBOARDING_STORAGE_KEY)).toBeNull();
  });

  it("acknowledges connect and prevents duplicate browser starts", async () => {
    let resolveConnect!: (value: boolean) => void;
    const onConnect = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveConnect = resolve;
        })
    );
    renderGate(onConnect);

    await act(async () => {
      const connect = button("org2-cloud-connect");
      connect.click();
      connect.click();
      await Promise.resolve();
    });

    expect(onConnect).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(ORG2_CLOUD_ONBOARDING_STORAGE_KEY)).toBe("1");

    await act(async () => resolveConnect(true));
  });

  it("can reopen details without clearing the acknowledged version", () => {
    localStorage.setItem(ORG2_CLOUD_ONBOARDING_STORAGE_KEY, "1");
    renderGate();

    act(() => button("org2-cloud-learn-more").click());

    expect(
      container.querySelector('[data-testid="org2-cloud-onboarding"]')
    ).not.toBeNull();
    expect(localStorage.getItem(ORG2_CLOUD_ONBOARDING_STORAGE_KEY)).toBe("1");
  });

  it("converges when another window acknowledges the current version", () => {
    renderGate();
    expect(
      container.querySelector('[data-testid="org2-cloud-onboarding"]')
    ).not.toBeNull();

    act(() => {
      localStorage.setItem(ORG2_CLOUD_ONBOARDING_STORAGE_KEY, "1");
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: ORG2_CLOUD_ONBOARDING_STORAGE_KEY,
          newValue: "1",
        })
      );
    });

    expect(
      container.querySelector('[data-testid="org2-cloud-auth-block"]')
    ).not.toBeNull();
  });

  it("surfaces a browser-open failure and allows retry", async () => {
    const onConnect = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    renderGate(onConnect);

    await act(async () => button("org2-cloud-connect").click());
    expect(
      container.querySelector('[data-testid="org2-cloud-sign-in-error"]')
    ).not.toBeNull();

    await act(async () => button("org2-cloud-sign-in").click());
    expect(onConnect).toHaveBeenCalledTimes(2);
  });
});
