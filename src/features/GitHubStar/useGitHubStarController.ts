import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  type GitHubStarResult,
  checkOrgiiStar,
  starOrgii,
} from "@src/api/tauri/githubStar";

import { type GitHubStarSource, ORGII_GITHUB_URL } from "./constants";

export type GitHubStarControllerState =
  | { status: "loading" }
  | { status: "not-starred" }
  | { status: "starring" }
  | { status: "starred" }
  | {
      status: "web-fallback";
      reason: Extract<GitHubStarResult, { status: "unavailable" }>["reason"];
    }
  | { status: "error"; error: unknown };

export interface GitHubStarControllerDependencies {
  check: () => Promise<GitHubStarResult>;
  star: () => Promise<GitHubStarResult>;
  openExternal: (url: string) => Promise<void>;
}

export interface UseGitHubStarControllerOptions {
  source: GitHubStarSource;
  onConfirmedStarred?: () => void;
  dependencies?: Partial<GitHubStarControllerDependencies>;
}

export interface GitHubStarController {
  state: GitHubStarControllerState;
  source: GitHubStarSource;
  confirmStar: () => Promise<void>;
  openFallback: () => Promise<void>;
  retry: () => Promise<void>;
}

const DEFAULT_DEPENDENCIES: GitHubStarControllerDependencies = {
  check: checkOrgiiStar,
  star: starOrgii,
  openExternal: openUrl,
};

export function useGitHubStarController({
  source,
  onConfirmedStarred,
  dependencies,
}: UseGitHubStarControllerOptions): GitHubStarController {
  const resolvedDependencies = useRef<GitHubStarControllerDependencies>({
    ...DEFAULT_DEPENDENCIES,
    ...dependencies,
  });
  const onConfirmedStarredRef = useRef(onConfirmedStarred);
  const mountedRef = useRef(false);
  const generationRef = useRef(0);
  const notifiedRef = useRef(false);
  const fallbackOpenedRef = useRef(false);
  const [fallbackOpened, setFallbackOpened] = useState(false);
  const [state, setState] = useState<GitHubStarControllerState>({
    status: "loading",
  });

  useEffect(() => {
    onConfirmedStarredRef.current = onConfirmedStarred;
  }, [onConfirmedStarred]);

  const commitResult = useCallback((result: GitHubStarResult): void => {
    if (result.status === "starred") {
      setState({ status: "starred" });
      if (!notifiedRef.current) {
        notifiedRef.current = true;
        onConfirmedStarredRef.current?.();
      }
      return;
    }

    if (result.status === "not_starred") {
      setState({ status: "not-starred" });
      return;
    }

    setState({ status: "web-fallback", reason: result.reason });
  }, []);

  const runCheck = useCallback(
    async (showLoading: boolean): Promise<void> => {
      const generation = ++generationRef.current;
      if (showLoading) setState({ status: "loading" });

      try {
        const result = await resolvedDependencies.current.check();
        if (!mountedRef.current || generation !== generationRef.current) return;
        commitResult(result);
      } catch (error: unknown) {
        if (!mountedRef.current || generation !== generationRef.current) return;
        setState({ status: "error", error });
      }
    },
    [commitResult]
  );

  useEffect(() => {
    mountedRef.current = true;
    queueMicrotask(() => {
      if (mountedRef.current) void runCheck(false);
    });
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
    };
  }, [runCheck]);

  useEffect(() => {
    if (!fallbackOpened) return;

    const handleFocus = () => {
      if (!fallbackOpenedRef.current) return;
      void runCheck(false);
    };
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [fallbackOpened, runCheck]);

  const openFallback = useCallback(async (): Promise<void> => {
    const generation = ++generationRef.current;
    try {
      await resolvedDependencies.current.openExternal(ORGII_GITHUB_URL);
      if (!mountedRef.current || generation !== generationRef.current) return;
      fallbackOpenedRef.current = true;
      setFallbackOpened(true);
    } catch (error: unknown) {
      if (!mountedRef.current || generation !== generationRef.current) return;
      setState({ status: "error", error });
    }
  }, []);

  const confirmStar = useCallback(async (): Promise<void> => {
    const generation = ++generationRef.current;
    setState({ status: "starring" });

    try {
      const result = await resolvedDependencies.current.star();
      if (!mountedRef.current || generation !== generationRef.current) return;
      if (result.status === "unavailable") {
        setState({ status: "web-fallback", reason: result.reason });
        await openFallback();
        return;
      }
      commitResult(result);
    } catch (error: unknown) {
      if (!mountedRef.current || generation !== generationRef.current) return;
      setState({ status: "error", error });
    }
  }, [commitResult, openFallback]);

  const retry = useCallback(() => runCheck(true), [runCheck]);

  return { state, source, confirmStar, openFallback, retry };
}
