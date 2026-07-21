/**
 * Renderer wrapper for `source-control` tabs (unified Focus / All Changes).
 *
 * Renders NOTHING by design — a 1:1 mirror of `TabContentRenderer`'s
 * `case "source-control"`, which returns `null`.
 *
 * The Source Control main pane is painted by a dedicated, active-only overlay
 * in `EditorMainPane`. Rendering it here as well would double-mount the pane,
 * so this renderer stays a no-op and lets the overlay own the surface.
 */
import React, { memo } from "react";

import type { UnifiedTabContentProps } from "../types";

const SourceControlTabRenderer: React.FC<UnifiedTabContentProps> = memo(
  () => null
);

SourceControlTabRenderer.displayName = "SourceControlTabRenderer";

export default SourceControlTabRenderer;
