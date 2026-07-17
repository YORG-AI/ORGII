/**
 * Renderer wrapper for `start` tabs.
 *
 * The start tab is the empty-pool launcher. It's normally painted full-screen
 * by `AppShellContent` (so it has no host chrome), but it's registered here too
 * for dispatcher completeness.
 */
import React, { memo } from "react";

import { WorkStationStartPage } from "@src/modules/WorkStation/AppShell/StartPage";

import type { UnifiedTabContentProps } from "../types";

const StartTabRenderer: React.FC<UnifiedTabContentProps> = memo(() => (
  <WorkStationStartPage />
));

StartTabRenderer.displayName = "StartTabRenderer";

export default StartTabRenderer;
