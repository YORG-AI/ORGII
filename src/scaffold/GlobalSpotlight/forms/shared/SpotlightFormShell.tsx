/**
 * SpotlightFormShell + SpotlightFormBody
 *
 * Shared structure for every spotlight modal form (clone, import, create
 * repo/folder, create-workspace). The form runs edge-to-edge inside the
 * spotlight panel while the body and footer own their section spacing.
 *
 * Usage:
 *
 *   <SpotlightFormShell>
 *     <SpotlightFormBody>
 *       {/* fields, lists, etc. *\/}
 *     </SpotlightFormBody>
 *     <PanelFooter ... />
 *   </SpotlightFormShell>
 */
import React from "react";

import { SPOTLIGHT_MODAL_FORM_TOKENS } from "./spotlightModalFormTokens";

interface SpotlightFormShellProps {
  children: React.ReactNode;
}

/**
 * Edge-to-edge form surface. The spotlight shell owns the outer border and
 * radius; this layer only provides the form background and clips its sections.
 * Padding is left to `SpotlightFormBody` and `PanelFooter` so each section can
 * manage its own spacing semantics.
 */
export const SpotlightFormShell: React.FC<SpotlightFormShellProps> = ({
  children,
}) => (
  <div className={SPOTLIGHT_MODAL_FORM_TOKENS.shellClassName}>{children}</div>
);

interface SpotlightFormBodyProps {
  children: React.ReactNode;
}

/**
 * Standard body region for a form panel. Applies the canonical `p-3`
 * inset so the body and the `PanelFooter` (`px-3 h-12`) line up on the
 * horizontal axis.
 */
export const SpotlightFormBody: React.FC<SpotlightFormBodyProps> = ({
  children,
}) => <div className="p-3">{children}</div>;
