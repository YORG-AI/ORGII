/**
 * Global Spotlight Portal Component
 *
 * Mounts the GlobalSpotlight when its open atom is true. The spotlight
 * itself owns its chrome (portal, glass, positioning, footer) via
 * SpotlightShell — this wrapper is just an open-state binding.
 */
import { useAtom } from "jotai";
import React, { Suspense } from "react";

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
    <Suspense fallback={null}>
      <GlobalSpotlight isOpen={true} onClose={() => setSpotlightOpen(false)} />
    </Suspense>
  );
};
