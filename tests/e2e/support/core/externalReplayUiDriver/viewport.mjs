import { execJS } from "./bridge.mjs";
import {
  renderedSelectorSnapshot,
  waitForRenderedSelector,
} from "./renderedControls.mjs";

export async function getChatViewportSnapshot(markers, pinnedMarkers = []) {
  return execJS(`
    const markers = ${JSON.stringify(markers)};
    const pinnedMarkers = ${JSON.stringify(pinnedMarkers)};
    const root = document.querySelector('[data-testid="chat-history-scroll-root"]');
    const list = document.querySelector(
      '[data-chat-view-root] [data-testid="chat-message-list"]'
    );
    const pinnedHeader = document.querySelector(
      '[data-chat-pinned-header-layer]'
    );
    if (!root || !list) {
      return {
        rootMissing: !root,
        listMissing: !list,
        markers: [],
        pinnedMarkers: [],
        chatText: "",
      };
    }
    const rootRect = root.getBoundingClientRect();
    const pinnedHeaderRect = pinnedHeader?.getBoundingClientRect() ?? null;
    const pinnedHeaderText = pinnedHeader?.innerText || "";
    const groups = Array.from(list.querySelectorAll('[data-chat-group-index]'));
    const visibleGroups = groups
      .map((group) => {
        const rect = group.getBoundingClientRect();
        return {
          groupIndex: group.getAttribute("data-chat-group-index"),
          groupKey: group.getAttribute("data-chat-group-key"),
          replayTurnIndex: group.getAttribute("data-replay-turn-index"),
          text: String(group.innerText ?? "").trim().slice(0, 320),
          rect: { top: rect.top, bottom: rect.bottom },
          visible:
            rect.bottom > rootRect.top + 1 &&
            rect.top < rootRect.bottom - 1,
        };
      })
      .filter((group) => group.visible);
    return {
      scrollTop: root.scrollTop,
      scrollHeight: root.scrollHeight,
      clientHeight: root.clientHeight,
      rootRect: { top: rootRect.top, bottom: rootRect.bottom },
      chatText: (list.innerText || "").slice(0, 16000),
      visibleGroups,
      markers: markers.map((marker) => {
        const group = groups.find((candidate) =>
          (candidate.innerText || "").includes(marker)
        );
        const rect = group?.getBoundingClientRect() ?? null;
        return {
          marker,
          inRenderedList: Boolean(group),
          visible: Boolean(
            rect &&
              rect.bottom > rootRect.top + 1 &&
              rect.top < rootRect.bottom - 1
          ),
          rect: rect ? { top: rect.top, bottom: rect.bottom } : null,
        };
      }),
      pinnedHeaderText,
      pinnedMarkers: pinnedMarkers.map((marker) => ({
        marker,
        inPinnedHeader: pinnedHeaderText.includes(marker),
        visible: Boolean(
          pinnedHeaderRect &&
            pinnedHeaderRect.width > 0 &&
            pinnedHeaderRect.height > 0
        ),
      })),
    };
  `);
}

export async function waitForChatTurn({
  markers,
  label,
  visibleMarker = markers[0],
  pinnedMarkers = [],
  excludes = [],
}) {
  let snapshot = null;
  try {
    await browser.waitUntil(
      async () => {
        snapshot = await getChatViewportSnapshot(markers, pinnedMarkers);
        const target = snapshot?.markers?.find(
          (entry) => entry.marker === visibleMarker
        );
        return (
          snapshot?.markers?.every((entry) => entry.inRenderedList) &&
          snapshot?.pinnedMarkers?.every(
            (entry) => entry.inPinnedHeader && entry.visible
          ) &&
          Boolean(target?.visible) &&
          excludes.every(
            (excluded) =>
              !`${String(snapshot?.chatText ?? "")}\n${String(
                snapshot?.pinnedHeaderText ?? ""
              )}`.includes(excluded)
          )
        );
      },
      {
        timeout: 30_000,
        interval: 100,
        timeoutMsg: `${label} did not paint inside the active chat viewport`,
      }
    );
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; final viewport=${JSON.stringify(snapshot)}`
    );
  }
  return snapshot;
}

export async function waitForVisibleReplayTurn({ turnIndex, label }) {
  let snapshot = null;
  try {
    await browser.waitUntil(
      async () => {
        snapshot = await getChatViewportSnapshot([]);
        return Boolean(
          snapshot?.visibleGroups?.some(
            (group) =>
              Number(group.replayTurnIndex) === turnIndex &&
              String(group.text ?? "").trim().length >= 8
          )
        );
      },
      {
        timeout: 30_000,
        interval: 100,
        timeoutMsg: `${label} did not paint a non-empty group for provider Round ${turnIndex + 1}`,
      }
    );
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; final viewport=${JSON.stringify(snapshot)}`
    );
  }
  return snapshot;
}

export async function waitForCurrentReplayRound({
  turnIndex,
  label,
  allowLatestLabel = false,
}) {
  const selector = '[data-testid="turn-pagination-current-round"]';
  await waitForRenderedSelector(selector, { label });
  let snapshot = null;
  try {
    await browser.waitUntil(
      async () => {
        snapshot = await renderedSelectorSnapshot(selector);
        const text = String(snapshot?.text ?? "");
        return (
          text.includes(`Round ${turnIndex + 1}`) ||
          (allowLatestLabel && text.includes("Latest round"))
        );
      },
      {
        timeout: 20_000,
        interval: 100,
        timeoutMsg: `${label} did not identify provider Round ${turnIndex + 1}`,
      }
    );
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; current-round=${JSON.stringify(snapshot)}`
    );
  }
  return snapshot;
}

export async function getChatScrollMetrics() {
  return execJS(`
    const root = document.querySelector('[data-testid="chat-history-scroll-root"]');
    if (!root) throw new Error("chat history scroll root is missing");
    return {
      scrollTop: root.scrollTop,
      scrollHeight: root.scrollHeight,
      clientHeight: root.clientHeight,
    };
  `);
}

export async function positionChatNearPhysicalTopForBurst(topOffset = 1) {
  // Deterministic setup only. The edge crossing and repeated pressure are real
  // W3C wheel actions in `performWheelBurst`.
  let stableSamples = 0;
  let snapshot = null;
  await browser.waitUntil(
    async () => {
      snapshot = await execJS(`
        const root = document.querySelector('[data-testid="chat-history-scroll-root"]');
        if (!root) throw new Error("chat history scroll root is missing");
        const target = Math.min(
          ${topOffset},
          Math.max(0, root.scrollHeight - root.clientHeight)
        );
        if (Math.abs(root.scrollTop - target) > 1) {
          root.scrollTop = target;
        }
        return {
          scrollTop: root.scrollTop,
          scrollHeight: root.scrollHeight,
          clientHeight: root.clientHeight,
        };
      `);
      if (Number(snapshot?.scrollTop) <= topOffset + 1) {
        stableSamples += 1;
      } else {
        stableSamples = 0;
      }
      return stableSamples >= 3;
    },
    {
      timeout: 5_000,
      interval: 50,
      timeoutMsg: "chat history did not settle at its physical top edge",
    }
  );
  return snapshot;
}

export async function assertNoReplayFatalError(label) {
  const body = String(await execJS("return document.body.innerText || '';"));
  if (
    body.includes("App error") ||
    body.includes("Bounded replay window requires")
  ) {
    throw new Error(`${label} surfaced a fatal replay wire-budget error`);
  }
}
