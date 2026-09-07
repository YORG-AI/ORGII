/* global before, browser, describe, it, process */
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  E2E_REPO_PATH,
  RENDER_TIMEOUT_MS,
  REPLY_TIMEOUT_MS,
  RUN_ID,
  assertE2ERepoFixture,
  execJS,
  getApiAccount,
  invokeE2E,
  js,
  selectPreferredModel,
  unwrap,
  waitForApp,
} from "../../support/core/agentOrgUiDriver.mjs";

const E2E_BASE_URL = `http://127.0.0.1:${process.env.E2E_IDE_SERVER_PORT ?? "13847"}`;

async function postFixture(pathname, body, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${E2E_BASE_URL}${pathname}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const json = await response.json();
    if (!response.ok || json?.ok !== true) {
      throw new Error(`${pathname} failed: ${JSON.stringify(json)}`);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForDisplayed(selector, label) {
  let visibleElement = null;
  await browser.waitUntil(
    async () => {
      const candidates = await browser.$$(selector);
      visibleElement = null;
      for (const candidate of candidates) {
        const size = await candidate.getSize();
        if (size.width > 0 && size.height > 0) {
          visibleElement = candidate;
        }
      }
      return Boolean(visibleElement);
    },
    {
      timeout: RENDER_TIMEOUT_MS,
      interval: 200,
      timeoutMsg: `${label} did not become visible (${selector})`,
    }
  );
  return visibleElement;
}

async function clickVisible(selector, label) {
  const element = await waitForDisplayed(selector, label);
  // WebDriver's native click scrolls the target into view. Calling
  // scrollIntoView first leaves a longer window for push-driven React renders
  // to replace Agent Org controls and stale the native element reference.
  await element.click();
  return element;
}

async function openRenderedMember(memberId, memberName) {
  const groupMemberSelector = `//section[@data-testid="agent-org-group-projection"]//button[normalize-space()=${JSON.stringify(memberName)}]`;
  if ((await browser.$$(groupMemberSelector)).length > 0) {
    await clickVisible(
      groupMemberSelector,
      `${memberName} Group projection button`
    );
    return;
  }
  await clickVisible(
    '[data-testid="agent-org-member-switcher-trigger"]',
    "Member switcher"
  );
  await clickVisible(
    `[data-testid="agent-org-member-switcher-option-${memberId}"]`,
    "canonical Member option"
  );
}

async function sendVisiblePrompt(prompt) {
  const editor = await waitForDisplayed(
    '[data-testid="chat-input"] [contenteditable="true"]',
    "Member composer"
  );
  await editor.click();
  const typed = await execJS(
    js.type('[data-testid="chat-input"] [contenteditable="true"]', prompt)
  );
  if (typed !== "typed") {
    throw new Error(`Member composer did not accept prompt: ${typed}`);
  }
  await browser.waitUntil(
    async () =>
      String(
        (await execJS(
          js.editorText('[data-testid="chat-input"] [contenteditable="true"]')
        )) ?? ""
      ).includes(prompt),
    {
      timeout: RENDER_TIMEOUT_MS,
      interval: 100,
      timeoutMsg: "Member composer did not retain native WebDriver key input",
    }
  );
  const send = await waitForDisplayed(
    '[data-testid="chat-send-button"][data-state="submit"]',
    "Member Send button"
  );
  await browser.waitUntil(async () => send.isEnabled(), {
    timeout: RENDER_TIMEOUT_MS,
    interval: 100,
    timeoutMsg: "Member Send button remained disabled after real typing",
  });
  await send.click();
}

async function runView(sessionId, label) {
  return unwrap(
    await invokeE2E("agentOrgSessionRunView", sessionId),
    `agentOrgSessionRunView(${label})`
  ).view;
}

describe("Agent Org direct UserDirectedWork with a live provider", () => {
  before(async () => {
    if (
      !new Set(["live", "api-key", "oauth-live"]).has(
        process.env.E2E_PROVIDER_MODE ?? ""
      )
    ) {
      throw new Error(
        "This spec requires E2E_PROVIDER_MODE=api-key or oauth-live (legacy live is also accepted); a fake or missing provider is blocked evidence, not a pass."
      );
    }
    assertE2ERepoFixture();
    await waitForApp();
  });

  it("uses the rendered Member composer, performs real file/shell work, and Returns by receipt", async () => {
    const account = await getApiAccount();
    const model = selectPreferredModel(account);
    const orgId = `e2e-direct-live-${RUN_ID}`;
    const orgName = `E2E Direct Live ${RUN_ID}`;
    const memberId = `direct-member-${RUN_ID}`;
    const markerName = `member-direct-${RUN_ID}.txt`;
    const shellMarkerName = `member-shell-${RUN_ID}.txt`;
    const markerPath = path.join(E2E_REPO_PATH, markerName);
    const shellMarkerPath = path.join(E2E_REPO_PATH, shellMarkerName);
    const exactContent = `MEMBER_DIRECT_PROVIDER_${RUN_ID}`;
    const writerTaskSubject = `Direct Writer Proof ${RUN_ID}`;

    await postFixture("/agent/test/agent-org/seed", {
      id: orgId,
      name: orgName,
      coordinator_agent_id: "builtin:sde",
      members: [
        {
          id: memberId,
          name: "Direct Live Member",
          role: "Implement the user's direct workspace request",
          agent_id: "builtin:sde",
        },
      ],
      additional_task_graph_writer_member_ids: [memberId],
    });
    const launched = await postFixture(
      "/agent/test/agent-org/launch-coordinator",
      {
        agent_org_id: orgId,
        workspace_path: E2E_REPO_PATH,
        content: "",
        model,
        account_id: account.id,
        sync_turn: false,
        name: orgName,
      },
      60_000
    );
    const rootSessionId = launched.session_id;
    if (!rootSessionId) {
      throw new Error(
        `fixture launch returned no Root Session: ${JSON.stringify(launched)}`
      );
    }

    let memberSessionId = null;
    await browser.waitUntil(
      async () => {
        const view = await runView(rootSessionId, "materialization");
        memberSessionId = view?.members?.find(
          (member) => member.memberId === memberId
        )?.sessionRuntime?.sessionId;
        return Boolean(memberSessionId);
      },
      {
        timeout: REPLY_TIMEOUT_MS,
        interval: 500,
        timeoutMsg: "canonical Member Session did not materialize",
      }
    );

    // Session launch runs through the debug backend fixture and can make this
    // new Root Session current before the sidebar navigation catches up. A
    // second click on an already-selected row opens its context menu, so use
    // the standard E2E navigation bridge only for test setup; Direct work,
    // Member selection, Send, and Return remain native rendered actions.
    unwrap(await invokeE2E("openSession", rootSessionId), "open Root Session");
    await browser.waitUntil(
      async () =>
        unwrap(
          await invokeE2E("getActiveSessionId"),
          "getActiveSessionId(Root before Member switch)"
        ).sessionId === rootSessionId,
      {
        timeout: RENDER_TIMEOUT_MS,
        interval: 200,
        timeoutMsg: "Root Session click did not finish navigation",
      }
    );
    await openRenderedMember(memberId, "Direct Live Member");
    await browser.waitUntil(
      async () =>
        unwrap(
          await invokeE2E("getActiveSessionId"),
          "getActiveSessionId(Member direct)"
        ).sessionId === memberSessionId,
      {
        timeout: RENDER_TIMEOUT_MS,
        interval: 200,
        timeoutMsg: "Member switch did not open the canonical Member Session",
      }
    );

    const directBar = await waitForDisplayed(
      '[data-testid="agent-org-member-direct-work-bar"]',
      "Member direct-work notice"
    );
    if ((await directBar.getAttribute("data-member-id")) !== memberId) {
      throw new Error("direct-work notice belongs to the wrong Member");
    }

    const prompt = [
      `Before editing files, call task_create exactly once with subject ${writerTaskSubject}, dispatch_policy immediate, execution_mode build, owner omitted, eligible_member_ids [${memberId}], and allow_parallel_with_unlisted_open_tasks true.`,
      `Continue only after task_create confirms that the durable Task exists. Leave that Task pending and ownerless, and do not call task_update.`,
      `This is direct user work. Create ${markerName} in the workspace with exactly ${exactContent}.`,
      `Then run a shell command that reads ${markerName}, verifies the exact content, and writes SHELL_OK_${RUN_ID} to ${shellMarkerName}.`,
      `Read both files back and reply with exactly DIRECT_DONE_${RUN_ID} only after both checks pass.`,
    ].join(" ");
    await sendVisiblePrompt(prompt);

    let acceptedReceipt = null;
    let acceptedSourceEventId = null;
    await browser.waitUntil(
      async () => {
        const view = await runView(memberSessionId, "direct accepted");
        const member = view?.members?.find(
          (candidate) => candidate.memberId === memberId
        );
        acceptedReceipt = member?.intervention?.interventionReceiptId ?? null;
        acceptedSourceEventId = member?.intervention?.sourceEventId ?? null;
        return (
          Boolean(acceptedReceipt) &&
          Boolean(acceptedSourceEventId) &&
          member?.activity?.source === "direct_member" &&
          member?.queuedUserDirectedCount === 1
        );
      },
      {
        timeout: RENDER_TIMEOUT_MS,
        interval: 200,
        timeoutMsg:
          "direct source did not become one durable receipt/queued Turn",
      }
    );

    let renderedReply = "";
    await browser.waitUntil(
      async () => {
        const assistantRows = await browser.$$(
          '[data-testid="chat-message-assistant"], [data-testid="agent-org-group-projection-item"][data-item-kind="assistant_reply"]'
        );
        const texts = [];
        for (const row of assistantRows) texts.push(await row.getText());
        renderedReply = texts.join("\n");
        return renderedReply.includes(`DIRECT_DONE_${RUN_ID}`);
      },
      {
        timeout: REPLY_TIMEOUT_MS,
        interval: 1_000,
        timeoutMsg: `live Provider reply did not render: ${renderedReply}`,
      }
    );
    if ((await readFile(markerPath, "utf8")).trim() !== exactContent) {
      throw new Error(
        "live Provider file write did not match the exact marker"
      );
    }
    if (
      (await readFile(shellMarkerPath, "utf8")).trim() !== `SHELL_OK_${RUN_ID}`
    ) {
      throw new Error(
        "live Provider shell verification did not create its marker"
      );
    }
    const chatEvidence = unwrap(
      await invokeE2E("inspectChatState"),
      "inspectChatState(direct source/reply evidence)"
    );
    const directSources = (chatEvidence.rawEvents ?? []).filter(
      (event) =>
        event.id === acceptedSourceEventId &&
        event.functionName === "user_message" &&
        event.result?.agentOrgDirectSource === true
    );
    const directTurnUserEvents = (chatEvidence.rawEvents ?? []).filter(
      (event) =>
        event.functionName === "user_message" &&
        event.result?.turnIntentId === directSources[0]?.result?.turnIntentId
    );
    const exactReplies = (chatEvidence.rawEvents ?? []).filter(
      (event) => event.result?.reply_to_event_id === acceptedSourceEventId
    );
    if (
      directSources.length !== 1 ||
      directTurnUserEvents.length !== 1 ||
      exactReplies.length < 1
    ) {
      throw new Error(
        `EventStore source/reply identity was not exact: ${JSON.stringify({ acceptedSourceEventId, directSources, directTurnUserEvents, exactReplies })}`
      );
    }

    const evidence = await postFixture(
      "/agent/test/agent-org/user-directed/evidence",
      { org_run_id: launched.agent_org_run_id }
    );
    const matchingAdmissions = (evidence.runtime_admissions ?? []).filter(
      (admission) =>
        admission.session_id === memberSessionId &&
        admission.turn_intent_id === directSources[0]?.result?.turnIntentId &&
        admission.member_id === memberId
    );
    if (
      matchingAdmissions.length !== 1 ||
      matchingAdmissions[0].status !== "committed" ||
      !matchingAdmissions[0].reservation_id ||
      !matchingAdmissions[0].runtime_lease_id
    ) {
      throw new Error(
        `direct Turn did not retain one committed runtime admission: ${JSON.stringify(matchingAdmissions)}`
      );
    }
    const writerView = await runView(memberSessionId, "Writer Task created");
    const writerTask = writerView?.tasks?.find(
      (task) => task.subject === writerTaskSubject
    );
    if (!writerTask) {
      throw new Error(
        `frozen-snapshot Writer did not create the durable Task: ${JSON.stringify(writerView?.tasks ?? [])}`
      );
    }
    if (
      writerView?.workState?.openTasks < 1 ||
      !(writerView?.blockers ?? []).some(
        (blocker) =>
          blocker.kind === "openTasks" &&
          blocker.objects?.some((object) => object.id === writerTask.id)
      )
    ) {
      throw new Error(
        `Run View did not expose the Writer Task through canonical typed blockers: ${JSON.stringify({ workState: writerView?.workState, blockers: writerView?.blockers })}`
      );
    }

    const returnButton = await waitForDisplayed(
      '[data-testid="agent-org-end-direct-work-button"]',
      "End direct work button"
    );
    await browser.waitUntil(async () => returnButton.isEnabled(), {
      timeout: RENDER_TIMEOUT_MS,
      interval: 200,
      timeoutMsg:
        "End direct work remained disabled after direct work became terminal",
    });
    await returnButton.click();

    await browser.waitUntil(
      async () => {
        const view = await runView(memberSessionId, "Return cleared");
        const member = view?.members?.find(
          (candidate) => candidate.memberId === memberId
        );
        return member?.intervention == null && member?.activity == null;
      },
      {
        timeout: RENDER_TIMEOUT_MS,
        interval: 200,
        timeoutMsg: `End direct work did not clear receipt ${acceptedReceipt} from current activity`,
      }
    );
    const refreshed = await runView(memberSessionId, "cleared receipt refresh");
    const refreshedMember = refreshed?.members?.find(
      (candidate) => candidate.memberId === memberId
    );
    if (
      refreshedMember?.activity != null ||
      refreshedMember?.intervention != null
    ) {
      throw new Error(
        `cleared receipt reappeared as current activity: ${JSON.stringify(refreshedMember)}`
      );
    }
  });
});
