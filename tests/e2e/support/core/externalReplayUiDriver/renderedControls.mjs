import { execJS } from "./bridge.mjs";

export async function waitForRenderedSelector(
  selector,
  { timeout = 20_000, label = selector } = {}
) {
  const encodedSelector = JSON.stringify(selector);
  await browser.waitUntil(
    async () =>
      execJS(`
        const element = document.querySelector(${encodedSelector});
        if (!element) return false;
        const style = window.getComputedStyle(element);
        return (
          element.getClientRects().length > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden"
        );
      `),
    {
      timeout,
      interval: 100,
      timeoutMsg: `${label} did not become rendered and visible`,
    }
  );
}

export async function clickRenderedSelector(
  selector,
  { timeout = 20_000, label = selector, clickCount = 1 } = {}
) {
  const encodedSelector = JSON.stringify(selector);
  await waitForRenderedSelector(selector, { timeout, label });
  const clicked = await execJS(`
    const element = document.querySelector(${encodedSelector});
    if (!element || element.getClientRects().length === 0) return false;
    element.scrollIntoView({ block: "center", inline: "nearest" });
    for (let index = 0; index < ${Number(clickCount)}; index += 1) {
      element.click();
    }
    return true;
  `);
  if (!clicked) {
    throw new Error(`${label} disappeared before its rendered click`);
  }
}

export async function waitForRenderedSelectorAbsent(
  selector,
  { timeout = 10_000, label = selector } = {}
) {
  const encodedSelector = JSON.stringify(selector);
  await browser.waitUntil(
    async () =>
      execJS(`return document.querySelector(${encodedSelector}) == null;`),
    {
      timeout,
      interval: 100,
      timeoutMsg: `${label} did not leave the rendered DOM`,
    }
  );
}

export async function renderedSelectorSnapshot(selector) {
  return execJS(`
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    const style = window.getComputedStyle(element);
    return {
      text: element.innerText ?? element.textContent ?? "",
      disabled:
        element instanceof HTMLButtonElement ||
        element instanceof HTMLInputElement
          ? element.disabled
          : element.getAttribute("aria-disabled") === "true",
      visible:
        element.getClientRects().length > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden",
      attributes: Object.fromEntries(
        Array.from(element.attributes).map((attribute) => [
          attribute.name,
          attribute.value,
        ])
      ),
    };
  `);
}

export async function waitForRenderedSelectorEnabled(
  selector,
  { timeout = 20_000, label = selector } = {}
) {
  await browser.waitUntil(
    async () => {
      const snapshot = await renderedSelectorSnapshot(selector);
      return Boolean(snapshot?.visible && !snapshot.disabled);
    },
    {
      timeout,
      interval: 100,
      timeoutMsg: `${label} did not become rendered and enabled`,
    }
  );
}

export async function setRenderedInputValue(
  selector,
  value,
  { timeout = 20_000, label = selector } = {}
) {
  await waitForRenderedSelector(selector, { timeout, label });
  const updated = await execJS(`
    const input = document.querySelector(${JSON.stringify(selector)});
    if (!(input instanceof HTMLInputElement)) return false;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set;
    if (!setter) return false;
    input.focus();
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        composed: true,
        data: ${JSON.stringify(value)},
        inputType: "insertText",
      })
    );
    input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    return true;
  `);
  if (!updated) {
    throw new Error(`${label} could not receive its rendered input value`);
  }
}
