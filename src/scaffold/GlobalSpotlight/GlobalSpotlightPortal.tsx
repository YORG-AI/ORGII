/**
 * Global Spotlight Portal Component
 *
 * Mounts the GlobalSpotlight when its open atom is true. The spotlight
 * itself owns its chrome (portal, glass, positioning, footer) via
 * SpotlightShell — this wrapper is now just an open-state binding +
 * a scoped MultiRepoGitStatusProvider for the spotlight's repo features.
 */
import { useAtom } from "jotai";
import React, { Suspense } from "react";

import { MultiRepoGitStatusProvider } from "@src/contexts/git";
import { spotlightOpenAtom } from "@src/store";

const GlobalSpotlight = React.lazy(() =>
  import("@/src/scaffold/GlobalSpotlight").then((module) => ({
    default: module.GlobalSpotlight,
  }))
);

export const GlobalSpotlightPortal: React.FC = () => {
  const [spotlightOpen, setSpotlightOpen] = useAtom(spotlightOpenAtom);

  if (!spotlightOpen) return null;

  return (
    <MultiRepoGitStatusProvider>
      <Suspense fallback={null}>
        <GlobalSpotlight
          isOpen={true}
          onClose={() => setSpotlightOpen(false)}
        />
      </Suspense>
    </MultiRepoGitStatusProvider>
  );
};
