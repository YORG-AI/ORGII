/**
 * WizardShell Component
 *
 * Outer container for multi-step wizards.
 *
 * The wizard's title is published to `wizardBreadcrumbTitleAtom` so the
 * Settings workspace-header breadcrumb renders
 * `Settings › <Section> › <Wizard Title>` instead of a separate 40px
 * PanelHeader bar with an X close button. Cancel is handled by the
 * footer Cancel button each wizard step renders (the previous X glyph
 * on the header bar has been removed).
 *
 * `afterHeader` is still accepted for backward compatibility with the
 * KeyVault wizard, which pinned a tab strip directly below the old
 * header row. It now renders at the top of the wizard's content area.
 *
 * @example
 * ```tsx
 * <WizardShell title="Add Account" onCancel={handleCancel}>
 *   {currentStep === 1 && <StepOne ... />}
 *   {currentStep === 2 && <StepTwo ... />}
 * </WizardShell>
 * ```
 */
import { useSetAtom } from "jotai";
import React, { useEffect } from "react";

import { wizardBreadcrumbTitleAtom } from "@src/store/ui/wizardBreadcrumbAtom";

// ============================================
// Types
// ============================================

interface WizardShellProps {
  /** Wizard title published to the workspace-header breadcrumb */
  title: string;
  /**
   * Cancel/close handler. The shell no longer renders an X button — each
   * wizard's footer Cancel button calls this. Kept on the prop API so
   * wizards can also bind it to ESC handlers or external triggers.
   */
  onCancel: () => void;
  /** Step content (rendered below the header) */
  children: React.ReactNode;
  /** Content rendered above the step area (e.g. KeyVault tab strip) */
  afterHeader?: React.ReactNode;
  /** Optional stable test id for E2E specs to assert mount/unmount. */
  testId?: string;
  /**
   * Legacy prop, retained for E2E specs that still look up the close
   * action by test id. The shell itself no longer renders a close
   * affordance; wizards should attach this id to their footer Cancel
   * button if they need to keep the spec passing.
   */
  closeTestId?: string;
}

// ============================================
// Component
// ============================================

const WizardShell: React.FC<WizardShellProps> = ({
  title,
  children,
  afterHeader,
  testId,
}) => {
  const setBreadcrumbTitle = useSetAtom(wizardBreadcrumbTitleAtom);

  useEffect(() => {
    setBreadcrumbTitle(title);
    return () => setBreadcrumbTitle(null);
  }, [title, setBreadcrumbTitle]);

  return (
    <div
      className="flex h-full w-full flex-col overflow-hidden pt-2"
      data-testid={testId}
    >
      {afterHeader}
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );
};

export default WizardShell;
