import { invoke } from "@tauri-apps/api/core";

import { rpc } from "@src/api/tauri/rpc";
import type {
  CliAgentType,
  ModelType,
} from "@src/api/tauri/rpc/schemas/validation";
import { KEY_SOURCE } from "@src/api/tauri/session";
import { formatAgentType } from "@src/assets/providers";
import {
  agentOrgMemberDraftConfigAtom,
  agentOrgMemberDraftConfigByOrgAtom,
} from "@src/engines/SessionCore/hooks/session/useSessionCreator/useAdvancedConfig";
import {
  repoPathAtom,
  repositoryIdAtom,
  repositoryNameAtom,
} from "@src/engines/SessionCore/workspace/atoms/sessionAtoms";
import type { AdvancedConfig } from "@src/features/SessionCreator/types";
import { createLogger } from "@src/hooks/logger";
import { reposAtom, selectedRepoIdAtom } from "@src/store/repo/atoms";
import { REPO_KIND, type Repo } from "@src/store/repo/types";
import { creatorDefaultExecModeAtom } from "@src/store/session/creatorDefaultExecModeAtom";
import { creatorDefaultModelSelectionAtom } from "@src/store/session/creatorDefaultModelAtom";
import {
  SESSION_TARGET_KIND,
  sessionCreatorStateAtom,
} from "@src/store/session/creatorStateAtom";
import type { RecentModelEntry } from "@src/store/session/recentModelEntriesAtom";
import {
  activeSessionIdAtom,
  workstationActiveSessionIdAtom,
} from "@src/store/session/viewAtom";
import { workspaceFoldersAtom } from "@src/store/ui/workspaceFoldersAtom";
import type { WorkspaceFolder } from "@src/types/workspace";

import { asError } from "../result";
import type {
  AddAccountOptions,
  ConfigureExistingOptions,
  E2EStore,
  Json,
  PinSessionOptions,
  Result,
} from "../types";
import { upsertSharedLocalKey } from "@src/hooks/keyVault/useLocalKeys";
import { addAccount } from "./accounts";

const logger = createLogger("E2EBootstrap");

const DEFAULT_ACCOUNT_NAME = "E2E OpenAI";

interface SessionConfigDeps {
  store: E2EStore;
}

async function waitForSessionSurface(sessionId: string): Promise<void> {
  const timeoutAt = Date.now() + 2_000;
  while (Date.now() < timeoutAt) {
    const tab = document.querySelector(`[data-session-tab="${sessionId}"]`);
    const chatView = document.querySelector("[data-chat-view-root]");
    if (tab && chatView) return;
    await new Promise((resolve) => window.setTimeout(resolve, 50));
  }
}

