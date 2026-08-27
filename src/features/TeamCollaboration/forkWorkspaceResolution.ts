/**
 * Where a fork will RUN: the local-checkout resolver, the shared continuation
 * setup dialog, and the mandatory checkout picker.
 *
 * Every fork entry point (cloud teammate replays and local
 * Codex/Claude/Cursor histories alike) goes through these so no source adapter
 * invents its own workspace/account/model fallback chain.
 */
import { exists } from "@tauri-apps/plugin-fs";

import Message from "@src/components/Message";
import i18n from "@src/i18n";
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";
import { reposAtom } from "@src/store/repo";
import { sessionsAtom } from "@src/store/session/sessionAtom/atoms";
import type { Session } from "@src/store/session/sessionAtom/types";
import {
  getInstrumentedStore,
  isStoreInitialized,
} from "@src/util/core/state/instrumentedStore";
import { toFsPluginPath } from "@src/util/file/pathUtils";

import { normalizeRepoScopeKey } from "./collabSyncUtils";
import { forkCheckoutRequestAtom } from "./components/ForkCheckoutPickerDialog";
import {
  type ForkSessionSetupSelection,
  forkSessionSetupRequestAtom,
} from "./components/ForkSessionSetupDialog";
import type {
  ForkExecutionSelection,
  RemoteSessionFetchOptions,
} from "./engine/collabSyncEngineHelpers";
import {
  resolveLocalCheckoutForScopeKey,
  resolveMatchingOrgRepoScope,
  resolveShareableScopeKeys,
} from "./repoScopeResolver";

/**
 * Fork workspace resolution (fork-relay repoPath fix): the remote record's
 * `repoPath` is the OWNER's absolute path — on this machine it usually does
 * not exist, and an agent dispatched into it would run in a bogus
 * workspace. Resolve a LOCAL checkout instead, via the SAME resolver chain
 * scope-matching uses (`resolveShareableScopeKey` under
 * `resolveLocalCheckoutForScopeKey`), probing every locally-known repo path
 * (repo store + local sessions' workspaces) against the record's
 * cross-machine `repoScopeKey`. Fallback: when the owner's path IS one of
 * our known local paths (same-machine fork, or a repo with no git remote),
 * keep it. Returns null when nothing matches — the fork then opens WITHOUT
 * a workspace (plus a non-blocking hint) rather than with a dead foreign
 * path.
 *
 * Exported so every fork entry point shares the same workspace resolver.
 */
export async function resolveForkWorkspacePath(
  remoteSession: RemoteTeammateSessionMetadata
): Promise<string | null> {
  // No store yet (early boot edge) ⇒ no candidates to match against.
  if (!isStoreInitialized()) return null;
  const store = getInstrumentedStore();
  const candidates: string[] = [];
  for (const repo of store.get(reposAtom)) {
    if (repo.path) candidates.push(repo.path);
  }
  for (const session of store.get(sessionsAtom) as Session[]) {
    const candidate = session.repoRootPath ?? session.repoPath;
    if (candidate) candidates.push(candidate);
  }

  // Repo/session atoms may retain another machine's absolute path after a
  // cloud import. Only paths that exist on THIS machine may participate in
  // scope resolution or the same-machine fallback.
  const existingCandidates: string[] = [];
  const seenCandidates = new Set<string>();
  for (const candidate of candidates) {
    const normalized = normalizeRepoScopeKey(candidate);
    if (!normalized || seenCandidates.has(normalized)) continue;
    seenCandidates.add(normalized);
    try {
      if (await exists(toFsPluginPath(candidate))) {
        existingCandidates.push(candidate);
      }
    } catch {
      // Invalid/stale paths fail closed; a later valid checkout can still win.
    }
  }

  const byScopeKey = await resolveLocalCheckoutForScopeKey(
    remoteSession.repoScopeKey,
    existingCandidates
  );
  if (byScopeKey) return byScopeKey;

  // Same-machine fallback: exact path identity against our known local
  // paths proves the checkout exists here even when there is no scope key
  // to match (repo without a git remote) or remote resolution hiccuped.
  if (remoteSession.repoPath) {
    const normalizedOwnerPath = normalizeRepoScopeKey(remoteSession.repoPath);
    if (
      normalizedOwnerPath &&
      existingCandidates.some(
        (candidate) => normalizeRepoScopeKey(candidate) === normalizedOwnerPath
      )
    ) {
      return normalizedOwnerPath;
    }
  }
  return null;
}

export interface ForkTeammateSessionOptions extends RemoteSessionFetchOptions {
  /** User-initiated forks open one setup dialog before any remote fetch. */
  promptForExecution?: boolean;
  /** Pre-resolved execution choice for headless/programmatic callers. */
  execution?: ForkExecutionSelection;
  /**
   * Workspace override with KEY-PRESENCE semantics (agent-pickup design §4),
   * mirroring the engine's `ForkSessionOptions.workspaceRepoPath`:
   * - key ABSENT ⇒ resolve a local checkout via `resolveForkWorkspacePath`
   *   (the default relay behavior, unchanged);
   * - key present with a path ⇒ use it verbatim (the runner dialog's
   *   pick-a-folder choice — the user already confirmed it);
   * - key present with undefined/null ⇒ fork WITHOUT a workspace (the
   *   runner's explicit "run without workspace" choice — no resolver probe
   *   and no "no local checkout" hint, since the user already decided).
   */
  workspaceRepoPath?: string | null;
}

