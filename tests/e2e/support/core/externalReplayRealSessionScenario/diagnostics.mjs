import {
  execJS,
  getChatViewportSnapshot,
  getRpcCounts,
  invokeE2E,
  invokeTauriCommand,
} from "../externalReplayUiDriver.mjs";
import { processMemoryRows } from "./memory.mjs";

export async function logIssue443RealCodexDiagnostics(label) {
  // Keep WebDriver script commands sequential. The Tauri WebDriver plugin
  // supports only one pending script and poisons its script lock if diagnostic
  // execute calls overlap.
  const rpcCounts = await getRpcCounts().catch((error) => ({
    error: String(error),
  }));
  const state = await invokeE2E("inspectChatState").catch((error) => ({
    error: String(error),
  }));
  const memory = await invokeTauriCommand("get_app_memory_snapshot_v1").catch(
    (error) => ({
      error: String(error),
    })
  );
  const viewport = await getChatViewportSnapshot([]).catch((error) => ({
    error: String(error),
  }));
  const bodyText = await execJS(
    "return String(document.body?.innerText ?? '').slice(0, 2000);"
  ).catch((error) => `diagnostic body unavailable: ${String(error)}`);
  const lastReplayRead = await execJS(
    "return window.__orgiiE2ELastReplayRead ?? null;"
  ).catch((error) => ({ error: String(error) }));
  const replayWindows = await execJS(
    "return [...(window.__orgiiE2EReplayWindows ?? [])];"
  ).catch((error) => ({ error: String(error) }));
  const renderedContract = await execJS(`
    const root = document.querySelector('[data-testid="chat-history-scroll-root"]');
    const rootRect = root?.getBoundingClientRect() ?? null;
    const groups = Array.from(
      document.querySelectorAll('[data-chat-view-root] [data-chat-group-index]')
    );
    const visibleGroups = rootRect
      ? groups.filter((group) => {
          const rect = group.getBoundingClientRect();
          return rect.bottom > rootRect.top + 1 && rect.top < rootRect.bottom - 1;
        })
      : [];
    const catalog = document.querySelector('[data-testid="turn-page-list"]');
    const catalogRoot = catalog?.querySelector('.overflow-y-auto');
    const catalogIndices = Array.from(
      catalog?.querySelectorAll('[data-testid="turn-page-list-item"]') ?? []
    ).map((item) => Number(item.getAttribute('data-turn-page-index')));
    const target = window.__orgiiE2EIssue443Target ?? null;
    const targetGroup = Number.isSafeInteger(target?.turnIndex)
      ? groups.find(
          (group) =>
            Number(group.getAttribute('data-replay-turn-index')) ===
            target.turnIndex
        )
      : null;
    return {
      target,
      targetInEventStore: target?.userEventId
        ? ${JSON.stringify(state?.chatEventIds ?? [])}.includes(target.userEventId)
        : null,
      targetPainted: targetGroup && rootRect
        ? (() => {
            const rect = targetGroup.getBoundingClientRect();
            return (
              rect.bottom > rootRect.top + 1 &&
              rect.top < rootRect.bottom - 1 &&
              String(targetGroup.innerText ?? '').trim().length >= 8
            );
          })()
        : false,
      virtualList: {
        renderedGroupIndices: groups.map((group) =>
          Number(group.getAttribute('data-chat-group-index'))
        ),
        visibleTurnIndices: visibleGroups.map((group) =>
          Number(group.getAttribute('data-replay-turn-index'))
        ),
        scrollTop: root?.scrollTop ?? null,
        scrollHeight: root?.scrollHeight ?? null,
        clientHeight: root?.clientHeight ?? null,
      },
      catalog: {
        renderedTurnIndices: catalogIndices,
        scrollTop: catalogRoot?.scrollTop ?? null,
        scrollHeight: catalogRoot?.scrollHeight ?? null,
        clientHeight: catalogRoot?.clientHeight ?? null,
      },
      navigatorTurnIndices: Array.from(
        document.querySelectorAll(
          'nav[aria-label="Conversation navigator"] [data-replay-turn-index]'
        )
      ).map((marker) => Number(marker.getAttribute('data-replay-turn-index'))),
      currentRound:
        document.querySelector('[data-testid="turn-pagination-current-round"]')
          ?.textContent ?? null,
    };
  `).catch((error) => ({ error: String(error) }));
  const stateSummary =
    state?.error === undefined
      ? {
          activeSessionId: state?.activeSessionId ?? null,
          workstationActiveSessionId: state?.workstationActiveSessionId ?? null,
          chatEventCount: state?.chatEventCount ?? null,
          chatEventIdHead: (state?.chatEventIds ?? []).slice(0, 8),
          chatEventIdTail: (state?.chatEventIds ?? []).slice(-8),
          externalReplayTurnSummaryCount:
            state?.externalReplayTurnSummaryCount ?? null,
          externalReplayTurnSummarySamples:
            state?.externalReplayTurnSummarySamples ?? [],
          externalReplayCompactTurnIndices:
            state?.externalReplayCompactTurnIndices ?? [],
          externalReplayResidentTurnIndices:
            state?.externalReplayResidentTurnIndices ?? [],
          externalReplayAnchoredTurnIndices:
            state?.externalReplayAnchoredTurnIndices ?? [],
          externalReplayTransport: state?.externalReplayTransport ?? null,
          externalReplayTurnState: state?.externalReplayTurnState ?? null,
          runtimeError: state?.runtimeError ?? null,
          runtimeStatus: state?.runtimeStatus ?? null,
          sessionView: state?.sessionView ?? null,
          snapshotEventCount: state?.snapshotEventCount ?? null,
          turnPhase: state?.turnPhase ?? null,
        }
      : state;
  console.log(
    `[issue-443-real-codex] diagnostic=${label} ${JSON.stringify({
      rpcCounts,
      lastReplayRead,
      replayWindows,
      state: stateSummary,
      memory:
        memory?.error === undefined
          ? {
              effectiveTotalBytes: memory?.effective_total_bytes ?? null,
              processes: processMemoryRows(memory),
            }
          : memory,
      viewport,
      renderedContract,
      fatalReplayError:
        bodyText.includes("App error") ||
        bodyText.includes("Bounded replay window requires"),
    })}`
  );
}
