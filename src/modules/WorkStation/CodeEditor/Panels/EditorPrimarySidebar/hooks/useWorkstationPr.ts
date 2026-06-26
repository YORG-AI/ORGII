import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { fetchRustApi, gitRepoUrl } from "@src/api/http/git/client";
import { getGitRemotes } from "@src/api/http/git/remotes";
import { listOpenPRsLocal } from "@src/api/tauri/github";
import { Message } from "@src/components/Message";
import { buildIntegrationsPath } from "@src/config/mainAppPaths/integrations";
import {
  createPullRequest,
  parseGithubRepoFullName,
} from "@src/services/git/operations/createPullRequest";
import { gitAutoCreatePrAtom } from "@src/store/ui/editorSettingsAtom";
import {
  workstationAllOpenPrsAtom,
  workstationOpenPrsErrorAtom,
  workstationOpenPrsLoadStateAtom,
  workstationPrAtom,
  workstationPrCallbackAtom,
} from "@src/store/workstation/codeEditor/workstationPrAtom";

import { getCachedPrs, isPrCacheStale, setCachedPrs } from "./githubListCache";
import {
  formatWorkstationPrTitle,
  getStoredWorkstationPr,
  isWorkstationPrEligible,
  normalizePullRequestStatus,
  setStoredWorkstationPr,
  shouldAutoCreateWorkstationPr,
} from "./workstationPrHelpers";

export interface UseWorkstationPrOptions {
  repoPath: string;
  repoId?: string;
  branchName?: string;
  hasUpstream: boolean;
  uncommittedCount: number;
  commitMessage?: string;
}

type BranchPrState = {
  url: string;
  status?: string;
};

