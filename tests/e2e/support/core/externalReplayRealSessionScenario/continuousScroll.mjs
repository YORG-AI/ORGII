import {
  clickCurrentRenderedSelector,
  execJS,
  getChatScrollMetrics,
  getRpcCounts,
  invokeE2E,
  performWheelBurst,
  positionChatNearPhysicalTopForBurst,
  rpcCountDelta,
  setPaginationEnabledViaUi,
  waitForRenderedSelector,
  waitForVisibleReplayTurn,
} from "../externalReplayUiDriver.mjs";

export async function waitForReplayReadAndLayoutStability({
  baselineCounts,
  label,
  minimumReads,
  stableForMs,
  timeout,
}) {
  let previousSnapshot = null;
  let stableSince = Date.now();
  let latestSnapshot = null;

  await browser.waitUntil(
    async () => {
      try {
        const counts = await getRpcCounts();
        const metrics = await getChatScrollMetrics();
        const state = await invokeE2E("inspectChatState");
        latestSnapshot = {
          reads: rpcCountDelta(
            counts,
            baselineCounts,
            "external_replay_read_window"
          ),
          scrollHeight: Math.round(Number(metrics?.scrollHeight ?? 0)),
          chatEventCount: state?.chatEventIds?.length ?? 0,
        };
      } catch (error) {
        latestSnapshot = {
          error: error instanceof Error ? error.message : String(error),
        };
      }
      const serialized = JSON.stringify(latestSnapshot);
      if (serialized !== previousSnapshot) {
        previousSnapshot = serialized;
        stableSince = Date.now();
      }
      return (
        latestSnapshot.reads >= minimumReads &&
        Date.now() - stableSince >= stableForMs
      );
    },
    {
      timeout,
      interval: 100,
      timeoutMsg: `${label} did not settle; latest=${JSON.stringify(latestSnapshot)}`,
    }
  );

  return latestSnapshot;
}

