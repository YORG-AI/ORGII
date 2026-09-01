// @vitest-environment jsdom
import React, { act } from "react";
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

import { useMobileAuth } from "./MobileAuthContext";
import {
  MobileAuthGate,
  type MobileAuthGateProps,
  type MobileAuthGateRenderProps,
} from "./MobileAuthGate";
import {
  type MobileAuthClient,
  MobileAuthClientError,
} from "./mobileAuthClient";
import {
  beginMobileOAuthAttempt,
  captureOpaquePairingIntent,
  consumeOpaquePairingIntent,
} from "./mobileAuthIntent";
import type { MobileAuthSession } from "./mobileAuthState";
import { writeMobileAuthSession } from "./mobileAuthStorage";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

const session: MobileAuthSession = {
  kind: "org2_cloud",
  supabaseUrl: "https://fpdyejwbiriliuqqcjoy.supabase.co",
  supabaseAnonKey: "sb_publishable_FpHAgMYJFGb20HunqnhciA_-2nt9eYU",
  userId: "user-a",
  accessToken: "access",
  refreshToken: "refresh",
  expiresAt: 1_900_000_000,
  profile: { primaryEmail: "mobile@example.test" },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createGate(
  authClient: MobileAuthClient,
  children: (props: MobileAuthGateRenderProps) => React.ReactNode
) {
  return React.createElement(MobileAuthGate, {
    client: authClient,
    children,
  } satisfies MobileAuthGateProps);
}

describe("MobileAuthGate", () => {
  let root: Root;
  let container: HTMLDivElement;
  let documentHidden = false;

  beforeAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  });

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    window.history.replaceState(null, "", "/orgii/mobile");
    documentHidden = false;
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => documentHidden,
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function client(overrides: Partial<MobileAuthClient> = {}): MobileAuthClient {
    return {
      buildLoginUrl: vi.fn().mockResolvedValue("https://login.example"),
      exchangeCallback: vi.fn().mockResolvedValue(session),
      restoreSession: vi.fn().mockResolvedValue(session),
      establishServerSession: vi.fn().mockResolvedValue(undefined),
      signOut: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  it("does not mount protected children while signed out", async () => {
    const authClient = client();
    let protectedMounts = 0;
    await act(async () => {
      root.render(
        createGate(authClient, () => {
          protectedMounts += 1;
          return React.createElement("div", null, "protected");
        })
      );
      await Promise.resolve();
    });

    expect(protectedMounts).toBe(0);
    expect(authClient.restoreSession).not.toHaveBeenCalled();
    expect(authClient.establishServerSession).not.toHaveBeenCalled();
    expect(container.textContent).toContain("auth.signIn");
  });

  it("fails closed without a retry loop when the callback attempt is missing", async () => {
    window.history.replaceState(
      null,
      "",
      "/orgii/mobile/auth/callback?code=expired-code"
    );
    const authClient = client();

    await act(async () => {
      root.render(
        createGate(authClient, () =>
          React.createElement("div", null, "protected")
        )
      );
      await Promise.resolve();
    });

    expect(window.location.pathname).toBe("/orgii/mobile");
    expect(window.location.search).toBe("");
    expect(container.textContent).toContain(
      "Authentication callback has expired"
    );
    expect(container.textContent).not.toContain("auth.retry");
    expect(container.textContent).not.toContain("protected");
    expect(authClient.exchangeCallback).not.toHaveBeenCalled();
  });

  it("scrubs a PKCE callback before exchange and restores pairing only after the server session", async () => {
    const pairingUrl =
      "https://mobile.example/orgii/mobile#pair=opaque-secret-payload";
    captureOpaquePairingIntent(
      {
        href: pairingUrl,
        hash: "#pair=opaque-secret-payload",
        pathname: "/orgii/mobile",
        search: "",
      } as Location,
      window.history
    );
    beginMobileOAuthAttempt("attempt-a");
    window.history.replaceState(
      null,
      "",
      "/orgii/mobile/auth/callback?code=one-time-secret"
    );
    const serverSession = deferred<void>();
    const authClient = client({
      establishServerSession: vi.fn(() => serverSession.promise),
    });
    let renderProps: unknown = null;

    await act(async () => {
      root.render(
        createGate(authClient, (props) => {
          renderProps = props;
          return React.createElement("div", null, "protected");
        })
      );
      await Promise.resolve();
    });

    expect(window.location.pathname).toBe("/orgii/mobile");
    expect(window.location.search).toBe("");
    expect(window.location.href).not.toContain("one-time-secret");
    expect(authClient.exchangeCallback).toHaveBeenCalledWith(
      expect.stringContaining("?code=one-time-secret")
    );
    expect(renderProps).toBeNull();

    await act(async () => {
      serverSession.resolve();
      await serverSession.promise;
      await Promise.resolve();
    });
    expect(renderProps).toEqual({
      authUserId: "user-a",
      recoveredPairingIntent: pairingUrl,
    });
    expect(consumeOpaquePairingIntent()).toBeNull();
  });

  it("unmounts protected content synchronously before remote logout finishes", async () => {
    writeMobileAuthSession(session);
    const logout = deferred<void>();
    const authClient = client({ signOut: vi.fn(() => logout.promise) });

    function Protected() {
      const { signOut } = useMobileAuth();
      return React.createElement("button", { onClick: signOut }, "protected");
    }

    await act(async () => {
      root.render(createGate(authClient, () => React.createElement(Protected)));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("protected");

    act(() => container.querySelector("button")?.click());
    expect(container.textContent).not.toContain("protected");
    expect(authClient.signOut).toHaveBeenCalledWith(session);
  });

  it("owns one expiry timer, pauses it while hidden, and force-refreshes once when visible", async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(window, "clearTimeout");
    writeMobileAuthSession(session);
    const authClient = client();

    await act(async () => {
      root.render(
        createGate(authClient, () =>
          React.createElement("div", null, "protected")
        )
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("protected");
    const expiryTimerCalls = () =>
      setTimeoutSpy.mock.calls.filter(([, delay]) => delay === 2_147_000_000);
    expect(expiryTimerCalls()).toHaveLength(1);
    const firstExpiryTimer = setTimeoutSpy.mock.results.find(
      (_, index) => setTimeoutSpy.mock.calls[index]?.[1] === 2_147_000_000
    )?.value;

    documentHidden = true;
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(clearTimeoutSpy).toHaveBeenCalledWith(firstExpiryTimer);

    documentHidden = false;
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(authClient.restoreSession).toHaveBeenCalledTimes(2);
    expect(authClient.restoreSession).toHaveBeenLastCalledWith(session, {
      forceRefresh: true,
    });
    expect(expiryTimerCalls()).toHaveLength(2);
  });

  it("fails closed and clears the persisted session after a permanent server rejection", async () => {
    writeMobileAuthSession(session);
    const authClient = client({
      establishServerSession: vi
        .fn()
        .mockRejectedValue(
          new MobileAuthClientError("Mobile session rejected", false)
        ),
    });

    await act(async () => {
      root.render(
        createGate(authClient, () =>
          React.createElement("div", null, "protected")
        )
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).not.toContain("protected");
    expect(container.textContent).toContain("Mobile session rejected");
    expect(localStorage.getItem("orgii:org2-cloud-v1:auth")).toBeNull();
  });

  it("fails closed when a visible refresh permanently expires", async () => {
    writeMobileAuthSession(session);
    const restoreSession = vi
      .fn()
      .mockResolvedValueOnce(session)
      .mockRejectedValueOnce(new MobileAuthClientError("Expired", false));
    const authClient = client({ restoreSession });

    await act(async () => {
      root.render(
        createGate(authClient, () =>
          React.createElement("div", null, "protected")
        )
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("protected");

    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).not.toContain("protected");
    expect(container.textContent).toContain("Expired");
    expect(localStorage.getItem("orgii:org2-cloud-v1:auth")).toBeNull();
  });

  it("does not let a refresh completion resurrect content after logout", async () => {
    writeMobileAuthSession(session);
    const refresh = deferred<MobileAuthSession>();
    const restoreSession = vi
      .fn()
      .mockResolvedValueOnce(session)
      .mockImplementationOnce(() => refresh.promise);
    const authClient = client({ restoreSession });

    function Protected() {
      const { signOut } = useMobileAuth();
      return React.createElement("button", { onClick: signOut }, "protected");
    }

    await act(async () => {
      root.render(createGate(authClient, () => React.createElement(Protected)));
      await Promise.resolve();
      await Promise.resolve();
    });

    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(restoreSession).toHaveBeenCalledTimes(2);
    act(() => container.querySelector("button")?.click());
    expect(container.textContent).not.toContain("protected");

    await act(async () => {
      refresh.resolve({ ...session, accessToken: "stale-access" });
      await refresh.promise;
      await Promise.resolve();
    });

    expect(container.textContent).not.toContain("protected");
    expect(localStorage.getItem("orgii:org2-cloud-v1:auth")).toBeNull();
    expect(authClient.establishServerSession).toHaveBeenCalledTimes(1);
  });
});