export function useWorkstationPr(options: UseWorkstationPrOptions) {
  const {
    repoPath,
    repoId = "default",
    branchName,
    hasUpstream,
    uncommittedCount,
    commitMessage,
  } = options;

  const { t } = useTranslation();
  const navigate = useNavigate();
  const autoCreatePr = useAtomValue(gitAutoCreatePrAtom);
  const setWorkstationPrAtom = useSetAtom(workstationPrAtom);
  const setWorkstationPrCallbackAtom = useSetAtom(workstationPrCallbackAtom);
  const setAllOpenPrs = useSetAtom(workstationAllOpenPrsAtom);
  const setOpenPrsLoadState = useSetAtom(workstationOpenPrsLoadStateAtom);
  const setOpenPrsError = useSetAtom(workstationOpenPrsErrorAtom);
  const branchKey = branchName ?? "";

  const [remotePrByBranch, setRemotePrByBranch] = useState<
    Record<string, BranchPrState>
  >({});
  const [errorByBranch, setErrorByBranch] = useState<
    Record<string, string | null>
  >({});
  const [creatingByBranch, setCreatingByBranch] = useState<
    Record<string, boolean>
  >({});
  const [defaultBranch, setDefaultBranch] = useState("main");
  const autoTriggeredRef = useRef(false);
  const openPrsRequestIdRef = useRef(0);
  const handleCreatePrRef = useRef<
    () => Promise<{ url?: string; error?: string }>
  >(async () => ({}));

  const storedPr = useMemo(() => {
    if (!repoPath || !branchName) return null;
    return getStoredWorkstationPr(repoPath, branchName);
  }, [repoPath, branchName]);

  const remotePr = branchKey ? remotePrByBranch[branchKey] : undefined;
  const prUrl = remotePr?.url ?? storedPr?.url;
  const prStatus = remotePr?.status ?? storedPr?.status;
  const errorMessage = branchKey ? (errorByBranch[branchKey] ?? null) : null;
  const isCreating = branchKey ? (creatingByBranch[branchKey] ?? false) : false;

  useEffect(() => {
    let cancelled = false;
    if (!repoPath) return;

    fetchRustApi<{ name: string }>(
      `${gitRepoUrl(repoId)}/default-branch?${new URLSearchParams({ path: repoPath }).toString()}`
    )
      .then((resp) => {
        if (!cancelled && resp.data?.name) {
          setDefaultBranch(resp.data.name);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDefaultBranch("main");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [repoPath, repoId]);

  useEffect(() => {
    autoTriggeredRef.current = false;
  }, [branchKey]);

  const handleLoadOpenPrs = useCallback(() => {
    if (!repoPath) return;

    const requestId = ++openPrsRequestIdRef.current;
    const isCurrentRequest = () => requestId === openPrsRequestIdRef.current;

    const cachedEntry = getCachedPrs(repoPath);
    if (cachedEntry) {
      setAllOpenPrs(cachedEntry.prs);
      setOpenPrsLoadState("ready");
      setOpenPrsError(null);
      if (!isPrCacheStale(repoPath)) return;
    } else {
      setOpenPrsLoadState("loading");
      setOpenPrsError(null);
    }

    void (async () => {
      try {
        const remotesData = await getGitRemotes({
          repo_id: repoId,
          repo_path: repoPath,
        });
        const originRemote = remotesData?.remotes?.find(
          (remote) => remote.name === "origin"
        );
        if (!originRemote?.url) {
          if (isCurrentRequest()) setOpenPrsLoadState("ready");
          return;
        }

        const repoFullName = parseGithubRepoFullName(originRemote.url);
        if (!repoFullName) {
          if (isCurrentRequest()) setOpenPrsLoadState("ready");
          return;
        }

        const prs = await listOpenPRsLocal(repoFullName);
        if (!isCurrentRequest()) return;
        setAllOpenPrs(prs);
        if (branchName) {
          const currentBranchPr = prs.find(
            (pr) => pr.head_branch === branchName
          );
          if (currentBranchPr) {
            const status = normalizePullRequestStatus(currentBranchPr.state);
            setRemotePrByBranch((current) => ({
              ...current,
              [branchName]: { url: currentBranchPr.url, status },
            }));
            setStoredWorkstationPr(repoPath, branchName, {
              url: currentBranchPr.url,
              status,
            });
          }
        }
        setCachedPrs(repoPath, prs);
        setOpenPrsLoadState("ready");
        setOpenPrsError(null);
      } catch (err) {
        if (!isCurrentRequest()) return;
        setOpenPrsError(err instanceof Error ? err.message : String(err));
        setOpenPrsLoadState("error");
      }
    })();
  }, [
    repoPath,
    repoId,
    branchName,
    setAllOpenPrs,
    setOpenPrsLoadState,
    setOpenPrsError,
  ]);

  const eligible = useMemo(
    () =>
      isWorkstationPrEligible({
        branch: branchName,
        defaultBranch,
        hasUpstream,
        uncommittedCount,
      }),
    [branchName, defaultBranch, hasUpstream, uncommittedCount]
  );

  const handleCreatePr = useCallback(async (): Promise<{
    url?: string;
    error?: string;
  }> => {
    if (isCreating) return {};
    if (!branchName) {
      return { error: t("git.pr.noBranch") };
    }
    if (!repoPath) {
      return { error: t("git.pr.noRepoPath") };
    }

    setCreatingByBranch((current) => ({ ...current, [branchName]: true }));
    setErrorByBranch((current) => ({ ...current, [branchName]: null }));

    const title = formatWorkstationPrTitle(branchName, commitMessage);
    const result = await createPullRequest({
      repoPath,
      branch: branchName,
      title,
      repoId,
      pushBeforeCreate: true,
    });

    if (result.error) {
      if (result.error === "not_authenticated") {
        setCreatingByBranch((current) => ({ ...current, [branchName]: false }));
        navigate(buildIntegrationsPath({ category: "git" }));
        Message.info({
          id: "github-auth-required",
          title: t("git.pr.authRequired.title"),
          content: t("git.pr.authRequired.description"),
          duration: 8000,
          closable: true,
        });
        return { error: result.error };
      }

      const message =
        result.error === "no_origin_remote"
          ? t("git.pr.noOriginRemote")
          : result.error === "cannot_parse_repo_name"
            ? t("git.pr.cannotParseRepoName")
            : result.error;
      setErrorByBranch((current) => ({ ...current, [branchName]: message }));
      setCreatingByBranch((current) => ({ ...current, [branchName]: false }));
      return { error: message };
    }

    if (result.url) {
      setRemotePrByBranch((current) => ({
        ...current,
        [branchName]: { url: result.url!, status: "open" },
      }));
      setStoredWorkstationPr(repoPath, branchName, {
        url: result.url,
        status: "open",
      });
    }

    setCreatingByBranch((current) => ({ ...current, [branchName]: false }));
    return { url: result.url };
  }, [isCreating, branchName, repoPath, commitMessage, repoId, t, navigate]);

  const prIsActive = !!prUrl && prStatus !== "closed" && prStatus !== "merged";
  const readyToCreate = eligible && !prIsActive;

  useEffect(() => {
    handleCreatePrRef.current = handleCreatePr;
  });

  useEffect(() => {
    if (
      shouldAutoCreateWorkstationPr({
        autoCreatePr,
        eligible,
        prUrl,
        isCreating,
      }) &&
      !autoTriggeredRef.current
    ) {
      autoTriggeredRef.current = true;
      const timer = setTimeout(() => {
        void handleCreatePrRef.current();
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [autoCreatePr, eligible, prUrl, isCreating]);

  useEffect(() => {
    if (!readyToCreate) {
      autoTriggeredRef.current = false;
    }
  }, [readyToCreate]);

  const isDefaultBranch = !!branchName && branchName === defaultBranch;

  useEffect(() => {
    setWorkstationPrAtom({
      readyToCreate,
      prUrl,
      isCreating,
      hasUpstream,
      uncommittedCount,
      isDefaultBranch,
    });
  }, [
    readyToCreate,
    prUrl,
    isCreating,
    hasUpstream,
    uncommittedCount,
    isDefaultBranch,
    setWorkstationPrAtom,
  ]);

  useEffect(() => {
    setWorkstationPrCallbackAtom({
      createPr: handleCreatePr,
      loadOpenPrs: handleLoadOpenPrs,
    });
  }, [handleCreatePr, handleLoadOpenPrs, setWorkstationPrCallbackAtom]);

  useEffect(() => {
    return () => {
      openPrsRequestIdRef.current += 1;
      setWorkstationPrAtom({
        readyToCreate: false,
        prUrl: undefined,
        isCreating: false,
        hasUpstream: false,
        uncommittedCount: 0,
        isDefaultBranch: false,
      });
      setWorkstationPrCallbackAtom({ createPr: null, loadOpenPrs: null });
      setAllOpenPrs([]);
      setOpenPrsLoadState("idle");
      setOpenPrsError(null);
    };
  }, [
    setWorkstationPrAtom,
    setWorkstationPrCallbackAtom,
    setAllOpenPrs,
    setOpenPrsLoadState,
    setOpenPrsError,
  ]);

  return {
    prUrl,
    prStatus,
    isCreating,
    errorMessage,
    eligible,
    readyToCreate,
    autoCreatePr,
    handleCreatePr,
  };
}
