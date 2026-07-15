/* global describe, before, it, process */
import {
  AGENT_ORG_COORDINATOR_MEMBER_ID,
  AGENT_ORG_TASK_STATUS,
  API_AGENT_TYPE,
  BUILTIN_SDE_AGENT_ID,
  DEFAULT_AGENT_ORG_ID,
  DEFAULT_AGENT_ORG_MEMBER_IDS,
  E2E_REPO_PATH,
  RUN_ID,
  assertCrashRecoveryBannerAbsent,
  assertE2ERepoFixture,
  assertLongTaskRenderedCollapsed,
  assertNoCurrentPlanBuildSurface,
  assertNoFalseFinality,
  assertNoMemberIntervention,
  assertRenderedGroupChatNoQuoteOrUnreadPreview,
  assertRenderedGroupChatToggleIsIdempotent,
  assertRenderedInboxPinBarAbsent,
  clickGroupChatResumeButton,
  clickReturnToWorkAndWaitCleared,
  configureCreatorForAgentOrg,
  configureCreatorForDefaultAgentOrg,
  createLongTaskPrecondition,
  createRenderedStrictTwoMemberAgentOrg,
  executeCreatePlanAsMember,
  getApiAccount,
  invokeE2E,
  openAgentOrgOverviewPanel,
  openRenderedGroupChatView,
  openRenderedSidebarSession,
  parseInboxPayload,
  refreshRenderedAgentOrgOverview,
  removeAgentOrgsByName,
  selectMemberOverrideModel,
  selectPreferredModel,
  selectRenderedAgentOrg,
  selectRenderedDefaultAgentOrg,
  selectRenderedExecMode,
  selectRenderedOrgMemberAgentDefinition,
  sendCoordinatorOrgMessage,
  sendFromRenderedCreator,
  sendRenderedChatPrompt,
  sendRenderedGroupChatMentionPrompt,
  unwrap,
  waitForActiveSessionExecMode,
  waitForAgentOrgByName,
  waitForAgentOrgRunView,
  waitForAgentOrgRunViewByOrg,
  waitForApp,
  waitForCoordinatorRuntimeStatus,
  waitForGroupChatPausedBanner,
  waitForGroupChatPendingTarget,
  waitForInboxRow,
  waitForInboxRowRead,
  waitForIntervention,
  waitForMemberPostMessageActivity,
  waitForPlanApprovalRequest,
  waitForPromptDump,
  waitForRenderedAssistantReply,
  waitForRenderedGroupChatActive,
  waitForRenderedGroupChatMessage,
  waitForRenderedGroupChatUserTurn,
  waitForRenderedInterventionPin,
  waitForRenderedReleasedTask,
  waitForSessionAggregateRow,
  waitForSessionOrgRuntimeSnapshot,
} from "../../support/core/agentOrgUiDriver.mjs";

