import { useSetAtom } from "jotai";
import { useEffect } from "react";

import { probeGitDependencyAtom } from "@src/store/platform/gitDependencyAtom";
import { waitForFirstPaint } from "@src/util/core/init/deferredInit";

export function usePostPaintGitProbe(): void {
  const probeGitDependency = useSetAtom(probeGitDependencyAtom);

  useEffect(() => {
    let cancelled = false;

    waitForFirstPaint().then(() => {
      if (!cancelled) {
        void probeGitDependency();
      }
    });

    return () => {
      cancelled = true;
    };
  }, [probeGitDependency]);
}
