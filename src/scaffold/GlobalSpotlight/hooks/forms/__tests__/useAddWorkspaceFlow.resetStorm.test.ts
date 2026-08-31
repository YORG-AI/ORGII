// @vitest-environment jsdom
/**
 * useAddWorkspaceFlow — form-reset commit-storm regression.
 *
 * 2026-06 incident: the reset effect listed the form-hook return objects as
 * deps. They are fresh objects every render, and resetForm()'s setState batch
 * (object-typed form state gets a fresh default object, so React cannot bail)
 * always schedules one more render — so a mounted-but-CLOSED WorkspacePalette
 * re-fired the effect on every render, a self-sustaining ~1000 commits/s loop
 * that pegged the webview at ~90% CPU on the session-creator page.
 *
 * These tests mount the hook under a real renderer with form-hook mimics that
 * preserve the two dangerous properties (fresh return-object identity every
 * render; resetForm sets object-typed state that never compares equal) and
 * assert commits stay bounded and resets fire only on the open → closed
 * transition. The old code fails them with "Maximum update depth exceeded".
 */
import { createElement, useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type SmokeRoot,
  createSmokeRoot,
  dispatch,
  expectQuiescent,
  settle,
} from "@src/test/reactSmokeHarness";

import {
  type AddWorkspaceModalStage,
  useAddWorkspaceFlow,
} from "../useAddWorkspaceFlow";

const resetCalls = vi.hoisted(() => ({ local: 0, clone: 0, multi: 0 }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

vi.mock("@src/hooks/git/useRepoSelection", () => ({
  useRepoSelection: () => ({
    forceRefreshRepos: async () => {},
    selectRepo: () => {},
  }),
}));

// The real config barrel drags in @src/i18n and the ActionSystem; the hook
// only reads inert icon references from it.
vi.mock("../../../config", () => ({
  ICONS: {
    folderOpen: () => null,
    newRepo: () => null,
    cloneRepo: () => null,
    cloneRepoUrl: () => null,
  },
}));

// Form-hook mimics preserving what powered the storm: a FRESH return object
// every render, and a resetForm whose object-typed setState can never be
// eagerly bailed (fresh default object each call).
vi.mock("../useWorkspaceForm", async () => {
  const { useState } = await import("react");
  return {
    useWorkspaceForm: () => {
      const [values, setValues] = useState<{ name: string }>({ name: "" });
      const [loading, setLoading] = useState(false);
      return {
        values,
        loading,
        resetForm: () => {
          resetCalls.local += 1;
          setValues({ name: "" });
          setLoading(false);
        },
        handleOpenLocalWorkspace: async () => {},
      };
    },
  };
});

vi.mock("../useCloneForm", async () => {
  const { useCallback, useState } = await import("react");
  return {
    useCloneForm: () => {
      const [values, setValues] = useState<{ url: string }>({ url: "" });
      const [isLoadingRepos, setIsLoadingRepos] = useState(false);
      const fetchGitHubRepos = useCallback(() => {}, []);
      return {
        values,
        isLoadingRepos,
        repositories: [],
        subTab: "url",
        fetchGitHubRepos,
        resetForm: () => {
          resetCalls.clone += 1;
          setValues({ url: "" });
          setIsLoadingRepos(false);
        },
      };
    },
  };
});

vi.mock("../useCreateWorkspaceForm", async () => {
  const { useState } = await import("react");
  return {
    useCreateWorkspaceForm: () => {
      const [values, setValues] = useState<{ names: string[] }>({ names: [] });
      const [loading, setLoading] = useState(false);
      return {
        values,
        loading,
        resetForm: () => {
          resetCalls.multi += 1;
          setValues({ names: [] });
          setLoading(false);
        },
      };
    },
  };
});

let commits = 0;
const controls: {
  setStage: (stage: AddWorkspaceModalStage) => void;
  churn: () => void;
} = { setStage: () => {}, churn: () => {} };

/**
 * Stands in for WorkspacePalette: owns the modal stage, mounts the flow hook,
 * and exposes a churn setState so tests can force parent re-renders the way
 * the session-creator page did.
 */
function Harness(): null {
  // Test-only commit counter; the render-phase mutation is deliberate so the
  // circuit breaker below can throw mid-storm (verified against the original
  // buggy effect deps: it turns an OOM'd worker into a clean failure).
  // eslint-disable-next-line react-hooks/globals -- deliberate render counter is the test's circuit breaker for the regression's self-sustaining commit storm
  commits += 1;
  if (commits > 400) {
    throw new Error(
      "commit storm: Harness exceeded 400 commits — a self-sustaining render loop is back"
    );
  }
  const [stage, setStage] = useState<AddWorkspaceModalStage>(null);
  const [, setChurn] = useState(0);
  useEffect(() => {
    controls.setStage = setStage;
    controls.churn = () => setChurn((value) => value + 1);
  }, []);
  useAddWorkspaceFlow({ modalStage: stage, setModalStage: setStage });
  return null;
}

describe("useAddWorkspaceFlow reset storm", () => {
  let root: SmokeRoot;

  beforeEach(async () => {
    vi.useFakeTimers();
    commits = 0;
    resetCalls.local = 0;
    resetCalls.clone = 0;
    resetCalls.multi = 0;
    root = createSmokeRoot();
    await root.render(createElement(Harness));
    await settle();
  });

  afterEach(async () => {
    await root.unmount();
    vi.useRealTimers();
  });

  it("mounting with the modal closed settles without firing resets", async () => {
    expect(commits).toBeLessThanOrEqual(4);
    expect(resetCalls).toEqual({ local: 0, clone: 0, multi: 0 });
    await expectQuiescent(() => commits);
  });

  it("parent re-render churn while closed stays 1:1 and never resets", async () => {
    const before = commits;
    for (let index = 0; index < 25; index += 1) {
      await dispatch(() => controls.churn());
    }
    await settle();
    // Each churn is exactly one commit; the old reset loop multiplied this
    // without bound (or blew React's update-depth limit outright).
    expect(commits - before).toBeLessThanOrEqual(25 + 2);
    expect(resetCalls).toEqual({ local: 0, clone: 0, multi: 0 });
    await expectQuiescent(() => commits);
  });

  it("resets fire exactly once on the open → closed transition", async () => {
    await dispatch(() => controls.setStage("add-workspace-new"));
    await settle();
    expect(resetCalls).toEqual({ local: 0, clone: 0, multi: 0 });

    await dispatch(() => controls.setStage(null));
    await settle();
    expect(resetCalls).toEqual({ local: 1, clone: 1, multi: 1 });
    await expectQuiescent(() => commits);

    // Later renders while closed must not re-trigger the reset.
    await dispatch(() => controls.churn());
    await settle();
    expect(resetCalls).toEqual({ local: 1, clone: 1, multi: 1 });
  });
});
