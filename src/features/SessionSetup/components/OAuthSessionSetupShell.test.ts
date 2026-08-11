import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  type OAuthSessionSetupCopy,
  OAuthSessionSetupView,
  shouldCollapseOAuthBrowser,
  shouldHandleOAuthCloseSignal,
  shouldStartOAuthLogin,
} from "./OAuthSessionSetupShell";

const copy: OAuthSessionSetupCopy = {
  signInTitle: "Sign in",
  signInDescription: "Connect your account",
  signInButton: "Continue",
  signedInTitle: "Connected",
  signedInStatus: "Signed in",
  loginStep: "Login",
  browserHint: "Complete login in the browser",
  readyTitle: "Ready to sign in",
  oauthHint: "The browser will open here",
  loading: "Loading",
  failedToLoadBrowser: "Browser failed",
  retry: "Retry",
  close: "Close",
  errorHint: "Try signing in again",
};

function renderView(
  overrides: Partial<Parameters<typeof OAuthSessionSetupView>[0]> = {}
) {
  return renderToStaticMarkup(
    createElement(OAuthSessionSetupView, {
      providerId: "provider",
      containerRef: createRef<HTMLDivElement>(),
      showBrowser: false,
      hasToken: false,
      isSigningIn: false,
      isWebviewOpen: false,
      isWebviewLoading: false,
      currentUrl: "",
      authUrl: null,
      displayError: null,
      copy,
      onOpenBrowser: vi.fn(),
      onCloseBrowser: vi.fn(),
      onRetry: vi.fn(),
      ...overrides,
    })
  );
}

describe("OAuthSessionSetupView", () => {
  it("renders the idle sign-in action", () => {
    const markup = renderView();

    expect(markup).toContain('data-testid="provider-session-setup"');
    expect(markup).toContain('data-testid="provider-oauth-signin"');
    expect(markup).toContain("Continue");
    expect(markup).not.toContain("provider-oauth-browser-shell");
  });

  it("keeps the browser shell visible while login is loading", () => {
    const markup = renderView({
      showBrowser: true,
      isSigningIn: true,
      currentUrl: "https://example.com/login",
    });

    expect(markup).toContain('data-testid="provider-oauth-browser-shell"');
    expect(markup).toContain("https://example.com/login");
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-label="Retry"');
    expect(markup).toContain('aria-label="Close"');
    expect(markup).toContain('aria-current="step"');
  });

  it("renders an in-place browser error with recovery", () => {
    const markup = renderView({
      showBrowser: true,
      displayError: "network unavailable",
    });

    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Browser failed");
    expect(markup).toContain("network unavailable");
    expect(markup).toContain("Retry");
  });

  it("renders the provider success state after the browser closes", () => {
    const markup = renderView({ hasToken: true });

    expect(markup).toContain("Connected");
    expect(markup).toContain("Signed in");
    expect(markup).not.toContain("provider-oauth-browser-shell");
  });
});

describe("OAuth session setup lifecycle", () => {
  it("starts only for a requested browser with no active login or webview", () => {
    expect(shouldStartOAuthLogin(true, false, false)).toBe(true);
    expect(shouldStartOAuthLogin(false, false, false)).toBe(false);
    expect(shouldStartOAuthLogin(true, true, false)).toBe(false);
    expect(shouldStartOAuthLogin(true, false, true)).toBe(false);
  });

  it("collapses only after sign-in has completed and the webview closed", () => {
    expect(shouldCollapseOAuthBrowser(false, true)).toBe(true);
    expect(shouldCollapseOAuthBrowser(true, true)).toBe(false);
    expect(shouldCollapseOAuthBrowser(false, false)).toBe(false);
  });

  it("honors an external close signal only while the browser is visible", () => {
    expect(shouldHandleOAuthCloseSignal(1, true)).toBe(true);
    expect(shouldHandleOAuthCloseSignal(0, true)).toBe(false);
    expect(shouldHandleOAuthCloseSignal(1, false)).toBe(false);
  });
});
