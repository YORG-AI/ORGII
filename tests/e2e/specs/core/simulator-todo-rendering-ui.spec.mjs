/* global describe, before, after, it, browser */
/**
 * Simulator todo rendering UI spec.
 *
 * Regression coverage for the "updated to-dos / 0 items" bug: native
 * ORGII `manage_todo` events store their snapshot inside the LLM-facing
 * `result.content` text (`"<header>\n[JSON array]\n<nudge>"`). The
 * simulator Messages app (Communication) previously found no rows for
 * `update`/`read` events (no `args.todos`) and rendered empty cards.
 *
 * Pipeline under test (all live production code; only seeding is debug):
 *   seedChatEvents → Rust EventStore (es_set → recompute_extracted →
 *   extract_todo content-text backfill) → derived snapshot →
 *   Communication MessageViewer → TodoBubble → TodoBlock rows
 *   plus the Kanban tab → TodoKanban cards.
 */
import {
  execJS,
  invokeE2E,
  unwrap,
  waitForApp,
} from "../../support/core/session/agentQueuedFollowupDriver.mjs";

const RENDER_TIMEOUT_MS = 20_000;
const RUN_ID = Date.now();
const SESSION_ID = `sdeagent-e2e-sim-todo-${RUN_ID}`;

const TASK_DONE = `SimTodoAlphaDone${RUN_ID}`;
const TASK_ACTIVE = `SimTodoBravoActive${RUN_ID}`;
const TASK_ACTIVE_FORM = `SimTodoBravoActiveForm${RUN_ID}`;
const TASK_PENDING = `SimTodoCharliePending${RUN_ID}`;

const BASE_MS = Date.now() - 10 * 60 * 1000;
const atOffset = (minutes) =>
  new Date(BASE_MS + minutes * 60_000).toISOString();

// Exact shape produced by the native TodoTool's render_result(): the
// snapshot lives ONLY in result.content — no args.todos, no observation.
function nativeTodoContent(header, todos) {
  return `${header}\n${JSON.stringify(todos, null, 2)}\n\nEnsure that you continue to use the todo list to track your progress.`;
}

const TODO_SNAPSHOT = [
  {
    activeForm: null,
    content: TASK_DONE,
    index: 0,
    priority: "high",
    status: "completed",
  },
  {
    activeForm: TASK_ACTIVE_FORM,
    content: TASK_ACTIVE,
    index: 1,
    priority: "high",
    status: "in_progress",
  },
  {
    activeForm: null,
    blockedBy: [1],
    content: TASK_PENDING,
    index: 2,
    priority: "medium",
    status: "pending",
  },
];

function makeUserEvent() {
  return {
    id: `${SESSION_ID}-user`,
    chunk_id: `${SESSION_ID}-user`,
    sessionId: SESSION_ID,
    createdAt: atOffset(0),
    functionName: "user_message",
    uiCanonical: "user_message",
    actionType: "raw",
    args: {},
    result: {
      type: "user",
      message: "Run the multi-step task",
      is_delta: false,
    },
    source: "user",
    displayText: "Run the multi-step task",
    displayStatus: "completed",
    displayVariant: "message",
    activityStatus: "processed",
    isDelta: false,
  };
}

// The regression case: an `update` event whose args carry only
// {action, index, status} — the full snapshot is in result.content text.
function makeTodoUpdateEvent() {
  return {
    id: `${SESSION_ID}-todo-update`,
    chunk_id: `${SESSION_ID}-todo-update`,
    sessionId: SESSION_ID,
    createdAt: atOffset(2),
    functionName: "manage_todo",
    uiCanonical: "manage_todo",
    actionType: "tool_call",
    args: { action: "update", index: 1, status: "in_progress" },
    result: {
      content: nativeTodoContent(
        "Updated todo #1 — 3 todos (2 remaining)",
        TODO_SNAPSHOT
      ),
    },
    source: "assistant",
    displayText: "Manage Todo",
    displayStatus: "completed",
    displayVariant: "tool_call",
    activityStatus: "agent",
    isDelta: false,
  };
}

const EVENTS = [makeUserEvent(), makeTodoUpdateEvent()];

