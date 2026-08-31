/**
 * Fork-relay completion layer (design §16.11, "fork & continue").
 *
 * `collabSyncEngineHelpers.forkSession` lands a teammate's replayable history
 * as a writable local session (fresh `agentsession-*` id, `forkedFrom`
 * provenance, events durably cached). That record alone is not yet a working
 * relay — two gaps remain, both closed here:
 *
 * 1. **Dispatchability + durability.** The Rust side has no builtin prefix
 *    mapping for `agentsession-*` (agent-core `BUILTIN_PREFIX_REGISTRY` knows
 *    only `osagent-`/`sdeagent-`/`wingman-`), so the lazy `init_session` on
 *    the first `agent_send_message` can resolve an agent definition ONLY from
 *    a persisted `agent_sessions.agent_definition_id`. Without a backend row
 *    the first send fails ("no persisted agent_definition_id and no builtin
 *    prefix mapping"), and the TS-only session row is wiped by the next full
 *    `loadSessions()` list replace. `forkTeammateSession` therefore registers
 *    a real `agent_sessions` row via the existing `agent_save_session`
 *    command (definition `builtin:sde`, the fork's workspace path) — making
 *    the fork runnable and list-refresh-proof with zero Rust changes.
 *
 * 2. **LLM context continuity.** The agent's conversation context is rebuilt
 *    from `agent_messages` (`load_llm_history`), NOT from the display event
 *    cache the fork inherited — a fork starts with an empty message table, so
 *    without help the agent is blind to the teammate's context. There is no
 *    Tauri command to seed `agent_messages`, so the handoff rides the FIRST
 *    message instead: `buildPendingForkHandoff` wraps the user's first send
 *    with a bounded digest of the inherited events (same technique as the
 *    imported-history handoff in `externalHistoryFork.ts`), while `displayText`
 *    keeps the user's own words in the transcript. The handoff is one-shot
 *    and durable across restarts (localStorage registry), consumed by
 *    `markForkHandoffConsumed` only after the send succeeds.
 *
 * The registry doubles as durable provenance: backend list reloads rebuild
 * `Session` rows from Rust (which does not know `forkedFrom`), so
 * `getSessionForkedFrom` falls back to the registry when the row field is
 * gone — "⑂ taken over from @owner" survives reloads.
 *
 * This module is the stable import path; the pieces live in flat siblings:
 * - `forkRelayRegistry`      durable provenance + handoff marker storage
 * - `forkWorkspaceResolution` local-checkout resolver + setup/checkout dialogs
 * - `forkHandoffPrompt`      the bounded first-send digest
 */
import { deleteSession, saveSession } from "@src/api/tauri/agent";
import type { SessionMeta } from "@src/api/tauri/agent";
import Message from "@src/components/Message";
import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import {
  org2CloudAccessSettingsAtom,
  withCloudSessionMode,
} from "@src/features/Org2Cloud/org2CloudAccessSettings";
import { org2CloudOrgsAtom } from "@src/features/Org2Cloud/org2CloudOrgsAtom";
import i18n from "@src/i18n";
import { sessionsAtom } from "@src/store/session/sessionAtom/atoms";
import { removeSession } from "@src/store/session/sessionAtom/mutations";
import { persistSessions } from "@src/store/session/sessionAtom/persistence";
import type { Session } from "@src/store/session/sessionAtom/types";
import {
  getInstrumentedStore,
  isStoreInitialized,
} from "@src/util/core/state/instrumentedStore";

