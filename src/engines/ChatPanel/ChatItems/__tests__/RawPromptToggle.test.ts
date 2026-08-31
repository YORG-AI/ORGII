// @vitest-environment jsdom
/**
 * Interaction coverage for the per-turn raw-prompt panel.
 *
 * The SSR assertions in `UserChatItem.test.ts` only prove the trigger is
 * wired; the panel is portaled and therefore only observable once opened
 * under a real renderer.
 */
import { Provider, createStore } from "jotai";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Session } from "@src/store/session/sessionAtom/types";
import { createSmokeRoot, dispatch } from "@src/test/reactSmokeHarness";

// react-i18next has no instance bound in this suite; interpolate the one
// placeholder the panel uses so the rendered header is assertable.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (
      _key: string,
      options?: { defaultValue?: string; length?: string }
    ): string => {
      const template = options?.defaultValue ?? _key;
      return options?.length === undefined
        ? template
        : template.replace("{{length}}", options.length);
    },
    i18n: { resolvedLanguage: "en" },
  }),
}));

const RAW_PROMPT = "audit the release [file:/repo/CHANGELOG.md]\nline two";

function makeSession(overrides: Partial<Session>): Session {
  return {
    session_id: "agentsession-raw",
    status: "completed",
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
    ...overrides,
  };
}

async function mountToggle(session?: Session) {
  const { sessionsAtom } = await import("@src/store/session/sessionAtom");
  const { default: RawPromptToggle } =
    await import("@src/engines/ChatPanel/ChatItems/RawPromptToggle");

  const store = createStore();
  store.set(sessionsAtom, session ? [session] : []);

  const root = createSmokeRoot();
  await root.render(
    createElement(
      Provider,
      { store },
      createElement(RawPromptToggle, {
        rawText: RAW_PROMPT,
        sessionId: "agentsession-raw",
      })
    )
  );
  return root;
}

function trigger(): HTMLButtonElement {
  const element = document.querySelector<HTMLButtonElement>(
    '[data-testid="chat-message-raw-prompt-toggle"]'
  );
  if (!element) throw new Error("raw prompt toggle not rendered");
  return element;
}

function panel(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    '[data-testid="chat-message-raw-prompt-panel"]'
  );
}

function effortChip(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    '[data-testid="chat-message-raw-prompt-effort"]'
  );
}

describe("RawPromptToggle", () => {
  let root: Awaited<ReturnType<typeof mountToggle>> | null = null;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(async () => {
    await root?.unmount();
    root = null;
  });

  it("keeps the panel closed until the trigger is pressed", async () => {
    root = await mountToggle();

    expect(panel()).toBeNull();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("shows the wire prompt verbatim, with the model and its length", async () => {
    root = await mountToggle(
      makeSession({ model: "claude-opus-4.5-20251219" })
    );

    await dispatch(() => trigger().click());

    const opened = panel();
    expect(opened).not.toBeNull();
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    // Verbatim: the pill token is NOT rendered as a badge here.
    expect(opened?.querySelector("pre")?.textContent).toBe(RAW_PROMPT);
    expect(opened?.textContent).toContain("Opus 4.5 20251219");
    expect(opened?.textContent).toContain(`${RAW_PROMPT.length} chars`);
  });

  it("surfaces the reasoning effort encoded in a variant model id", async () => {
    root = await mountToggle(
      makeSession({ model: "claude-opus-4-7-thinking-xhigh" })
    );

    await dispatch(() => trigger().click());

    // The base name and the effort are separate: formatModelNameFull drops
    // the suffix on Anthropic ids, so without the split there is no effort.
    expect(panel()?.textContent).toContain("Opus 4.7");
    expect(effortChip()?.textContent).toBe("Extra High · Thinking");
  });

  it("shows no effort chip for a model id that encodes none", async () => {
    root = await mountToggle(
      makeSession({ model: "claude-opus-4.5-20251219" })
    );

    await dispatch(() => trigger().click());

    expect(panel()?.textContent).toContain("Opus 4.5 20251219");
    expect(effortChip()).toBeNull();
  });

  it("falls back to the length alone when the session names no model", async () => {
    root = await mountToggle(makeSession({}));

    await dispatch(() => trigger().click());

    expect(panel()?.textContent).toContain(`${RAW_PROMPT.length} chars`);
    expect(panel()?.textContent).toContain("Raw prompt sent to AI");
  });

  it("closes again on a second press", async () => {
    root = await mountToggle();

    await dispatch(() => trigger().click());
    expect(panel()).not.toBeNull();

    await dispatch(() => trigger().click());
    expect(panel()).toBeNull();
  });
});
