/**
 * SuggestionsPage Component
 *
 * Main landing page with Launchpad grid
 */
import { useAtomValue } from "jotai";
import React from "react";

import {
  HOST_DESKTOP,
  resolveHostDesktop,
} from "@src/config/windowChromeRadius";
import { getPagePanelBackgroundStyle } from "@src/modules/shared/layouts/viewContainerTokens";
import { resolvedBackgroundConfigAtom } from "@src/store/ui/backgroundConfigAtom";

import { AppGrid } from "./components";
import "./index.scss";

const IS_MACOS_HOST = resolveHostDesktop() === HOST_DESKTOP.MACOS;

const SuggestionsPage: React.FC = () => {
  const backgroundConfig = useAtomValue(resolvedBackgroundConfigAtom);
  const homeSurfaceStyle = IS_MACOS_HOST
    ? getPagePanelBackgroundStyle(backgroundConfig.pageOpacity)
    : undefined;

  return (
    <div className="relative flex h-full flex-col" style={homeSurfaceStyle}>
      <div
        className="absolute inset-x-0 top-0 z-10 h-[72px]"
        data-tauri-drag-region
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
        aria-hidden
      />
      <section
        className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-4 scrollbar-hide"
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      >
        <AppGrid />
      </section>
    </div>
  );
};

export default SuggestionsPage;
