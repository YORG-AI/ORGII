// @vitest-environment jsdom
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MOBILE_COMPOSER_CONTENT_INSET_PX,
  MOBILE_COMPOSER_CONTENT_INSET_X_CLASS,
} from "@src/config/composerStackTokens";

import { MobileComposer } from "./MobileComposer";

vi.mock("@src/components/ModelIcon", () => ({
  default: () => null,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

vi.mock("@src/hooks/voice", () => ({
  useVoiceInput: () => ({
    isRecording: false,
    isSupported: true,
    liveTranscript: "",
    elapsedSeconds: 0,
    start: vi.fn(),
    stop: vi.fn(),
    cancel: vi.fn(),
    toggle: vi.fn(),
  }),
}));

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
});

async function renderComposer(
  onSend: (content: string) => void | Promise<void>
) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(createElement(MobileComposer, { onSend }));
  });
  const textarea = host.querySelector("textarea");
  const button = host.querySelector<HTMLButtonElement>(
    "[data-testid=mobile-composer-send]"
  );
  if (!textarea || !button) throw new Error("composer did not render");
  return { textarea, button };
}

function enterText(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value"
  )?.set;
  setter?.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("MobileComposer submission lifecycle", () => {
  it("uses the shared Desktop shell, toolbar layout, and submit control", async () => {
    const { textarea, button } = await renderComposer(vi.fn());

    expect(host?.querySelector("[data-mobile-composer=true]")).not.toBeNull();
    expect(
      host?.querySelector("[data-composer-bar-layout=true]")
    ).not.toBeNull();
    expect(textarea.closest(".textarea-mobile-focus-safe")).not.toBeNull();
    expect(textarea.rows).toBe(1);
    expect(textarea.style.minHeight).toBe("36px");
    expect(button.closest("[data-composer-bar-layout=true]")).not.toBeNull();
    expect(
      host?.querySelector("[data-testid=composer-voice-input-button]")
    ).not.toBeNull();
    expect(button.dataset.state).toBe("submit");
    expect(button.className).toContain("opacity-50");

    await act(async () => enterText(textarea, "ready to send"));

    expect(button.className).toContain("bg-primary-6");
    expect(button.className).not.toContain("opacity-50");
  });

  it("renders the model pill inside the composer footer", async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(
        createElement(MobileComposer, {
          onSend: vi.fn(),
          modelPicker: {
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
            ],
            open: false,
            onOpen: vi.fn(),
            onClose: vi.fn(),
            onSelect: vi.fn(),
          },
        })
      );
    });

    const layout = host.querySelector("[data-composer-bar-layout=true]");
    const pill = layout?.querySelector(
      "[data-testid=mobile-model-picker-pill]"
    );
    expect(layout).not.toBeNull();
    expect(pill).not.toBeNull();
    expect(
      host?.querySelector("[data-composer-bar-layout=true]")?.parentElement
    ).not.toBeNull();
  });

  it("aligns the footer toolbar padding with the editor textarea", async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(
        createElement(MobileComposer, {
          onSend: vi.fn(),
          modelPicker: {
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
            ],
            open: false,
            onOpen: vi.fn(),
            onClose: vi.fn(),
            onSelect: vi.fn(),
          },
        })
      );
    });

    const textarea = host?.querySelector("textarea");
    const toolbar = host?.querySelector(
      "[data-composer-bar-layout=true] > div:last-child"
    );
    const pill = host?.querySelector("[data-testid=mobile-model-picker-pill]");
    expect(textarea?.className).toContain(
      `!${MOBILE_COMPOSER_CONTENT_INSET_X_CLASS}`
    );
    expect(toolbar?.className).toContain(MOBILE_COMPOSER_CONTENT_INSET_X_CLASS);
    expect(toolbar?.className).not.toContain("px-1");
    expect(textarea?.style.paddingLeft).toBe(
      `${MOBILE_COMPOSER_CONTENT_INSET_PX}px`
    );
    expect(pill?.className).not.toContain("pl-0");
    expect(pill?.className).toContain("px-3");
  });

  it("renders the attach button before the model pill", async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(
        createElement(MobileComposer, {
          onSend: vi.fn(),
          modelPicker: {
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
            ],
            open: false,
            onOpen: vi.fn(),
            onClose: vi.fn(),
            onSelect: vi.fn(),
          },
        })
      );
    });

    const layout = host?.querySelector("[data-composer-bar-layout=true]");
    const attachButton = layout?.querySelector(
      "[data-testid=mobile-composer-attach-button]"
    );
    const pill = layout?.querySelector(
      "[data-testid=mobile-model-picker-pill]"
    );
    expect(attachButton).not.toBeNull();
    expect(pill).not.toBeNull();
    expect(
      attachButton!.compareDocumentPosition(pill!) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("keeps the draft and shows the error when the RPC rejects", async () => {
    let rejectSend: ((error: Error) => void) | undefined;
    const onSend = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectSend = reject;
        })
    );
    const { textarea, button } = await renderComposer(onSend);

    await act(async () => enterText(textarea, "retry this message"));
    act(() => button.click());

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(true);
    expect(button.dataset.state).toBe("submitting");
    expect(button.getAttribute("aria-busy")).toBe("true");
    act(() => button.click());
    expect(onSend).toHaveBeenCalledTimes(1);

    await act(async () => {
      rejectSend?.(new Error("Relay rejected the message"));
      await Promise.resolve();
    });

    expect(textarea.value).toBe("retry this message");
    expect(button.disabled).toBe(false);
    expect(host?.querySelector("[role=alert]")?.textContent).toContain(
      "Relay rejected the message"
    );
  });

  it("clears an unchanged draft only after the RPC accepts it", async () => {
    let acceptSend: (() => void) | undefined;
    const onSend = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          acceptSend = resolve;
        })
    );
    const { textarea, button } = await renderComposer(onSend);

    await act(async () => enterText(textarea, "send once"));
    act(() => button.click());
    expect(textarea.value).toBe("send once");

    await act(async () => {
      acceptSend?.();
      await Promise.resolve();
    });

    expect(textarea.value).toBe("");
    expect(onSend).toHaveBeenCalledWith("send once", []);
  });
});
