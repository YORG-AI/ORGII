/**
 * SyncSection — External sync adapter configuration for a project.
 *
 * Lets the user attach/detach a sync adapter (Echo, Linear, GitHub, …),
 * choose a global sync connection, watch outbox counts, and trigger
 * force_push / force_pull for the project slug.
 *
 * The Rust backend exposes project-scoped Tauri commands via `projectSyncApi`; this
 * component is the only frontend consumer. All state and handlers live
 * in useSyncSection; this file is JSX-only.
 */
import React from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import Select from "@src/components/Select";
import {
  SECTION_ACTION_GAP_CLASSES,
  SECTION_CONTROL_STYLE,
  SECTION_DESCRIPTION_CLASSES,
  SECTION_VALUE_TEXT_CLASSES,
  SectionContainer,
  SectionHeading,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";

import ConflictRowComponent from "./syncSection/ConflictRow";
import ImportPanel from "./syncSection/ImportPanel";
import ProblemRow from "./syncSection/ProblemRow";
import WebhookPanel from "./syncSection/WebhookPanel";
import { useSyncSection } from "./syncSection/useSyncSection";

export interface SyncSectionProps {
  /** Project slug — required for every projectSyncApi call. */
  slug: string;
}

const SyncSection: React.FC<SyncSectionProps> = ({ slug }) => {
  const { t } = useTranslation("projects");

  const {
    selectedAdapter,
    adapterOptions,
    accountOptions,
    selectedAccountId,
    setSelectedAccountId,
    pickerSelection,
    setPickerSelection,
    attachedAdapterId,
    isAttached,
    pickerMatchesAttached,
    attaching,
    detaching,
    forcePushing,
    forcePulling,
    lastForcePullError,
    problems,
    pendingRowAction,
    conflicts,
    pendingConflictAction,
    lastPullLabel,
    pendingCount,
    failedCount,
    abandonedCount,
    lastError,
    handleAttach,
    handleDetach,
    handleForcePush,
    handleForcePull,
    handleRetryEntry,
    handleDiscardEntry,
    handleUseLocal,
    handleUseRemote,
    handleDismissConflict,
  } = useSyncSection(slug);

  return (
    <SectionHeading title={t("settings.sync.title")}>
      <SectionContainer>
        <SectionRow
          label={t("settings.sync.title")}
          description={t("settings.sync.description")}
        >
          {null}
        </SectionRow>

        <SectionRow
          indent
          label={t("settings.sync.adapterPicker.title")}
          description={
            isAttached && !pickerMatchesAttached
              ? t("settings.sync.adapterPicker.changeWarning")
              : undefined
          }
        >
          <div className={SECTION_ACTION_GAP_CLASSES}>
            <Select
              value={pickerSelection ?? undefined}
              onChange={(next) => setPickerSelection(next as string)}
              options={adapterOptions}
              style={SECTION_CONTROL_STYLE}
              disabled={isAttached}
              placeholder={t("settings.sync.adapterPicker.notAttached")}
            />
            {isAttached ? (
              <Button
                variant="danger"
                appearance="outline"
                size="small"
                onClick={handleDetach}
                loading={detaching}
                disabled={detaching}
              >
                {t("settings.sync.adapterPicker.detach")}
              </Button>
            ) : (
              <Button
                variant="primary"
                size="small"
                onClick={handleAttach}
                loading={attaching}
                disabled={!pickerSelection || attaching || !selectedAccountId}
              >
                {t("settings.sync.adapterPicker.attach")}
              </Button>
            )}
          </div>
        </SectionRow>

        {selectedAdapter && (
          <SectionRow
            indent
            label={t("settings.sync.accountPicker.title")}
            description={t("settings.sync.accountPicker.previewNote")}
          >
            <Select
              value={selectedAccountId ?? undefined}
              onChange={(next) => setSelectedAccountId(next as string)}
              options={accountOptions}
              style={SECTION_CONTROL_STYLE}
              disabled={accountOptions.length === 0 || isAttached}
              placeholder={t("settings.sync.accountPicker.empty")}
            />
          </SectionRow>
        )}
      </SectionContainer>

      {selectedAdapter &&
        selectedAdapter.supports_webhook &&
        isAttached &&
        pickerMatchesAttached && (
          <SectionContainer title={t("settings.sync.webhook.title")}>
            <WebhookPanel
              key={`${selectedAdapter.id}:webhook`}
              slug={slug}
              adapter={selectedAdapter}
            />
          </SectionContainer>
        )}

      {selectedAdapter &&
        selectedAdapter.supports_import &&
        isAttached &&
        pickerMatchesAttached && (
          <SectionContainer title={t("settings.sync.import.title")}>
            <ImportPanel
              key={`${selectedAdapter.id}:import`}
              slug={slug}
              adapter={selectedAdapter}
            />
          </SectionContainer>
        )}

      <SectionContainer title={t("settings.sync.status.title")}>
        <SectionRow label={t("settings.sync.adapterPicker.title")}>
          <span className={SECTION_VALUE_TEXT_CLASSES}>
            {attachedAdapterId ?? t("settings.sync.adapterPicker.notAttached")}
          </span>
        </SectionRow>
        <SectionRow label={t("settings.sync.status.lastPull")}>
          <span className={SECTION_VALUE_TEXT_CLASSES}>{lastPullLabel}</span>
        </SectionRow>
        <SectionRow label={t("settings.sync.status.pending")}>
          <span className={SECTION_VALUE_TEXT_CLASSES}>{pendingCount}</span>
        </SectionRow>
        <SectionRow label={t("settings.sync.status.failed")}>
          <span
            className={
              failedCount > 0
                ? "text-[14px] font-semibold text-danger-6"
                : SECTION_VALUE_TEXT_CLASSES
            }
          >
            {failedCount}
          </span>
        </SectionRow>
        <SectionRow label={t("settings.sync.status.abandoned")}>
          <span
            className={
              abandonedCount > 0
                ? "text-[14px] font-semibold text-warning-6"
                : SECTION_VALUE_TEXT_CLASSES
            }
          >
            {abandonedCount}
          </span>
        </SectionRow>

        {lastError && (
          <SectionRow
            label={t("settings.sync.status.lastError")}
            layout="vertical"
          >
            <div className="rounded-lg bg-fill-2 px-3 py-2 text-[12px] wrap-break-word whitespace-pre-wrap text-text-3">
              {lastError}
            </div>
          </SectionRow>
        )}

        <SectionRow label="" indent showHeader={false}>
          <div className={SECTION_ACTION_GAP_CLASSES}>
            <Button
              size="small"
              onClick={handleForcePush}
              loading={forcePushing}
              disabled={!isAttached || forcePushing}
            >
              {t("settings.sync.status.forcePush")}
            </Button>
            <Button
              size="small"
              onClick={handleForcePull}
              loading={forcePulling}
              disabled={!isAttached || forcePulling}
            >
              {t("settings.sync.status.forcePull")}
            </Button>
          </div>
        </SectionRow>

        {lastForcePullError && (
          <SectionRow label="" indent showHeader={false}>
            <div className={`${SECTION_DESCRIPTION_CLASSES} text-danger-6`}>
              {t("settings.sync.errors.forcePullFailed", {
                error: lastForcePullError,
              })}
            </div>
          </SectionRow>
        )}
      </SectionContainer>

      {problems.length > 0 && (
        <SectionContainer title={t("settings.sync.problems.title")}>
          <SectionRow label="" showHeader={false} layout="vertical">
            <div className="flex flex-col gap-2">
              {problems.map((row) => (
                <ProblemRow
                  key={row.id}
                  row={row}
                  busy={
                    pendingRowAction?.id === row.id && pendingRowAction
                      ? { kind: pendingRowAction.kind }
                      : null
                  }
                  onRetry={handleRetryEntry}
                  onDiscard={handleDiscardEntry}
                />
              ))}
            </div>
          </SectionRow>
        </SectionContainer>
      )}

      {conflicts.length > 0 && (
        <SectionContainer title={t("settings.sync.conflicts.title")}>
          <SectionRow label="" showHeader={false} layout="vertical">
            <div className="flex flex-col gap-2">
              {conflicts.map((row) => (
                <ConflictRowComponent
                  key={row.id}
                  row={row}
                  busy={
                    pendingConflictAction?.id === row.id &&
                    pendingConflictAction
                      ? { kind: pendingConflictAction.kind }
                      : null
                  }
                  onUseLocal={handleUseLocal}
                  onUseRemote={handleUseRemote}
                  onDismiss={handleDismissConflict}
                />
              ))}
            </div>
          </SectionRow>
        </SectionContainer>
      )}
    </SectionHeading>
  );
};

export default SyncSection;
