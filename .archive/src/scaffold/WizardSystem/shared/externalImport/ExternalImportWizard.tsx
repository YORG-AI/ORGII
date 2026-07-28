/**
 * ExternalImportWizard — single-step wizard that drives the unified
 * `external_import_*` pipeline for any `ItemKind`. Rules ship with
 * their own wizard (PolicyRuleWizard) because that flow also covers
 * "create from scratch"; this wizard is dedicated to the import-only
 * surfaces for skills and agent definitions.
 */
import React from "react";
import { useTranslation } from "react-i18next";

import type { ItemKind } from "@src/api/types/externalImport";
import Button from "@src/components/Button";
import type { CursorRepo } from "@src/hooks/policies";
import { SECTION_GAP_CLASSES } from "@src/modules/shared/layouts/SectionLayout";
import {
  WizardShell,
  WizardStepLayout,
} from "@src/scaffold/WizardSystem/primitives";

import ExternalImportTable, {
  type ExternalImportTableLabels,
} from "./ExternalImportTable";
import { useExternalImport } from "./useExternalImport";

export interface ExternalImportWizardProps {
  kind: ItemKind;
  /** Window title shown in the wizard chrome. */
  title: string;
  /** Repos whose repo-local sources should be scanned. */
  cursorRepos?: CursorRepo[];
  /** Triggered after a successful batch apply (closes the wizard). */
  onCancel: () => void;
  /** Triggered after the catalog refreshes (parent reloads its lists). */
  onAfterImport?: () => void | Promise<void>;
  /** Localized labels for the result table + name column. */
  labels: ExternalImportTableLabels & { itemColumnHeader: string };
}

const ExternalImportWizard: React.FC<ExternalImportWizardProps> = ({
  kind,
  title,
  cursorRepos,
  onCancel,
  onAfterImport,
  labels,
}) => {
  const { t } = useTranslation("integrations");

  const {
    items,
    importableItems,
    selected,
    importLoading,
    importing,
    importError,
    importErrors,
    importColumns,
    handleImport,
  } = useExternalImport({
    kind,
    active: true,
    cursorRepos,
    onCompleted: onCancel,
    onRefresh: onAfterImport,
    labels: { itemColumnHeader: labels.itemColumnHeader },
  });

  const stepActions = (
    <>
      <Button variant="secondary" size="small" onClick={onCancel}>
        {t("common:actions.cancel")}
      </Button>
      <Button
        variant="primary"
        size="small"
        disabled={selected.size === 0}
        loading={importing}
        onClick={handleImport}
        data-testid={`external-import-submit-${kind}`}
      >
        {t("agentOrgs.importSelected", {
          count: selected.size,
        })}
      </Button>
    </>
  );

  return (
    <WizardShell title={title} onCancel={onCancel}>
      <WizardStepLayout currentStep={1} totalSteps={1} actions={stepActions}>
        <div
          className={SECTION_GAP_CLASSES}
          data-testid={`external-import-wizard-${kind}`}
        >
          <ExternalImportTable
            importLoading={importLoading}
            importableItems={importableItems}
            itemsEmpty={items.length === 0}
            importColumns={importColumns}
            importError={importError}
            importErrors={importErrors}
            labels={{
              itemPlural: labels.itemPlural,
              emptyTitle: labels.emptyTitle,
              emptySubtitle: labels.emptySubtitle,
              emptyAction: labels.emptyAction,
            }}
          />
        </div>
      </WizardStepLayout>
    </WizardShell>
  );
};

export default ExternalImportWizard;