export function createSessionConfigHelpers({ store }: SessionConfigDeps) {
  const pinSession = async (
    opts: PinSessionOptions
  ): Promise<Result<{ repoId: string }>> => {
    try {
      if (!opts.accountId) {
        return { ok: false, error: "pinSession: `accountId` is required" };
      }
      if (!opts.model) {
        return { ok: false, error: "pinSession: `model` is required" };
      }

      const accountName = opts.accountName ?? DEFAULT_ACCOUNT_NAME;
      const category = opts.category ?? "rust_agent";
      const cliAgentType: CliAgentType | null =
        category === "cli_agent" ? (opts.cliAgentType ?? null) : null;
      const cliAgentLabel = cliAgentType ? formatAgentType(cliAgentType) : null;

      const prev = store.get(sessionCreatorStateAtom);
      store.set(sessionCreatorStateAtom, {
        ...prev,
        dispatchCategory: category,
        targetKind:
          category === "cli_agent"
            ? SESSION_TARGET_KIND.CLI_AGENT
            : opts.agentOrgId
              ? SESSION_TARGET_KIND.AGENT_ORG
              : SESSION_TARGET_KIND.AGENT,
        cliAgentType,
        selectedAgentDefinitionId:
          category === "rust_agent" && !opts.agentOrgId
            ? (opts.agentDefinitionId ?? prev.selectedAgentDefinitionId)
            : null,
        selectedAgentOrgId:
          category === "rust_agent" && opts.agentOrgId ? opts.agentOrgId : null,
        agentName: cliAgentLabel ?? prev.agentName ?? accountName,
      });
      if (opts.agentExecMode) {
        store.set(creatorDefaultExecModeAtom, opts.agentExecMode);
      }

      let selectedRepoId: string | null = null;
      const applyPinnedRepo = (
        repoId: string,
        repoName: string,
        repoPath: string
      ) => {
        const repo: Repo = {
          id: repoId,
          name: repoName,
          path: repoPath,
          fs_uri: repoPath,
          kind: REPO_KIND.GIT,
        };
        const folder: WorkspaceFolder = {
          id: repoId,
          name: repoName,
          path: repoPath,
          uri: `file://${repoPath}`,
          isPrimary: true,
          repoId,
          kind: "git",
        };
        const existingRepos = store.get(reposAtom);
        store.set(reposAtom, [
          repo,
          ...existingRepos.filter((existingRepo) => existingRepo.id !== repoId),
        ]);
        store.set(workspaceFoldersAtom, [folder]);
        store.set(selectedRepoIdAtom, repoId);
        store.set(repositoryIdAtom, repoId);
        store.set(repositoryNameAtom, repoName);
        store.set(repoPathAtom, repoPath);
        store.set(sessionCreatorStateAtom, {
          ...store.get(sessionCreatorStateAtom),
          source: {
            type: "local",
            repoId,
            repoName,
            repoPath,
            branch: "main",
          },
        });
      };
      if (opts.repoPath) {
        const repoId = `e2e-repo-${btoa(opts.repoPath)
          .replace(/[^a-zA-Z0-9]/g, "")
          .slice(0, 24)}`;
        const repoName =
          opts.repoPath.split(/[\\/]/).filter(Boolean).pop() ?? "E2E Repo";
        applyPinnedRepo(repoId, repoName, opts.repoPath);
        await new Promise((resolve) => window.setTimeout(resolve, 600));
        applyPinnedRepo(repoId, repoName, opts.repoPath);
        selectedRepoId = repoId;
      } else {
        const deadline = Date.now() + 15_000;
        let repos = store.get(reposAtom);
        while (repos.length === 0 && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 300));
          repos = store.get(reposAtom);
        }
        if (repos.length === 0) {
          return {
            ok: false,
            error:
              "no repos registered — open the app normally and index at least one repo first",
          };
        }
        const currentSelected = store.get(selectedRepoIdAtom);
        const hasValidSelection =
          !!currentSelected && repos.some((r) => r.id === currentSelected);
        if (!hasValidSelection) {
          store.set(selectedRepoIdAtom, repos[0].id);
        }
        selectedRepoId = store.get(selectedRepoIdAtom);
      }

      const entry: RecentModelEntry = {
        modelId: opts.model,
        sourceType: KEY_SOURCE.OWN,
        accountId: opts.accountId,
        accountName: accountName,
        modelType: opts.modelType ?? ("openai_api" as ModelType),
        cliAgentType: cliAgentType ?? undefined,
        cliAgentLabel: cliAgentLabel ?? undefined,
        cliModelDisplay: opts.model,
      };
      store.set(creatorDefaultModelSelectionAtom, entry);

      const repoId = selectedRepoId ?? store.get(selectedRepoIdAtom);
      if (!repoId) {
        return { ok: false, error: "pinSession: no repo selected" };
      }
      logger.info(
        `pinSession ok: account=${opts.accountId} model=${opts.model} repo=${repoId}`
      );
      return { ok: true, repoId };
    } catch (err) {
      return asError(err);
    }
  };

  const configure = async (
    opts: AddAccountOptions
  ): Promise<
    Result<{ accountId: string; modelId: string; repoId: string }>
  > => {
    const added = await addAccount(opts);
    if (!added.ok) return added;
    const pinned = await pinSession({
      accountId: added.account.id,
      model: opts.model,
      accountName: opts.accountName,
      modelType: added.account.agent_type as ModelType,
      agentDefinitionId: opts.agentDefinitionId,
      agentOrgId: opts.agentOrgId,
      repoPath: opts.repoPath,
    });
    if (!pinned.ok) return pinned;
    return {
      ok: true,
      accountId: added.account.id,
      modelId: opts.model,
      repoId: pinned.repoId,
    };
  };

  const configureWithExistingKey = async (
    opts: ConfigureExistingOptions
  ): Promise<
    Result<{ accountId: string; modelId: string; repoId: string }>
  > => {
    try {
      if (!opts.accountName) {
        return {
          ok: false,
          error: "configureWithExistingKey: `accountName` is required",
        };
      }
      const agentType = (opts.agentType ?? "openai_api") as ModelType;
      const accounts = await rpc.validation.listKeys();
      const matches = accounts.filter(
        (key) =>
          key.agent_type === agentType &&
          (key.id === opts.accountName || (key.name ?? "") === opts.accountName)
      );
      let match =
        matches.find((key) => key.enabled) ?? matches.find(Boolean) ?? null;
      if (!match) {
        return {
          ok: false,
          error: `configureWithExistingKey: no ${agentType} account named "${opts.accountName}" in keyvault — add it via the Integrations → My Keys panel first`,
        };
      }
      if (!match.enabled) {
        match = await rpc.validation.saveKey({
          request: {
            id: match.id,
            agent_type: match.agent_type as ModelType,
            enabled: true,
          },
        });
        upsertSharedLocalKey(match);
      }
      upsertSharedLocalKey(match);
      const enabled = match.enabled_models ?? [];
      if (enabled.length === 0) {
        return {
          ok: false,
          error: `configureWithExistingKey: account "${opts.accountName}" has no enabled models`,
        };
      }
      const chosenModel =
        opts.model && enabled.includes(opts.model) ? opts.model : enabled[0];
      const pinned = await pinSession({
        accountId: match.id,
        model: chosenModel,
        accountName: opts.accountName,
        modelType: match.agent_type as ModelType,
        agentDefinitionId: opts.agentDefinitionId,
        agentOrgId: opts.agentOrgId,
        category: opts.category,
        cliAgentType: opts.cliAgentType,
        nativeHarnessType: opts.nativeHarnessType,
        agentExecMode: opts.agentExecMode,
        repoPath: opts.repoPath,
      });
      if (!pinned.ok) return pinned;
      logger.info(
        `configureWithExistingKey ok: account=${match.id} model=${chosenModel}`
      );
      return {
        ok: true,
        accountId: match.id,
        modelId: chosenModel,
        repoId: pinned.repoId,
      };
    } catch (err) {
      return asError(err);
    }
  };

  const inspectCreatorSelection = async (): Promise<
    Result<{ creator: Json; modelSelection: Json | null }>
  > => {
    try {
      return {
        ok: true as const,
        creator: store.get(sessionCreatorStateAtom) as unknown as Json,
        modelSelection: store.get(
          creatorDefaultModelSelectionAtom
        ) as unknown as Json | null,
      };
    } catch (err) {
      return asError(err);
    }
  };

  const setAgentOrgMemberDraftConfig = async (
    config: Json,
    orgId?: string | null
  ): Promise<Result<{ config: Json }>> => {
    try {
      const draft = config as Pick<
        AdvancedConfig,
        "agentOrgMemberOverrides" | "applyAgentOrgMemberOverridesForFuture"
      >;
      if (orgId) {
        const currentByOrg = store.get(agentOrgMemberDraftConfigByOrgAtom);
        store.set(agentOrgMemberDraftConfigByOrgAtom, {
          ...currentByOrg,
          [orgId]: draft,
        });
      } else {
        store.set(agentOrgMemberDraftConfigAtom, draft);
      }
      return { ok: true, config };
    } catch (err) {
      return asError(err);
    }
  };

  const createCliPatchSession = async (opts: {
    cliAgentType: CliAgentType;
    model: string;
    accountId: string;
    workspacePath?: string;
    name?: string;
  }): Promise<Result<{ sessionId: string }>> => {
    try {
      const repo = opts.workspacePath
        ? { path: opts.workspacePath }
        : (() => {
            const repos = store.get(reposAtom);
            const selectedRepoId = store.get(selectedRepoIdAtom);
            return repos.find((row) => row.id === selectedRepoId) ?? repos[0];
          })();
      if (!repo?.path) {
        return {
          ok: false,
          error: "createCliPatchSession: no workspace path available",
        };
      }
      const session = (await invoke("cli_agent_create", {
        params: {
          name: opts.name ?? "E2E CLI patch session",
          platform: opts.cliAgentType,
          model: opts.model,
          accountId: opts.accountId,
          repoPath: repo.path,
          background: false,
          keySource: KEY_SOURCE.OWN,
        },
      })) as { sessionId?: string; session_id?: string };
      const sessionId = session.sessionId ?? session.session_id;
      if (!sessionId) {
        return {
          ok: false,
          error: `createCliPatchSession: missing session id in ${JSON.stringify(session)}`,
        };
      }
      store.set(activeSessionIdAtom, sessionId);
      store.set(workstationActiveSessionIdAtom, sessionId);
      await waitForSessionSurface(sessionId);
      return { ok: true, sessionId };
    } catch (err) {
      return asError(err);
    }
  };

  const patchSessionModel = async (
    sessionId: string,
    model: string,
    accountId?: string
  ): Promise<
    Result<{
      session: {
        sessionId: string;
        category: string;
        model?: string;
        accountId?: string;
        cliAgentType?: string;
      };
    }>
  > => {
    try {
      await rpc.sessionAggregate.patch({
        sessionId,
        patch: { model, accountId },
      });
      const listed = await rpc.sessionAggregate.list({});
      const session = listed.sessions.find(
        (row) => row.sessionId === sessionId
      );
      if (!session) {
        return {
          ok: false,
          error: `patchSessionModel: session ${sessionId} not found after patch`,
        };
      }
      return {
        ok: true,
        session: {
          sessionId: session.sessionId,
          category: session.category,
          model: session.model,
          accountId: session.accountId,
          cliAgentType: session.cliAgentType,
        },
      };
    } catch (err) {
      return asError(err);
    }
  };

  return {
    pinSession,
    configure,
    configureWithExistingKey,
    inspectCreatorSelection,
    setAgentOrgMemberDraftConfig,
    createCliPatchSession,
    patchSessionModel,
  };
}
