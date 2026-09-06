import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import type { ClaudeProviderProfile } from "@src/api/tauri/rpc/schemas/agentOrgs";
import Button from "@src/components/Button";
import Input from "@src/components/Input";
import Select from "@src/components/Select";
import {
  SECTION_CONTROL_STYLE,
  SECTION_DESCRIPTION_CLASSES,
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";

import ClaudeModelMappings from "./ClaudeModelMappings";
import {
  newClaudeProfile,
  useClaudeProfileEditor,
} from "./useClaudeProfileEditor";

export default function ClaudeProfileEditor({
  target,
  onAdd,
  onDirtyChange,
}: {
  target: ClaudeProviderProfile["target"];
  onAdd: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { t } = useTranslation("settings");
  const {
    view,
    loading,
    error,
    reload,
    draft,
    edit,
    busy,
    message,
    receipt,
    models,
    dirty,
    saved,
    act,
    cancel,
  } = useClaudeProfileEditor(target);
  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);
  const active = view?.appliedProfile;
  const disabled = busy !== null || loading;
  const choice = view?.choices.find((c) => c.keyId === draft?.keyId);
  const blocked =
    disabled ||
    !view?.installed ||
    !view.config.supported ||
    Boolean(
      view.config.conflict || view.configurationIssue || choice?.reason
    ) ||
    !choice;
  const valid = Boolean(
    draft?.name.trim() &&
    draft.keyId &&
    draft.endpoint &&
    Object.values(draft.models.roles).every((m) => m.model.trim())
  );
  return (
    <SectionContainer
      title={target === "claude_code" ? "Claude Code CLI" : "Claude Desktop"}
      dataTestId={`harness-connection-${target}`}
    >
      <SectionRow showHeader={false}>
        <div className="flex w-full flex-col gap-3">
          <p className={SECTION_DESCRIPTION_CLASSES}>
            {t(
              target === "claude_desktop"
                ? "harnessConnections.desktopScope"
                : "harnessConnections.scope"
            )}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={disabled || dirty}
              onClick={() =>
                edit(
                  newClaudeProfile(target, t("claudeProfiles.newName"), view)
                )
              }
            >
              {t("claudeProfiles.new")}
            </Button>
            <Button
              variant="secondary"
              disabled={
                disabled ||
                dirty ||
                view?.config.mode === "default" ||
                !view?.config.selectedKeyId ||
                view.config.conflict
              }
              onClick={() =>
                edit(
                  newClaudeProfile(
                    target,
                    t("claudeProfiles.copyName"),
                    view,
                    true
                  )
                )
              }
            >
              {t("claudeProfiles.copy")}
            </Button>
            <Button
              variant="secondary"
              disabled={disabled || dirty}
              onClick={onAdd}
            >
              {t("harnessConnections.add")}
            </Button>
            <Button
              variant="secondary"
              disabled={disabled}
              onClick={() => void reload()}
            >
              {t("harnessConnections.refresh")}
            </Button>
          </div>
          <p className={SECTION_DESCRIPTION_CLASSES}>
            {t("harnessConnections.current")}:{" "}
            {active?.name ??
              (view?.config.mode === "default"
                ? t("harnessConnections.original")
                : (view?.choices.find(
                    (c) => c.keyId === view.config.selectedKeyId
                  )?.name ?? t("harnessConnections.loading")))}
          </p>
          {!loading && !view?.profiles?.length && (
            <p className={SECTION_DESCRIPTION_CLASSES}>
              {t("claudeProfiles.empty")}
            </p>
          )}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {view?.profiles?.map((profile) => (
              <Button
                key={profile.id}
                variant={draft?.id === profile.id ? "primary" : "secondary"}
                appearance="outline"
                disabled={disabled || dirty}
                aria-pressed={draft?.id === profile.id}
                style={{ height: "auto" }}
                className="min-w-0 justify-start p-3 text-left"
                onClick={() => edit(profile)}
              >
                <span className="flex min-w-0 flex-col gap-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-medium">{profile.name}</span>
                    {active?.id === profile.id && (
                      <span className="text-xs text-primary-6">
                        {t(
                          active.revision === profile.revision
                            ? "claudeProfiles.active"
                            : "claudeProfiles.updatePending"
                        )}
                      </span>
                    )}
                  </span>
                  <span className="truncate text-xs text-text-2">
                    {profile.endpoint}
                  </span>
                </span>
              </Button>
            ))}
          </div>
        </div>
      </SectionRow>
      {(error ||
        view?.configurationIssue ||
        view?.config.message ||
        view?.config.conflict ||
        (view && !view.installed)) && (
        <SectionRow showHeader={false}>
          <p role="alert" className="text-sm text-warning-6">
            {error ??
              view?.configurationIssue ??
              view?.config.message ??
              t(
                view?.config.conflict
                  ? "harnessConnections.conflict"
                  : "harnessConnections.notInstalled"
              )}
          </p>
        </SectionRow>
      )}
      {draft && (
        <>
          {!loading && !choice && (
            <SectionRow showHeader={false}>
              <p role="alert" className="text-sm text-warning-6">
                {t("harnessConnections.missingKey")}
              </p>
            </SectionRow>
          )}
          <SectionRow label={t("claudeProfiles.name")}>
            <Input
              aria-label={t("claudeProfiles.name")}
              value={draft.name}
              maxLength={120}
              disabled={disabled}
              style={SECTION_CONTROL_STYLE}
              onChange={(name) => edit({ ...draft, name })}
            />
          </SectionRow>
          <SectionRow label={t("claudeProfiles.credential")}>
            <Select
              ariaLabel={t("claudeProfiles.credential")}
              value={draft.keyId || undefined}
              disabled={disabled}
              style={SECTION_CONTROL_STYLE}
              options={(view?.choices ?? []).map((c) => ({
                value: c.keyId,
                label: c.name,
                disabled: Boolean(c.reason),
              }))}
              onChange={(value) => {
                const choice = view?.choices.find((c) => c.keyId === value);
                edit({
                  ...draft,
                  keyId: String(value),
                  endpoint: draft.endpoint || choice?.endpoint || "",
                });
              }}
            />
          </SectionRow>
          {choice?.reason && (
            <SectionRow showHeader={false}>
              <p role="alert" className="text-sm text-warning-6">
                {choice.reason}
              </p>
            </SectionRow>
          )}
          <SectionRow label={t("harnessConnections.endpoint")}>
            <Input
              aria-label={t("harnessConnections.endpoint")}
              value={draft.endpoint}
              disabled={disabled}
              style={SECTION_CONTROL_STYLE}
              placeholder="https://gateway.example/anthropic"
              onChange={(endpoint) => edit({ ...draft, endpoint })}
            />
          </SectionRow>
          <SectionRow label={t("harnessConnections.authentication")}>
            <Select
              ariaLabel={t("harnessConnections.authentication")}
              value={draft.authScheme}
              disabled={disabled}
              style={SECTION_CONTROL_STYLE}
              options={[
                { value: "bearer", label: "Authorization: Bearer" },
                { value: "x-api-key", label: "x-api-key" },
              ]}
              onChange={(value) =>
                edit({
                  ...draft,
                  authScheme: value === "x-api-key" ? "x-api-key" : "bearer",
                })
              }
            />
          </SectionRow>
          <ClaudeModelMappings
            profile={draft}
            disabled={disabled}
            models={models}
            onChange={edit}
            onFetch={() => void act("fetch")}
          />
          <SectionRow showHeader={false}>
            <div className="flex w-full flex-col gap-3">
              <p className={SECTION_DESCRIPTION_CLASSES}>
                {t("claudeProfiles.activationHelp")}
              </p>
              {dirty && (
                <p role="status" className={SECTION_DESCRIPTION_CLASSES}>
                  {t("claudeProfiles.unsaved")}
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={disabled || !dirty || !valid}
                  onClick={() => void act("save")}
                >
                  {t("claudeProfiles.save")}
                </Button>
                <Button
                  variant="secondary"
                  disabled={blocked || dirty || !valid}
                  loading={busy === "test"}
                  onClick={() => void act("test")}
                >
                  {t("claudeProfiles.test")}
                </Button>
                <Button
                  disabled={blocked || dirty || !valid || !receipt}
                  loading={busy === "apply"}
                  onClick={() => void act("apply")}
                >
                  {t("harnessConnections.apply")}
                </Button>
                <Button
                  variant="secondary"
                  disabled={disabled}
                  onClick={() => edit(saved ?? null)}
                >
                  {t("claudeProfiles.discard")}
                </Button>
                <Button
                  variant="secondary"
                  disabled={
                    disabled || dirty || !saved || active?.id === draft.id
                  }
                  onClick={() => void act("delete")}
                >
                  {t("claudeProfiles.delete")}
                </Button>
              </div>
            </div>
          </SectionRow>
        </>
      )}
      <SectionRow showHeader={false}>
        <div className="flex flex-wrap gap-2">
          {(busy === "test" || busy === "fetch") && (
            <Button variant="secondary" onClick={cancel}>
              {t("harnessConnections.cancel")}
            </Button>
          )}
          <Button
            variant="secondary"
            disabled={
              disabled ||
              !view ||
              view.config.mode === "default" ||
              view.config.conflict ||
              Boolean(view.configurationIssue)
            }
            onClick={() => void act("restore")}
          >
            {t("harnessConnections.restore")}
          </Button>
        </div>
      </SectionRow>
      {message && (
        <SectionRow showHeader={false}>
          <p
            role="status"
            aria-live="polite"
            className={SECTION_DESCRIPTION_CLASSES}
          >
            {message}
          </p>
        </SectionRow>
      )}
    </SectionContainer>
  );
}