export interface ForkSessionSetupSource {
  sourceTitle: string;
  sourceScopeKey?: string;
  sourceModel?: string;
  sourceAgentDisplayName?: string;
  sourceAgentDefinitionId?: string;
}

/**
 * Thrown when the user dismisses the mandatory pick-your-checkout dialog (or
 * picks a folder that is not a checkout of the source repo). Callers treat it
 * as a quiet cancel — no "fork failed" toast.
 */
export class ForkCancelledError extends Error {
  constructor() {
    super("fork cancelled: no matching local checkout selected");
    this.name = "ForkCancelledError";
  }
}

/**
 * Shared local execution picker for every read-only history continuation —
 * cloud teammate replays and local Codex/Claude/Cursor histories alike.
 * Keeping the prompt + remote verification here prevents each source adapter
 * from inventing its own workspace/account/model fallback chain.
 */
export async function requestForkSessionSetup(
  source: ForkSessionSetupSource
): Promise<ForkSessionSetupSelection> {
  if (!isStoreInitialized()) throw new ForkCancelledError();
  const store = getInstrumentedStore();
  const selected = await new Promise<ForkSessionSetupSelection | null>(
    (resolve) => {
      store.set(forkSessionSetupRequestAtom, {
        sourceTitle: source.sourceTitle,
        sourceScopeKey: source.sourceScopeKey,
        sourceModel: source.sourceModel,
        sourceAgentDisplayName: source.sourceAgentDisplayName,
        sourceAgentDefinitionId: source.sourceAgentDefinitionId,
        resolve,
      });
    }
  );
  if (!selected) throw new ForkCancelledError();
  if (source.sourceScopeKey) {
    if (!selected.workspaceRepoPath) throw new ForkCancelledError();
    const normalizedKey = normalizeRepoScopeKey(source.sourceScopeKey);
    const keys = await resolveShareableScopeKeys(selected.workspaceRepoPath);
    const matchingScope = await resolveMatchingOrgRepoScope(keys, [
      normalizedKey,
    ]);
    if (!matchingScope) {
      Message.error(
        i18n.t("navigation:collaboration.session.forkCheckoutMismatch", {
          repo: source.sourceScopeKey,
          session: source.sourceTitle,
        })
      );
      throw new ForkCancelledError();
    }
  }
  return selected;
}

export async function pickForkSessionSetup(
  remoteSession: RemoteTeammateSessionMetadata
): Promise<ForkSessionSetupSelection> {
  return requestForkSessionSetup({
    sourceTitle: remoteSession.title,
    sourceScopeKey: remoteSession.repoScopeKey,
    sourceModel: remoteSession.model,
    sourceAgentDisplayName: remoteSession.agentDisplayName,
    sourceAgentDefinitionId: remoteSession.agentDefinitionId,
  });
}

/**
 * Mandatory checkout selection (strict scope governance): a fork continues
 * the SOURCE repo's work and can only sync back to the org from a local
 * checkout of that repo — a workspace-less fork would be permanently
 * unable to push (scope resolution yields nothing) and the owner would
 * never see the continuation. So when the resolver finds no checkout, open
 * the IN-APP ForkCheckoutPickerDialog (workspace repo list; only rows whose
 * remotes match the source repo are selectable) and VERIFY the pick's git
 * remotes before proceeding. Cancel / mismatch aborts the fork
 * (ForkCancelledError).
 */
export async function pickMatchingCheckout(
  sourceScopeKey: string,
  sourceTitle: string
): Promise<string> {
  if (!isStoreInitialized()) throw new ForkCancelledError();
  const store = getInstrumentedStore();
  const selected = await new Promise<string | null>((resolve) => {
    store.set(forkCheckoutRequestAtom, {
      sourceScopeKey,
      sourceTitle,
      resolve,
    });
  });
  if (!selected) {
    throw new ForkCancelledError();
  }
  // Defense-in-depth: re-verify the picked checkout's remotes really include
  // the source repo (the dialog already filters, but the repo may have been
  // re-pointed since its cache entry).
  const normalizedKey = normalizeRepoScopeKey(sourceScopeKey);
  const keys = await resolveShareableScopeKeys(selected);
  const matchingScope = await resolveMatchingOrgRepoScope(keys, [
    normalizedKey,
  ]);
  if (!matchingScope) {
    Message.error(
      i18n.t("navigation:collaboration.session.forkCheckoutMismatch", {
        repo: sourceScopeKey,
        session: sourceTitle,
      })
    );
    throw new ForkCancelledError();
  }
  return selected;
}