export async function assertContinuousIssue272ScrollBurst(totalTurnCount) {
  const beforePaginationOff = await getRpcCounts();
  await setPaginationEnabledViaUi(false);
  const scrollRootSelector = '[data-testid="chat-history-scroll-root"]';
  await waitForRenderedSelector(scrollRootSelector, {
    label: "Issue 272 continuous history root",
  });
  // Pagination OFF performs one bounded bootstrap. A large tool-heavy turn can
  // leave that read in flight after the RPC counter first appears stable, so
  // require both the counter and the rendered history shape to remain unchanged
  // before attributing subsequent reads to the user's wheel gesture.
  await waitForReplayReadAndLayoutStability({
    baselineCounts: beforePaginationOff,
    label: "Issue 272 Pagination OFF bootstrap",
    minimumReads: 1,
    stableForMs: 3_000,
    timeout: 45_000,
  });
  const middleSampledMarkerIndex =
    totalTurnCount <= 20
      ? Math.floor((totalTurnCount - 1) / 2)
      : Math.round((10 / 19) * (totalTurnCount - 1));
  const sampledMarkerIndices = [
    0,
    middleSampledMarkerIndex,
    totalTurnCount - 1,
  ];
  await browser.waitUntil(
    () =>
      execJS(`
        const expected = ${JSON.stringify(sampledMarkerIndices)};
        return expected.every((turnIndex) =>
          document.querySelector(
            \`nav[aria-label="Conversation navigator"] [data-replay-turn-index="\${turnIndex}"]\`
          )
        );
      `),
    {
      timeout: 20_000,
      interval: 100,
      timeoutMsg:
        "Issue 272 navigator did not expose first, middle, and latest provider Rounds before body hydration",
    }
  );
  const beforeReads = await getRpcCounts();
  const beforeBudgetRetries = Number(
    await execJS("return window.__orgiiE2EReplayBudgetRetries || 0;")
  );
  await positionChatNearPhysicalTopForBurst();
  const anchorBefore = await execJS(`
    const root = document.querySelector(${JSON.stringify(scrollRootSelector)});
    const rootRect = root?.getBoundingClientRect();
    const items = Array.from(
      document.querySelectorAll(
        '[data-chat-view-root] [data-chat-item-key]'
      )
    );
    const groups = Array.from(
      document.querySelectorAll(
        '[data-chat-view-root] [data-chat-group-index]'
      )
    );
    const findVisible = (elements) =>
      rootRect
        ? elements.find((element) => {
          const rect = element.getBoundingClientRect();
          return rect.bottom > rootRect.top + 1 && rect.top < rootRect.bottom - 1;
        })
        : null;
    const visibleItem = findVisible(items);
    const visibleGroup = findVisible(groups);
    return {
      itemKey: visibleItem?.getAttribute("data-chat-item-key") ?? null,
      groupKey: visibleGroup?.getAttribute("data-chat-group-key") ?? null,
      turnId: visibleGroup?.getAttribute("data-chat-turn-id") ?? null,
      text: String((visibleItem ?? visibleGroup)?.innerText ?? "").slice(0, 160),
      scrollTop: root?.scrollTop ?? null,
      scrollHeight: root?.scrollHeight ?? null,
    };
  `);
  await performWheelBurst(scrollRootSelector, -900, 12);
  await waitForReplayReadAndLayoutStability({
    baselineCounts: beforeReads,
    label: "Issue 272 continuous scroll burst",
    minimumReads: 4,
    stableForMs: 1_500,
    timeout: 90_000,
  });
  const afterReads = await getRpcCounts();
  const boundedReads = rpcCountDelta(
    afterReads,
    beforeReads,
    "external_replay_read_window"
  );
  const budgetRetries =
    Number(await execJS("return window.__orgiiE2EReplayBudgetRetries || 0;")) -
    beforeBudgetRetries;
  const logicalReads = boundedReads - budgetRetries;
  const anchorAfter = await execJS(`
    const expectedItemKey = ${JSON.stringify(anchorBefore?.itemKey ?? null)};
    const expectedGroupKey = ${JSON.stringify(anchorBefore?.groupKey ?? null)};
    const root = document.querySelector(${JSON.stringify(scrollRootSelector)});
    const rootRect = root?.getBoundingClientRect();
    const groups = Array.from(
      document.querySelectorAll(
        '[data-chat-view-root] [data-chat-group-index]'
      )
    );
    const anchor = expectedItemKey
      ? document.querySelector(
          \`[data-chat-view-root] [data-chat-item-key="\${CSS.escape(expectedItemKey)}"]\`
        )
      : expectedGroupKey
        ? groups.find(
          (group) => group.getAttribute("data-chat-group-key") === expectedGroupKey
        )
        : null;
    const anchorRect = anchor?.getBoundingClientRect() ?? null;
    const anchorGroup = expectedGroupKey
      ? groups.find(
          (group) => group.getAttribute("data-chat-group-key") === expectedGroupKey
        )
      : null;
    const anchorGroupRect = anchorGroup?.getBoundingClientRect() ?? null;
    const visibleGroup = rootRect
      ? groups.find((group) => {
        const rect = group.getBoundingClientRect();
        return rect.bottom > rootRect.top + 1 && rect.top < rootRect.bottom - 1;
      })
      : null;
    const visibleGroupKey =
      visibleGroup?.getAttribute("data-chat-group-key") ?? null;
    const visibleTurnIndexMatch =
      /^external-replay-turn-(\\d+)$/.exec(visibleGroupKey ?? "");
    const anchorTurnIndexMatch =
      /^external-replay-turn-(\\d+)$/.exec(expectedGroupKey ?? "");
    return {
      anchorPresent: Boolean(anchor),
      anchorVisible: Boolean(
        rootRect &&
          anchorRect &&
          anchorRect.bottom > rootRect.top + 1 &&
          anchorRect.top < rootRect.bottom - 1
      ),
      anchorTop: anchorRect?.top ?? null,
      anchorBottom: anchorRect?.bottom ?? null,
      anchorGroupPresent: Boolean(anchorGroup),
      anchorGroupTop: anchorGroupRect?.top ?? null,
      anchorGroupBottom: anchorGroupRect?.bottom ?? null,
      anchorGroupVisible: Boolean(
        rootRect &&
          anchorGroupRect &&
          anchorGroupRect.bottom > rootRect.top + 1 &&
          anchorGroupRect.top < rootRect.bottom - 1
      ),
      rootTop: rootRect?.top ?? null,
      rootBottom: rootRect?.bottom ?? null,
      visibleGroupKey,
      visibleText: String(visibleGroup?.innerText ?? "").slice(0, 160),
      visibleTurnIndex: visibleTurnIndexMatch
        ? Number(visibleTurnIndexMatch[1])
        : null,
      anchorTurnIndex: anchorTurnIndexMatch
        ? Number(anchorTurnIndexMatch[1])
        : null,
      scrollTop: root?.scrollTop ?? null,
      scrollHeight: root?.scrollHeight ?? null,
      navigatorLabels: Array.from(
        document.querySelectorAll(
          'nav[aria-label="Conversation navigator"] button[aria-label^="Go to turn"]'
        )
      ).map((button) => button.getAttribute("aria-label") ?? ""),
    };
  `);
  const expectedTotalPattern = new RegExp(
    `Go to turn \\d+ of ${totalTurnCount}:`
  );
  const retainedAnchorVisible =
    (anchorAfter?.anchorPresent && anchorAfter?.anchorVisible) ||
    anchorAfter?.anchorGroupVisible;
  const advancedIntoOlderResidentWindow =
    Number.isSafeInteger(anchorAfter?.visibleTurnIndex) &&
    Number.isSafeInteger(anchorAfter?.anchorTurnIndex) &&
    anchorAfter.visibleTurnIndex < anchorAfter.anchorTurnIndex &&
    String(anchorAfter?.visibleText ?? "").trim().length > 0;
  if (
    logicalReads < 4 ||
    logicalReads > 12 ||
    !(anchorBefore?.itemKey || anchorBefore?.groupKey) ||
    !(retainedAnchorVisible || advancedIntoOlderResidentWindow) ||
    !(Number(anchorAfter?.scrollTop) > 1) ||
    !Array.isArray(anchorAfter?.navigatorLabels) ||
    anchorAfter.navigatorLabels.length < 2 ||
    anchorAfter.navigatorLabels.some(
      (label) => !expectedTotalPattern.test(String(label))
    )
  ) {
    throw new Error(
      `Issue 272 continuous scroll lost batching, provider numbering, or its viewport anchor: ${JSON.stringify(
        {
          boundedReads,
          budgetRetries,
          logicalReads,
          anchorBefore,
          anchorAfter,
          totalTurnCount,
        }
      )}`
    );
  }

  const latestTurnIndex = totalTurnCount - 1;
  const beforeLatestJump = await getRpcCounts();
  await clickCurrentRenderedSelector(
    `nav[aria-label="Conversation navigator"] [data-replay-turn-index="${latestTurnIndex}"]`
  );
  await waitForVisibleReplayTurn({
    turnIndex: latestTurnIndex,
    label: "Issue 272 navigator jump back to latest Round",
  });
  const latestJumpReads = rpcCountDelta(
    await getRpcCounts(),
    beforeLatestJump,
    "external_replay_read_window"
  );
  if (latestJumpReads > 4) {
    throw new Error(
      `Issue 272 latest navigator jump issued ${latestJumpReads} bounded reads; expected 0..4`
    );
  }
}