describe("Agent Org settings and topology rendered UI", () => {
  before(async () => {
    assertE2ERepoFixture();
    await waitForApp();
  });

  it("creates strict Agent Org structure in settings and launches that persisted runtime topology", async () => {
    const account = await getApiAccount();
    const model = selectPreferredModel(account);
    const orgName = `E2E Strict Org ${RUN_ID}`;
    const leadName = `E2E Lead ${RUN_ID}`;
    const childName = `E2E Child ${RUN_ID}`;
    await removeAgentOrgsByName(orgName);

    const org = await createRenderedStrictTwoMemberAgentOrg({
      orgName,
      leadName,
      childName,
    });
    if (typeof org.id !== "string") {
      throw new Error(
        `Created org did not expose an id: ${JSON.stringify(org)}`
      );
    }

    await configureCreatorForAgentOrg({ account, model, agentOrgId: org.id });
    await selectRenderedAgentOrg(org.id);
    const launchPrompt = `E2E true positive custom strict Agent Org topology ${RUN_ID}. Reply briefly.`;
    const sessionId = await sendFromRenderedCreator(launchPrompt);
    if (!sessionId) {
      throw new Error(
        "Custom strict Agent Org launch did not create a session id"
      );
    }
    await waitForRenderedAssistantReply("custom strict Agent Org launch");

    await waitForAgentOrgRunView(
      sessionId,
      (view) => {
        const members = view?.members ?? [];
        const lead = members.find((member) => member.name === leadName);
        const child = members.find((member) => member.name === childName);
        return Boolean(
          view?.currentMemberId === AGENT_ORG_COORDINATOR_MEMBER_ID &&
          view?.context?.runId &&
          lead?.memberId &&
          child?.memberId &&
          lead.agentId === BUILTIN_SDE_AGENT_ID &&
          child.agentId === BUILTIN_SDE_AGENT_ID &&
          !lead.parentMemberId &&
          child.parentMemberId === lead.memberId &&
          lead.sessionRuntime?.sessionId &&
          child.sessionRuntime?.sessionId
        );
      },
      "custom strict Agent Org persisted members consumed by runtime"
    );
  });

  it("applies member launch overrides once and persists them only when requested", async () => {
    const account = await getApiAccount();
    const model = selectPreferredModel(account);
    const overrideModel = selectMemberOverrideModel(account, model);
    const orgName = `E2E Member Override Org ${RUN_ID}`;
    const leadName = `E2E Override Lead ${RUN_ID}`;
    const childName = `E2E Override Child ${RUN_ID}`;
    await removeAgentOrgsByName(orgName);

    const org = await createRenderedStrictTwoMemberAgentOrg({
      orgName,
      leadName,
      childName,
    });
    const lead = (org.children ?? []).find(
      (member) => member.name === leadName
    );
    const child = lead?.children?.find((member) => member.name === childName);
    if (!child?.id) {
      throw new Error(
        `Override test could not resolve child member: ${JSON.stringify(org)}`
      );
    }

    await configureCreatorForAgentOrg({ account, model, agentOrgId: org.id });
    await selectRenderedAgentOrg(org.id);
    const launchOnlyDraft = {
      agentOrgMemberOverrides: {
        [child.id]: {
          runtimeConfig: {
            keySource: "own_key",
            accountId: account.id,
            model: overrideModel,
            selectedSourceLabel: account.name ?? account.id,
            selectedSourceModelType: account.agent_type,
          },
        },
      },
      applyAgentOrgMemberOverridesForFuture: false,
    };
    unwrap(
      await invokeE2E("setAgentOrgMemberDraftConfig", launchOnlyDraft, org.id),
      "set launch-only member override draft"
    );

    const launchOnlyResult = unwrap(
      await invokeE2E("launchSession", {
        category: "rust_agent",
        content: `E2E launch-only member override ${RUN_ID}. Reply briefly.`,
        workspacePath: E2E_REPO_PATH,
        keySource: "own_key",
        accountId: account.id,
        model,
        agentDefinitionId: BUILTIN_SDE_AGENT_ID,
        agentOrgId: org.id,
        agentOrgMemberOverrides: launchOnlyDraft.agentOrgMemberOverrides,
        applyAgentOrgMemberOverridesForFuture: false,
        background: false,
      }),
      "launchSession launch-only member override"
    ).result;
    const launchOnlySessionId =
      launchOnlyResult?.sessionId ?? launchOnlyResult?.session_id;
    if (!launchOnlySessionId) {
      throw new Error(
        `Launch-only member override did not create a session: ${JSON.stringify(launchOnlyResult)}`
      );
    }
    const launchOnlyRunState = await waitForAgentOrgRunViewByOrg(
      org.id,
      (view) => {
        const overriddenMember = (view?.members ?? []).find(
          (member) => member.memberId === child.id
        );
        return Boolean(overriddenMember?.sessionRuntime?.sessionId);
      },
      "launch-only member override materialized"
    );
    const launchOnlyChildRuntime = (
      launchOnlyRunState?.view?.members ?? []
    ).find((member) => member.memberId === child.id)?.sessionRuntime;
    const launchOnlyChildSessionId = launchOnlyChildRuntime?.sessionId;
    if (!launchOnlyChildSessionId) {
      throw new Error(
        `Launch-only override did not materialize child session: ${JSON.stringify(launchOnlyRunState)}`
      );
    }
    await waitForSessionAggregateRow(
      launchOnlyChildSessionId,
      (session) =>
        session.model === overrideModel && session.accountId === account.id,
      "launch-only child model/account override"
    );

    const afterLaunchOnlyOrg = unwrap(
      await invokeE2E("listAgentOrgs"),
      "listAgentOrgs after launch-only override"
    ).orgs.find((candidate) => candidate?.id === org.id);
    const afterLaunchOnlyChild =
      afterLaunchOnlyOrg?.children?.[0]?.children?.find(
        (member) => member.id === child.id
      );
    if (afterLaunchOnlyChild?.runtimeConfig) {
      throw new Error(
        `Launch-only override persisted unexpectedly: ${JSON.stringify(afterLaunchOnlyChild)}`
      );
    }

    await configureCreatorForAgentOrg({ account, model, agentOrgId: org.id });
    await selectRenderedAgentOrg(org.id);
    const persistedDraft = {
      ...launchOnlyDraft,
      applyAgentOrgMemberOverridesForFuture: true,
    };
    unwrap(
      await invokeE2E("setAgentOrgMemberDraftConfig", persistedDraft, org.id),
      "set persisted member override draft"
    );

    const persistedResult = unwrap(
      await invokeE2E("launchSession", {
        category: "rust_agent",
        content: `E2E persisted member override ${RUN_ID}. Reply briefly.`,
        workspacePath: E2E_REPO_PATH,
        keySource: "own_key",
        accountId: account.id,
        model,
        agentDefinitionId: BUILTIN_SDE_AGENT_ID,
        agentOrgId: org.id,
        agentOrgMemberOverrides: persistedDraft.agentOrgMemberOverrides,
        applyAgentOrgMemberOverridesForFuture: true,
        background: false,
      }),
      "launchSession persisted member override"
    ).result;
    const persistedSessionId =
      persistedResult?.sessionId ?? persistedResult?.session_id;
    if (!persistedSessionId) {
      throw new Error(
        `Persisted member override did not create a session: ${JSON.stringify(persistedResult)}`
      );
    }
    const persistedRunState = await waitForAgentOrgRunViewByOrg(
      org.id,
      (view) => {
        const overriddenMember = (view?.members ?? []).find(
          (member) => member.memberId === child.id
        );
        return Boolean(overriddenMember?.sessionRuntime?.sessionId);
      },
      "persisted member override materialized"
    );
    const persistedChildRuntime = (persistedRunState?.view?.members ?? []).find(
      (member) => member.memberId === child.id
    )?.sessionRuntime;
    const persistedChildSessionId = persistedChildRuntime?.sessionId;
    if (!persistedChildSessionId) {
      throw new Error(
        `Persisted override did not materialize child session: ${JSON.stringify(persistedRunState)}`
      );
    }
    await waitForSessionAggregateRow(
      persistedChildSessionId,
      (session) =>
        session.model === overrideModel && session.accountId === account.id,
      "persisted child model/account override"
    );

    const persistedOrg = unwrap(
      await invokeE2E("listAgentOrgs"),
      "listAgentOrgs after persisted override"
    ).orgs.find((candidate) => candidate?.id === org.id);
    const persistedChild = persistedOrg?.children?.[0]?.children?.find(
      (member) => member.id === child.id
    );
    if (persistedChild?.runtimeConfig?.model !== overrideModel) {
      throw new Error(
        `Persisted override missing from org definition: ${JSON.stringify(persistedChild)}`
      );
    }
    if (persistedChild.runtimeConfig.accountId !== account.id) {
      throw new Error(
        `Persisted override account mismatch: ${JSON.stringify(persistedChild)}`
      );
    }
  });

  it("applies a member AgentDefinition override through the rendered Session Creator members panel", async () => {
    const account = await getApiAccount();
    const model = selectPreferredModel(account);
    const orgName = `E2E Rendered Member Agent Override Org ${RUN_ID}`;
    const leadName = `E2E Rendered Override Lead ${RUN_ID}`;
    const childName = `E2E Rendered Override Child ${RUN_ID}`;
    const overrideAgentId = `e2e-member-agent-override-${RUN_ID}`;
    const overrideAgentName = `E2E Member Override Agent ${RUN_ID}`;
    await removeAgentOrgsByName(orgName);

    const definition = {
      id: overrideAgentId,
      name: overrideAgentName,
      description:
        "Temporary custom Agent for rendered Agent Org member override coverage.",
      builtIn: false,
      tier: "primary",
      inheritsFrom: BUILTIN_SDE_AGENT_ID,
      capabilities: { coding: { modeSwitch: true } },
      delegationConfig: { delegatable: true, contextBuilders: [] },
      sessionModel: {
        mode: "singleton",
        processingLock: true,
        maxIterations: 3,
      },
      agentPolicy: {
        autonomy: "full",
        workspaceOnly: true,
        blockedCommands: [],
        riskRules: { medium: [], high: [] },
      },
      tools: { userAllowedTools: [], excludedTools: [] },
      skillsConfig: { enabled: true, include: [], exclude: [], sourceDirs: [] },
    };

    try {
      const existingDefs = unwrap(
        await invokeE2E("listAgentDefs"),
        "listAgentDefs before rendered member override"
      ).defs;
      if (existingDefs.some((candidate) => candidate?.id === overrideAgentId)) {
        await invokeE2E("removeAgentDef", overrideAgentId);
      }
      unwrap(
        await invokeE2E("addAgentDef", definition),
        "add rendered member override AgentDefinition"
      );
      unwrap(
        await invokeE2E("refreshAgentDefs"),
        "refresh rendered member override AgentDefinition"
      );

      const org = await createRenderedStrictTwoMemberAgentOrg({
        orgName,
        leadName,
        childName,
      });
      const lead = (org.children ?? []).find(
        (member) => member.name === leadName
      );
      const child = lead?.children?.find((member) => member.name === childName);
      if (!child?.id) {
        throw new Error(
          `Rendered member override could not resolve child: ${JSON.stringify(org)}`
        );
      }

      await configureCreatorForAgentOrg({ account, model, agentOrgId: org.id });
      await selectRenderedAgentOrg(org.id);
      await selectRenderedOrgMemberAgentDefinition({
        memberId: child.id,
        agentDefinitionId: overrideAgentId,
        expectedText: overrideAgentName,
        label: "rendered member AgentDefinition override",
      });

      const sessionId = await sendFromRenderedCreator(
        `E2E rendered member AgentDefinition override ${RUN_ID}. Reply briefly.`
      );
      if (!sessionId) {
        throw new Error(
          "Rendered member AgentDefinition override did not create a session id"
        );
      }

      const runState = await waitForAgentOrgRunViewByOrg(
        org.id,
        (view) => {
          const overriddenMember = (view?.members ?? []).find(
            (member) => member.memberId === child.id
          );
          return (
            overriddenMember?.agentId === overrideAgentId &&
            Boolean(overriddenMember?.sessionRuntime?.sessionId)
          );
        },
        "rendered member AgentDefinition override materialized"
      );
      const overriddenRuntime = (runState?.view?.members ?? []).find(
        (member) => member.memberId === child.id
      )?.sessionRuntime;
      if (!overriddenRuntime?.sessionId) {
        throw new Error(
          `Rendered member override did not materialize runtime session: ${JSON.stringify(runState)}`
        );
      }
      await waitForSessionAggregateRow(
        overriddenRuntime.sessionId,
        (session) =>
          session.agentDefinitionId === overrideAgentId &&
          session.model === model &&
          session.accountId === account.id,
        "rendered member AgentDefinition override child session metadata"
      );
    } finally {
      await invokeE2E("removeAgentDef", overrideAgentId);
      await removeAgentOrgsByName(orgName);
    }
  });
});