import type {
  ForkSessionResult,
  RemoteSessionFetchOptions,
} from "./engine/collabSyncEngineHelpers";
import { forkSession } from "./engine/collabSyncEngineHelpers";
import { MAX_HANDOFF_ITEMS, MAX_ITEM_TEXT_LENGTH } from "./forkHandoffPrompt";
import {
  FORK_RELAY_STORAGE_KEY,
  MAX_REGISTRY_ENTRIES,
  writeRegistryEntry,
} from "./forkRelayRegistry";
import {
  clearForkSetupMemory,
  loadForkSetupMemory,
  saveForkSetupMemory,
} from "./forkSetupMemory";
import { ForkOperationError } from "./forkSnapshotIntegrity";
import type { ForkTeammateSessionOptions } from "./forkWorkspaceResolution";
import {
  pickForkSessionSetup,
  pickMatchingCheckout,
  resolveForkWorkspacePath,
} from "./forkWorkspaceResolution";
import {
  cloudOrgToken,
  sessionOrgTagsAtom,
  withTag,
} from "./sessionOrgTagsAtom";

export type { ForkSessionResult, RemoteSessionFetchOptions };

export {
  createSessionForkedFromResolver,
  getSessionForkedFrom,
  markForkHandoffConsumed,
  removeForkRelayEntry,
} from "./forkRelayRegistry";

export {
  ForkCancelledError,
  requestForkSessionSetup,
  resolveForkWorkspacePath,
} from "./forkWorkspaceResolution";
export type {
  ForkSessionSetupSource,
  ForkTeammateSessionOptions,
} from "./forkWorkspaceResolution";

export {
  buildForkHandoffPrompt,
  buildPendingForkHandoff,
} from "./forkHandoffPrompt";
export type { ForkHandoffContent } from "./forkHandoffPrompt";

// ============================================================================
// The full fork action (engine fork + backend registration + relay arming)
// ============================================================================

/**
 * THE fork-and-continue action for the collab panel (design §16.11). Wraps
 * the engine-level `forkSession` (which lands the events + TS session record)
 * and completes the relay:
 *
 * 1. resolves a LOCAL workspace for the fork (see
 *    `resolveForkWorkspacePath`) — never the owner's absolute path — unless
 *    the caller pre-decided one via the `workspaceRepoPath` override;
 * 2. registers the real `agent_sessions` backend row (`agent_save_session`)
 *    so the fork is dispatchable (definition resolution) and survives full
 *    session-list reloads;
 * 3. records durable provenance and arms the one-shot first-send handoff;
 * 4. CLOUD orgs only: auto-tags the fork back to the source cloud org
 *    (`sessionOrgTagsAtom`), so the forker's continuation pushes back to
 *    the org regardless of whether their local repo resolves into the
 *    org's repo scopes — closing the "owner never sees the continuation"
 *    relay gap. (Tagged pushes bypass scope in Org2CloudSyncEngine; the
 *    access ladder still applies — an effective-off fork pushes at
 *    metadata_only.) Self-hosted orgs are deliberately NOT tagged: the
 *    self-hosted CollabSyncEngine does not consume org tags for push
 *    eligibility, so a tag would be a silent no-op — there the residual
 *    remains that a continuation only reaches the org when the forker's
 *    local repo matches the org's repo scopes.
 *
 * Returns null exactly when `forkSession` does (no published segments);
 * THROWS when the backend registration fails — the fork would look fine in
 * the list but break on the first send, so the caller must surface it as a
 * failed (retryable) fork instead.
 */
