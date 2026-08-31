// @vitest-environment jsdom
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MobileComposer } from "./MobileComposer";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }),
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
    expect(button.dataset.state).toBe("submit");
    expect(button.className).toContain("opacity-50");

    await act(async () => enterText(textarea, "ready to send"));

    expect(button.className).toContain("bg-primary-6");
    expect(button.className).not.toContain("opacity-50");
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
    expect(onSend).toHaveBeenCalledWith("send once");
  });
});