async function seedCommunication() {
  unwrap(
    await invokeE2E("seedChatEvents", SESSION_ID, EVENTS, {
      chatPanelMaximized: false,
      chatWidth: 460,
      currentEventId: `${SESSION_ID}-todo-update`,
      stationMode: "agent-station",
      selectedApp: "CHANNELS",
    }),
    "seedChatEvents communication todo"
  );
}

async function communicationSnapshot() {
  return execJS(`
    const root = document.querySelector('[data-testid="communication-message-viewer"]');
    const body = (root && root.innerText) || '';
    const kanban = document.querySelector('[data-testid="replay-todo-kanban"]');
    const kanbanText = (kanban && kanban.innerText) || '';
    return {
      hasViewer: !!root,
      hasDone: body.includes(${JSON.stringify(TASK_DONE)}),
      hasActiveForm: body.includes(${JSON.stringify(TASK_ACTIVE_FORM)}),
      hasActiveContent: body.includes(${JSON.stringify(TASK_ACTIVE)}),
      hasPending: body.includes(${JSON.stringify(TASK_PENDING)}),
      hasZeroItems: /\\b0 items\\b/.test(body),
      hasKanban: !!kanban,
      kanbanHasDone: kanbanText.includes(${JSON.stringify(TASK_DONE)}),
      kanbanHasActive: kanbanText.includes(${JSON.stringify(TASK_ACTIVE)}),
      kanbanHasPending: kanbanText.includes(${JSON.stringify(TASK_PENDING)}),
      bodyText: body.slice(0, 4000),
    };
  `);
}

async function waitForCommunication(assertion, label) {
  await browser.waitUntil(
    async () => assertion(await communicationSnapshot()),
    {
      timeout: RENDER_TIMEOUT_MS,
      interval: 400,
      timeoutMsg: `${label}: ${JSON.stringify(await communicationSnapshot()).slice(0, 1500)}`,
    }
  );
}

async function expandTodoCards() {
  // TodoBlock seeds collapsed (`defaultCollapsed`); click each block's
  // header row so the rows become visible, mirroring the user's click path.
  return execJS(`
    const blocks = Array.from(document.querySelectorAll('[data-testid="chat-todo-block"]'));
    blocks.forEach((block) => {
      const header = block.firstElementChild;
      if (header) header.click();
    });
    return blocks.length;
  `);
}

describe("Simulator todo rendering UI", () => {
  before(async () => {
    await waitForApp();
    unwrap(
      await invokeE2E("navigateTo", "/orgii/workstation/code"),
      "navigateTo workstation code"
    );
    unwrap(await invokeE2E("resetToNewSession"), "resetToNewSession");
  });

  after(async () => {
    await invokeE2E("deleteSessionWire", SESSION_ID);
  });

  it("renders the Kanban with all rows parsed from result.content (default view for a todo cursor)", async () => {
    await seedCommunication();
    // When the replay cursor sits on a manage_todo event the Communication
    // app opens directly in the Kanban view.
    await waitForCommunication(
      (snap) =>
        snap.hasKanban &&
        snap.kanbanHasDone &&
        snap.kanbanHasActive &&
        snap.kanbanHasPending,
      "kanban should show all three todo cards parsed from the native content text"
    );
  });

  it("renders todo bubble rows on the Messages tab with no '0 items' placeholder", async () => {
    const clicked = await execJS(`
      const tab = document.querySelector('[data-testid="replay-tab-chat"]');
      if (!tab) return false;
      tab.click();
      return true;
    `);
    if (!clicked) {
      throw new Error("replay-tab-chat not found in rendered tab bar");
    }
    await waitForCommunication(
      (snap) => snap.hasViewer,
      "communication viewer should mount after clicking Messages tab"
    );
    // Expand inside the poll loop: the collapsed TodoBlock may mount a
    // frame later than the viewer, so re-click until the rows appear.
    await browser.waitUntil(
      async () => {
        await expandTodoCards();
        const snap = await communicationSnapshot();
        return (
          snap.hasDone &&
          snap.hasActiveForm &&
          snap.hasPending &&
          !snap.hasZeroItems
        );
      },
      {
        timeout: RENDER_TIMEOUT_MS,
        interval: 400,
        timeoutMsg: `todo bubble should list all three rows with no '0 items' placeholder: ${JSON.stringify(await communicationSnapshot()).slice(0, 1500)}`,
      }
    );
  });
});
