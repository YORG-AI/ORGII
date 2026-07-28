import { execJS } from "./bridge.mjs";
import {
  clickRenderedSelector,
  renderedSelectorSnapshot,
  waitForRenderedSelector,
  waitForRenderedSelectorEnabled,
} from "./renderedControls.mjs";

export async function setPaginationEnabledViaUi(enabled) {
  const switchSelector = 'button[role="switch"][aria-label="Pagination"]';
  let menuOpened = false;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await clickRenderedSelector(
      '[data-testid="chat-panel-header-more-button"]',
      { label: "chat panel header menu" }
    );
    const opened = await browser
      .waitUntil(
        async () => Boolean(await renderedSelectorSnapshot(switchSelector)),
        { timeout: 2_000 }
      )
      .then(() => true)
      .catch(() => false);
    if (opened) {
      menuOpened = true;
      break;
    }
    await browser.keys(["Escape"]);
    await browser.pause(250);
  }
  if (!menuOpened) {
    throw new Error("pagination menu did not open after six rendered clicks");
  }
  await waitForRenderedSelectorEnabled(switchSelector, {
    label: "pagination switch",
  });
  const isEnabled =
    (await renderedSelectorSnapshot(switchSelector))?.attributes[
      "aria-checked"
    ] === "true";
  if (isEnabled !== enabled) {
    await clickCurrentRenderedSelector(switchSelector);
    await browser.waitUntil(
      async () =>
        ((await renderedSelectorSnapshot(switchSelector))?.attributes[
          "aria-checked"
        ] ===
          "true") ===
        enabled,
      {
        timeout: 10_000,
        timeoutMsg: `pagination switch did not become ${enabled ? "enabled" : "disabled"}`,
      }
    );
  }
  await browser.keys(["Escape"]);
}

async function renderedSelectorCenter(selector) {
  await waitForRenderedSelector(selector, {
    label: `${selector} wheel origin`,
  });
  const center = await execJS(`
    const element = document.querySelector(${JSON.stringify(selector)});
    const rect = element?.getBoundingClientRect();
    if (!rect) return null;
    return {
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
    };
  `);
  if (!center) {
    throw new Error(`${selector} disappeared before its wheel action`);
  }
  return center;
}

export async function performWheelGesture(selector, deltaY, duration = 80) {
  const center = await renderedSelectorCenter(selector);
  await browser
    .action("wheel")
    .scroll({
      origin: "viewport",
      x: center.x,
      y: center.y,
      deltaX: 0,
      deltaY,
      duration,
    })
    .perform();
}

export async function performWheelBurst(selector, deltaY, count) {
  const center = await renderedSelectorCenter(selector);
  const action = browser.action("wheel");
  for (let index = 0; index < count; index += 1) {
    action.scroll({
      origin: "viewport",
      x: center.x,
      y: center.y,
      deltaX: 0,
      deltaY,
      duration: 0,
    });
  }
  await action.perform();
}

export async function clickCurrentRenderedSelector(selector) {
  const clicked = await execJS(`
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return false;
    element.focus();
    element.click();
    return true;
  `);
  if (!clicked) {
    throw new Error(`rendered element disappeared before click: ${selector}`);
  }
}

export async function ensureTurnPageItemVisibleWithUserSort(pageIndex) {
  const selector = `[data-testid="turn-page-list-item"][data-turn-page-index="${pageIndex}"]`;
  const scrollRootSelector = '[data-testid="turn-page-list"] .overflow-y-auto';
  await browser.waitUntil(
    () =>
      execJS(`
        return Boolean(
          document.querySelector('[data-testid="turn-page-list"]')
        );
      `),
    {
      timeout: 10_000,
      timeoutMsg: "turn-page-list did not render",
    }
  );
  const itemIsVisible = await execJS(`
    return Boolean(document.querySelector(${JSON.stringify(selector)}));
  `);
  if (itemIsVisible) return;

  const readListSnapshot = () =>
    execJS(`
    const root = document.querySelector(${JSON.stringify(scrollRootSelector)});
    return {
      scrollTop: root?.scrollTop ?? null,
      scrollHeight: root?.scrollHeight ?? null,
      clientHeight: root?.clientHeight ?? null,
      hasSortButton: Boolean(document.querySelector(
        '[data-testid="turn-page-list"] button[aria-label="Sort"]'
      )),
      renderedPageIndices: Array.from(
        document.querySelectorAll('[data-testid="turn-page-list-item"]')
      ).map((item) => Number(item.getAttribute('data-turn-page-index')))
        .filter(Number.isFinite),
    };
  `);

  let snapshot = await readListSnapshot();
  let sortAttempted = false;
  for (let attempt = 0; attempt < 48; attempt += 1) {
    if (
      await execJS(`
        return Boolean(document.querySelector(${JSON.stringify(selector)}));
      `)
    ) {
      return;
    }

    const rendered = snapshot.renderedPageIndices ?? [];
    const minimum = rendered.length > 0 ? Math.min(...rendered) : null;
    const maximum = rendered.length > 0 ? Math.max(...rendered) : null;
    if (
      !sortAttempted &&
      snapshot.hasSortButton &&
      minimum !== null &&
      maximum !== null &&
      ((pageIndex < minimum && snapshot.scrollTop <= 1) ||
        (pageIndex > maximum &&
          snapshot.scrollTop + snapshot.clientHeight >=
            snapshot.scrollHeight - 1))
    ) {
      console.log(
        `[issue-443-real-codex] clicking catalog sort for Round ${pageIndex + 1}`
      );
      await clickCurrentRenderedSelector(
        '[data-testid="turn-page-list"] button[aria-label="Sort"]'
      );
      sortAttempted = true;
      await browser.pause(50);
      snapshot = await readListSnapshot();
      continue;
    }

    const firstRendered = rendered[0] ?? null;
    const lastRendered = rendered[rendered.length - 1] ?? null;
    const renderedDescending =
      firstRendered !== null &&
      lastRendered !== null &&
      firstRendered > lastRendered;
    const targetIsAfterViewport =
      firstRendered !== null &&
      lastRendered !== null &&
      (renderedDescending
        ? pageIndex < lastRendered
        : pageIndex > lastRendered);
    const deltaY = targetIsAfterViewport ? 900 : -900;
    await performWheelGesture(scrollRootSelector, deltaY, 30);
    await browser.pause(30);
    snapshot = await readListSnapshot();
  }
  throw new Error(
    `turn-page-list item ${pageIndex} did not become visible through rendered sort/scroll: ${JSON.stringify(snapshot)}`
  );
}
