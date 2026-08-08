import { useCallback, useMemo, useState } from "react";

import {
  type SetupWalkthroughProgress,
  normalizeSetupWalkthroughProgress,
} from "@src/config/settingsSchema/setupWalkthroughProgress";

export function useSyncedSetupWalkthroughProgress(
  stored: SetupWalkthroughProgress
) {
  const normalizedStored = useMemo(
    () => normalizeSetupWalkthroughProgress(stored),
    [stored]
  );
  const [draft, setDraft] = useState(() => ({
    owner: stored,
    progress: normalizedStored,
  }));
  const progress = draft.owner === stored ? draft.progress : normalizedStored;

  const replaceProgress = useCallback(
    (next: SetupWalkthroughProgress) => {
      setDraft({ owner: stored, progress: next });
      return next;
    },
    [stored]
  );

  return { progress, replaceProgress };
}
