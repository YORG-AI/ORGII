/** @vitest-environment jsdom */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSmokeRoot } from "@src/test/reactSmokeHarness";

import { WebAuthCallbackPage } from "./WebAuthCallbackPage";
import { WEB_AUTH_STATE_STORAGE_KEY } from "./webAuthFlowState";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  setAuth: vi.fn(),
}));

vi.mock("jotai", () => ({
  useSetAtom: () => mocks.setAuth,
}));

vi.mock("react-router-dom", () => ({
  useNavigate: () => mocks.navigate,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@src/components/Button", () => ({
  default: ({ children }: { children: React.ReactNode }) =>
    React.createElement("button", null, children),
}));

vi.mock("@src/modules/shared/layouts/blocks", () => ({
  Placeholder: ({ title }: { title: string }) =>
    React.createElement("div", { "data-error": true }, title),
}));

function accessToken(userId: string): string {
  return `header.${btoa(JSON.stringify({ sub: userId }))}.signature`;
}

describe("WebAuthCallbackPage", () => {
  const roots: Array<ReturnType<typeof createSmokeRoot>> = [];

  beforeEach(() => {
    mocks.navigate.mockReset();
    mocks.setAuth.mockReset();
    sessionStorage.clear();
    window.history.replaceState(null, "", "/auth/callback");
  });

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => root.unmount()));
  });

  it("commits credentials only for the matching one-time callback state", async () => {
    sessionStorage.setItem(WEB_AUTH_STATE_STORAGE_KEY, "expected");
    const token = accessToken("user-1");
    window.history.replaceState(
      null,
      "",
      `/auth/callback?state=expected#access_token=${token}&refresh_token=refresh&expires_at=2000000000`
    );
    const root = createSmokeRoot();
    roots.push(root);

    await root.render(React.createElement(WebAuthCallbackPage));

    expect(mocks.setAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        accessToken: token,
        refreshToken: "refresh",
        expiresAt: 2_000_000_000,
      })
    );
    expect(sessionStorage.getItem(WEB_AUTH_STATE_STORAGE_KEY)).toBeNull();
    expect(mocks.navigate).toHaveBeenCalledWith("/sessions", {
      replace: true,
    });
  });

  it("rejects a token fragment that is not correlated to this tab", async () => {
    const token = accessToken("attacker");
    window.history.replaceState(
      null,
      "",
      `/auth/callback?state=untrusted#access_token=${token}&refresh_token=refresh&expires_at=2000000000`
    );
    const root = createSmokeRoot();
    roots.push(root);

    await root.render(React.createElement(WebAuthCallbackPage));

    expect(mocks.setAuth).not.toHaveBeenCalled();
    expect(root.container.querySelector("[data-error]")).not.toBeNull();
  });
});