export async function forkTeammateSession(
  options: ForkTeammateSessionOptions
): Promise<ForkSessionResult | null> {
  // KEY-PRESENCE check, not a `??` default: an explicitly-passed
  // undefined/null means "fork WITHOUT a workspace"; only a fully absent key
  // falls back to the resolver. The runner's pre-flight workspace confirm
  // depends on this distinction (its dialog choices map 1:1 onto the two
  // present-key shapes).
  let hasWorkspaceOverride = "workspaceRepoPath" in options;
  let workspaceRepoPath: string | null;
  let execution = options.execution;
  let usedRememberedSetup = false;
  if (options.promptForExecution) {
    // Continuation setup is remembered per repo scope: the dialog appears
    // the first time (and again after a failed remembered run), every later
    // continuation reuses the confirmed choice silently.
    const remembered = loadForkSetupMemory(options.remoteSession.repoScopeKey);
    const setup =
      remembered ?? (await pickForkSessionSetup(options.remoteSession));
    if (remembered) {
      usedRememberedSetup = true;
    } else {
      saveForkSetupMemory(options.remoteSession.repoScopeKey, setup);
    }
    workspaceRepoPath = setup.workspaceRepoPath;
    execution = setup.execution;
    hasWorkspaceOverride = true;
  } else if (hasWorkspaceOverride) {
    workspaceRepoPath = options.workspaceRepoPath ?? null;
  } else if (options.remoteSession.repoScopeKey) {
    // A repo-scoped fork is a governance decision, not merely a path
    // fallback. Always make the user explicitly choose the local checkout
    // that will own the continuation, even when the resolver already knows a
    // matching repo. The picker filters and re-verifies remotes, so SEND can
    // never silently infer fork eligibility from stale repo/session state.
    workspaceRepoPath = await pickMatchingCheckout(
      options.remoteSession.repoScopeKey,
      options.remoteSession.title
    );
  } else {
    workspaceRepoPath = await resolveForkWorkspacePath(options.remoteSession);
  }
  // A headless caller must provide the same explicit local execution choice
  // as the setup dialog. Never resurrect the old implicit builtin:sde path.
  if (!execution?.agentDefinitionId) {
    throw new ForkOperationError(
      "agent_unavailable",
      options.remoteSession.sourceSessionId,
      "No local agent was selected for this fork"
    );
  }
  const { promptForExecution: _prompt, ...fetchOptions } = options;
  let result: ForkSessionResult | null;
  try {
    result = await forkSession({
      ...fetchOptions,
      workspaceRepoPath,
      execution,
    });
  } catch (error) {
    if (!usedRememberedSetup || !(error instanceof ForkOperationError)) {
      throw error;
    }
    // The remembered setup went stale (checkout moved, account or model
    // removed). Drop it and fall back to the dialog once.
    clearForkSetupMemory(options.remoteSession.repoScopeKey);
    const setup = await pickForkSessionSetup(options.remoteSession);
    saveForkSetupMemory(options.remoteSession.repoScopeKey, setup);
    workspaceRepoPath = setup.workspaceRepoPath;
    execution = setup.execution;
    if (!execution?.agentDefinitionId) throw error;
    result = await forkSession({
      ...fetchOptions,
      workspaceRepoPath,
      execution,
    });
  }
  if (!result) return null;
  if (usedRememberedSetup) {
    Message.info(
      i18n.t("navigation:collaboration.session.forkSetupReused", {
        model: execution.model ?? execution.agentDefinitionId,
      })
    );
  }

  if (result.modelFallback) {
    const { inheritedModel, fallbackModel } = result.modelFallback;
    Message.info(
      fallbackModel
        ? i18n.t("navigation:collaboration.session.forkModelFallback", {
            model: inheritedModel,
            fallback: fallbackModel,
          })
        : i18n.t("navigation:collaboration.session.forkModelUnavailable", {
            model: inheritedModel,
          })
    );
  }

  const { orgId, remoteSession } = options;
  const now = new Date().toISOString();

  // UnifiedSessionRecord requires `session_type`; SessionMeta's zod input
  // schema passes unknown keys through (catchall), so the extra field
  // reaches the Rust record intact. "sde" = coding session (session_type
  // module in agent-core), matching the builtin:sde definition below.
  const backendRecord = {
    sessionId: result.localSessionId,
    name: result.name,
    status: "completed",
    createdAt: now,
    updatedAt: now,
    workspacePath: workspaceRepoPath ?? undefined,
    model: result.model,
    accountId: result.accountId,
    // Preserve the collaboration filing in Rust too. Without this, the
    // backend defaults the durable row to `personal-org`; the next
    // loadSessions() then moves a cloud fork out of its Team sidebar even
    // though the optimistic TS row and cloud tag still point at the source
    // org. Guest-share forks deliberately remain Personal.
    orgId: options.shareToken ? undefined : orgId,
    // agentsession-* has no builtin prefix mapping in agent-core, so the
    // explicitly confirmed LOCAL definition id is the lazy-init authority.
    // The source's wire id is only a picker hint and is never trusted here.
    agentDefinitionId: execution.agentDefinitionId,
    sessionType: "sde",
  } as SessionMeta;
  try {
    await saveSession(backendRecord);
  } catch (error) {
    // The engine writes inherited events + the optimistic TS row first. A
    // failed backend registration would otherwise leave a visible fork that
    // can never dispatch. Roll every local artifact back before surfacing the
    // retryable failure; backend delete is defensive if save failed late.
    await deleteSession(result.localSessionId).catch(() => undefined);
    await eventStoreProxy.clear(result.localSessionId).catch(() => undefined);
    removeSession(result.localSessionId);
    if (isStoreInitialized()) {
      const store = getInstrumentedStore();
      persistSessions(store.get(sessionsAtom) as Session[]);
    }
    throw new ForkOperationError(
      "backend_registration",
      remoteSession.sourceSessionId,
      "Failed to register the forked session backend",
      error
    );
  }

  writeRegistryEntry(result.localSessionId, {
    forkedFrom: {
      orgId,
      sourceSessionId: remoteSession.sourceSessionId,
      ownerMemberId: remoteSession.ownerMemberId,
      ownerDisplayName: remoteSession.ownerDisplayName,
      atCount: result.eventCount,
      forkedAt: now,
      // Root inheritance MUST survive here too: pushes restore lineage from
      // THIS registry entry (the Session row's forkedFrom is stripped by the
      // first loadSessions()), so omitting rootSessionId degrades the wire
      // root to the direct parent and splinters the fork thread.
      rootSessionId:
        remoteSession.forkedFrom?.rootSessionId ??
        remoteSession.sourceSessionId,
    },
    handoffPending: true,
  });

  if (isStoreInitialized()) {
    const store = getInstrumentedStore();
    // Auto-tag CLOUD forks back to their source org (see docblock item 4).
    // Cloud-vs-self-hosted follows from org id membership alone — the two
    // id namespaces never merge (org2CloudOrgsAtom isolation note).
    const isCloudOrg = store
      .get(org2CloudOrgsAtom)
      .some((org) => org.orgId === orgId);
    if (isCloudOrg && !options.shareToken) {
      store.set(sessionOrgTagsAtom, (current) =>
        withTag(current, result.localSessionId, cloudOrgToken(orgId))
      );
      // Inherit the SOURCE's sharing level as the fork's explicit per-session
      // intent. Without it, a fork in a floor=off org has no ladder entry and
      // silently floors to metadata_only — teammates see the fork row but can
      // never open its replay, and nobody errors (the "defaults silently
      // degrading shares" escape class). The stamp is just the default the
      // per-session dialog would show; the user can change it there.
      if (remoteSession.accessMode) {
        store.set(org2CloudAccessSettingsAtom, (current) =>
          withCloudSessionMode(
            current,
            orgId,
            result.localSessionId,
            remoteSession.accessMode ?? null
          )
        );
      }
    }
    if (workspaceRepoPath === null && !hasWorkspaceOverride) {
      // Non-blocking: the fork opened fine, it just has no workspace until
      // the user clones the repo / picks one manually. Suppressed for
      // explicit overrides — a caller that PASSED "no workspace" (the
      // runner's confirmed dialog choice) already knows.
      Message.info(
        i18n.t("navigation:collaboration.session.forkNoLocalCheckout")
      );
    }
  }

  return result;
}

export const __FORK_RELAY_INTERNALS = {
  FORK_RELAY_STORAGE_KEY,
  MAX_REGISTRY_ENTRIES,
  MAX_HANDOFF_ITEMS,
  MAX_ITEM_TEXT_LENGTH,
};
