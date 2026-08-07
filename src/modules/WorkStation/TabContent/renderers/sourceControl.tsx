/**
 * Renderer wrapper for `source-control` tabs (unified Focus / All Changes).
 *
 * Renders NOTHING by design — a 1:1 mirror of `TabContentRenderer`'s
 * `case "source-control"`, which returns `null`.
 *
 * CRITICAL edge case: the Source Control main pane is painted by a dedicated
 * KEEP-ALIVE overlay in `EditorMainPane` (mounted once the tab is first
 * visited, then shown/hidden instead of unmounted) so its diff view + scroll
 * position + lazy chunk survive navigating to a file tab and back (issue #16).
 * Rendering `SourceControlMainContent` here as well would DOUBLE-MOUNT it and
 * break that keep-alive, so this renderer stays a no-op and lets the overlay
 * own the surface. Do not convert this to render the pane.
 */
import React, { memo } from "react";

import type { UnifiedTabContentProps } from "../types";

const SourceControlTabRenderer: React.FC<UnifiedTabContentProps> = memo(
  () => null
);

SourceControlTabRenderer.displayName = "SourceControlTabRenderer";

export default SourceControlTabRenderer;
