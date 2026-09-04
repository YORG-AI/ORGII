// @vitest-environment jsdom
import React, { act, createElement } from "react";
import type { ComponentProps, ComponentType, PropsWithChildren } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MobileRemotePlatformProvider } from "@src/modules/MobileRemote/platform";
import { createBrowserMobileRemotePlatform } from "@src/modules/MobileRemote/platform/browser";

import { MobileModelPicker } from "./MobileModelPicker";

vi.mock("@src/components/ModelIcon", () => ({
  default: () => React.createElement("svg", { "data-icon": "model" }),
}));

const dropdownTestState = vi.hoisted(() => ({ isOpen: false }));

vi.mock("@src/hooks/dropdown", () => ({
  useDropdownEngine: (options?: { open?: boolean }) => {
    if (options && "open" in options) {
      return {
        isPositioned: options.open,
        panelRef: { current: null },
        panelPosition: { top: 0, left: 0, maxHeight: 280 },
        keyboard: {
          getItemProps: () => ({}),
        },
      };
    }
    return {
      get isOpen() {
        return dropdownTestState.isOpen;
      },
      get isPositioned() {
        return dropdownTestState.isOpen;
      },
      panelRef: { current: null },
      panelPosition: { top: 0, left: 0, maxHeight: 280 },
      toggle: () => {
        dropdownTestState.isOpen = !dropdownTestState.isOpen;
      },
      close: () => {
        dropdownTestState.isOpen = false;
      },
      keyboard: {
        getItemProps: () => ({}),
      },
    };
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

vi.mock("@src/hooks/models", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@src/hooks/models")>();
  return {
    ...actual,
    useModelAccountLookup: () => ({
      accounts: [],
      accountLookup: new Map(),
    }),
  };
});

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
  }
  host?.remove();
  root = null;
  host = null;
  dropdownTestState.isOpen = false;
});

// The dropdown portals through the platform port, so the unit test needs a
// mounted platform exactly like the app tree provides.
const testPlatform = createBrowserMobileRemotePlatform();

const TestMobileRemotePlatformProvider =
  MobileRemotePlatformProvider as ComponentType<
    PropsWithChildren<
      Omit<ComponentProps<typeof MobileRemotePlatformProvider>, "children">
    >
  >;

async function renderPicker(
  overrides: Partial<React.ComponentProps<typeof MobileModelPicker>> = {}
) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      createElement(
        TestMobileRemotePlatformProvider,
        { platform: testPlatform },
        createElement(MobileModelPicker, {
          config: {
            sessionId: "session-a",
            model: "claude-sonnet-4-5",
            accountId: "acct-1",
            modelEditable: true,
          },
          options: [
            {
              id: "claude-sonnet-4-5",
              accountId: "acct-1",
              accountLabel: "Anthropic",
            },
            {
              id: "claude-opus-4-5",
              accountId: "acct-1",
              accountLabel: "Anthropic",
            },
            {
              id: "gpt-5.6-sol",
              accountId: "acct-1",
              accountLabel: "Anthropic",
            },
            {
              id: "gpt-5.6-sol-low",
              accountId: "acct-1",
              accountLabel: "Anthropic",
            },
            {
              id: "gpt-5.6-sol-medium",
              accountId: "acct-1",
              accountLabel: "Anthropic",
            },
            {
              id: "gpt-5.6-sol-high",
              accountId: "acct-1",
              accountLabel: "Anthropic",
            },
            {
              id: "gpt-5.6-sol-max",
              accountId: "acct-1",
              accountLabel: "Anthropic",
            },
          ],
          open: false,
          onOpen: vi.fn(),
          onClose: vi.fn(),
          onSelect: vi.fn(),
          ...overrides,
        })
      )
    );
  });
}

