/**
 * InlineCredentialImport — "Import credentials from other apps" panel.
 *
 * Visually and behaviourally a sibling of `InlineExternalImport` (the
 * skills / rules / MCP / agents auto-import rows): a collapsed section row
 * with an Expand toggle, and when expanded a SettingsTable of importable
 * rows with select-all, search, per-item failures, and an "Import (n)"
 * button. The header shows how many credentials the offline probe found
 * so the suggestion is visible without expanding.
 */
import React, { useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import SettingsTable from "@src/components/SettingsTable";
import {
  ChevronsDownUpIcon,
  Download01Icon,
  HugeiconsIcon,
  UnfoldMoreIcon,
} from "@src/icons";
import {
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";

import { credentialImportRowKey } from "./credentialImportUtils";
import { useCredentialImport } from "./useCredentialImport";

interface InlineCredentialImportProps {
  sourceKind?: "cc_switch";
  /** Start expanded and route the toggle to `onCompleted` (wizard flows). */
  forceExpanded?: boolean;
  onCompleted?: () => void;
  /** Reload agents / accounts after a successful import. */
  onAfterImport?: () => void | Promise<void>;
}

const InlineCredentialImport: React.FC<InlineCredentialImportProps> = ({
  forceExpanded = false,
  sourceKind,
  onCompleted,
  onAfterImport,
}) => {
  const { t } = useTranslation("integrations");
  const [manuallyExpanded, setManuallyExpanded] = useState(false);
  const expanded = forceExpanded || manuallyExpanded;

  const {
    items,
    allImportableItems,
    importableItems,
    selected,
    importLoading,
    importing,
    importError,
    importErrors,
    importColumns,
    handleImport,
  } = useCredentialImport({
    sourceKind,
    onCompleted: onCompleted ?? (() => undefined),
    onRefresh: onAfterImport,
  });

  const foundCount = allImportableItems.length;
  const title =
    foundCount > 0
      ? t("credentialImport.titleWithCount", { count: foundCount })
      : t("credentialImport.title");

  return (
    <SectionContainer>
      <SectionRow label={title}>
        <Button
          variant="secondary"
          icon={
            expanded ? (
              <HugeiconsIcon
                icon={ChevronsDownUpIcon}
                data-icon="chevrons-down-up"
                size={14}
              />
            ) : (
              <HugeiconsIcon
                icon={UnfoldMoreIcon}
                data-icon="chevrons-up-down"
                size={14}
              />
            )
          }
          onClick={() => {
            if (forceExpanded) {
              onCompleted?.();
              return;
            }
            setManuallyExpanded((current) => !current);
          }}
        >
          {t("common:actions.expand")}
        </Button>
      </SectionRow>

      {expanded && (
        <SectionRow showHeader={false} className="pt-0">
          <div className="flex flex-col gap-3">
            {importLoading && items.length === 0 ? null : items.length === 0 ? (
              <div className="rounded-md bg-fill-2 px-3 py-2 text-[12px] text-text-3">
                {t("credentialImport.empty")}
              </div>
            ) : allImportableItems.length === 0 ? (
              <div className="rounded-md bg-fill-2 px-3 py-2 text-[12px] text-text-3">
                {t("credentialImport.allImported")}
              </div>
            ) : (
              <SettingsTable
                columns={importColumns}
                rows={importableItems}
                getRowKey={credentialImportRowKey}
                headerHeight="tall"
                noPx
                className="table-settings-expanded-compact"
              />
            )}

            {importError && (
              <div className="rounded border border-solid border-danger-3 bg-danger-1 px-3 py-2 text-[12px] text-danger-6">
                {t("credentialImport.applyFailed", { message: importError })}
              </div>
            )}
            {importErrors.length > 0 && (
              <div className="rounded border border-solid border-warning-3 bg-warning-1 px-3 py-2 text-[12px] text-warning-6">
                <div className="mb-1 font-bold">
                  {t("credentialImport.partialFailure")}
                </div>
                <ul className="list-inside list-disc">
                  {importErrors.map((entry) => (
                    <li key={entry.id}>
                      <span className="font-bold">{entry.displayName}</span>{" "}
                      <span className="font-mono text-[11px]">
                        ({entry.sourceLabel})
                      </span>
                      : {entry.error}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {allImportableItems.length > 0 && (
              <div className="flex justify-end">
                <Button
                  variant="primary"
                  size="small"
                  icon={
                    <HugeiconsIcon
                      icon={Download01Icon}
                      data-icon="download"
                      size={14}
                    />
                  }
                  disabled={selected.size === 0}
                  loading={importing}
                  onClick={handleImport}
                >
                  {t("agentOrgs.importSelected", { count: selected.size })}
                </Button>
              </div>
            )}
          </div>
        </SectionRow>
      )}
    </SectionContainer>
  );
};

export default InlineCredentialImport;