describe("MobileModelPicker", () => {
  it("renders a desktop-style model pill with the formatted current model", async () => {
    await renderPicker();
    const trigger = host?.querySelector(
      "[data-testid=mobile-model-picker-trigger]"
    );
    expect(trigger?.textContent).toContain("Sonnet 4.5");
    expect(
      host?.querySelector("[data-testid=mobile-model-picker-pill]")
    ).not.toBeNull();
  });

  it("renders inline without outer padding when embedded", async () => {
    await renderPicker({ embedded: true });
    const trigger = host?.querySelector(
      "[data-testid=mobile-model-picker-trigger]"
    );
    const pill = host?.querySelector("[data-testid=mobile-model-picker-pill]");
    expect(trigger?.className).toContain("min-w-0");
    expect(trigger?.className).not.toContain("px-1");
    expect(pill?.className).not.toContain("pl-0");
    expect(pill?.className).toContain("px-3");
  });

  it("formats cursor-hosted grok ids instead of showing the raw slug", async () => {
    await renderPicker({
      config: {
        sessionId: "session-a",
        model: "cursor-grok-4.6-medium",
        accountId: "acct-1",
        modelEditable: true,
      },
      options: [
        {
          id: "cursor-grok-4.6-medium",
          accountId: "acct-1",
          accountLabel: "Cursor",
        },
        {
          id: "cursor-grok-4.6-high",
          accountId: "acct-1",
          accountLabel: "Cursor",
        },
      ],
    });
    const pill = host?.querySelector("[data-testid=mobile-model-picker-pill]");
    expect(pill?.textContent).toContain("Grok 4.6");
    expect(pill?.textContent).not.toContain("cursor-grok-4.6-medium");
  });

  it("lists collapsed base models in an anchored dropdown when open", async () => {
    await renderPicker({ open: true });
    expect(
      document.body.querySelector("[data-testid=mobile-model-picker-dropdown]")
    ).not.toBeNull();
    expect(document.body.textContent).toContain("Opus 4.5");
    expect(document.body.textContent).toContain("Anthropic");
    expect(document.body.textContent).not.toContain("Max");
  });

  it("opens the compact model settings menu from the pill", async () => {
    await renderPicker({
      config: {
        sessionId: "session-a",
        model: "gpt-5.6-sol-max",
        accountId: "acct-1",
        modelEditable: true,
      },
    });
    const pill = host?.querySelector(
      "[data-testid=mobile-model-picker-pill]"
    ) as HTMLButtonElement | null;
    expect(pill).not.toBeNull();
    await act(async () => {
      pill?.click();
      root?.render(
        createElement(
          TestMobileRemotePlatformProvider,
          { platform: testPlatform },
          createElement(MobileModelPicker, {
            config: {
              sessionId: "session-a",
              model: "gpt-5.6-sol-max",
              accountId: "acct-1",
              modelEditable: true,
            },
            options: [
              {
                id: "claude-sonnet-4-5",
                accountId: "acct-1",
                accountLabel: "Anthropic",
              },
              {
                id: "claude-opus-4-5",
                accountId: "acct-1",
                accountLabel: "Anthropic",
              },
              {
                id: "gpt-5.6-sol",
                accountId: "acct-1",
                accountLabel: "Anthropic",
              },
              {
                id: "gpt-5.6-sol-low",
                accountId: "acct-1",
                accountLabel: "Anthropic",
              },
              {
                id: "gpt-5.6-sol-medium",
                accountId: "acct-1",
                accountLabel: "Anthropic",
              },
              {
                id: "gpt-5.6-sol-high",
                accountId: "acct-1",
                accountLabel: "Anthropic",
              },
              {
                id: "gpt-5.6-sol-max",
                accountId: "acct-1",
                accountLabel: "Anthropic",
              },
            ],
            open: false,
            onOpen: vi.fn(),
            onClose: vi.fn(),
            onSelect: vi.fn(),
          })
        )
      );
    });
    expect(
      document.body.querySelector("[data-testid=model-settings-model]")
    ).not.toBeNull();
    expect(
      document.body.querySelector("[data-testid=model-settings-effort]")
    ).not.toBeNull();
  });
});
