import type { TFunction } from "i18next";
import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import type { ScopeQuotaView } from "@src/features/Org2Cloud/org2CloudScopeQuota";
import RepoScopePicker from "@src/features/TeamCollaboration/components/RepoScopePicker";
import {
  SECTION_DESCRIPTION_CLASSES,
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";

interface CloudOrgRepoScopesSectionProps {
  t: TFunction<"navigation">;
  isAdmin: boolean;
  savedScopes: string[];
  draftScopes: string[];
  setDraftScopes: React.Dispatch<React.SetStateAction<string[]>>;
  scopesDirty: boolean;
  scopeQuota: ScopeQuotaView | null;
  savingScopes: boolean;
  scopesSaved: boolean;
  scopesError: string | null;
  onSaveScopes: () => Promise<void>;
  openCloudBillingPage: () => void;
}

/** General-tab section for admin scope editing and member read-only inventory. */
export function CloudOrgRepoScopesSection({
  t,
  isAdmin,
  savedScopes,
  draftScopes,
  setDraftScopes,
  scopesDirty,
  scopeQuota,
  savingScopes,
  scopesSaved,
  scopesError,
  onSaveScopes,
  openCloudBillingPage,
}: CloudOrgRepoScopesSectionProps) {
  const { t: tCommon } = useTranslation("common");
  const [isAddingScope, setIsAddingScope] = useState(false);
  const handleScopeChange = (keys: string[]) => {
    setDraftScopes(keys);
    setIsAddingScope(false);
  };
  const savedScopeSet = useMemo(() => new Set(savedScopes), [savedScopes]);
  const draftScopeSet = useMemo(() => new Set(draftScopes), [draftScopes]);
  const displayedAdminScopes = useMemo(
    () => [
      ...savedScopes,
      ...draftScopes.filter((scope) => !savedScopeSet.has(scope)),
    ],
    [draftScopes, savedScopeSet, savedScopes]
  );

  const coolingRows =
    scopeQuota && scopeQuota.coolingRows.length > 0
      ? scopeQuota.coolingRows.map((row) => (
          <SectionRow
            key={row.scopeKey}
            dataTestId="cloud-org-cooling-scope"
            label={<span title={row.scopeKey}>{row.scopeKey}</span>}
            truncateLabel
            light
          >
            <span className="text-[12px] text-text-3">
              {t("cloud.orgPanel.scopeCoolingRow", { days: row.daysLeft })}
            </span>
          </SectionRow>
        ))
      : null;

  return (
    <div className="flex flex-col gap-2">
      <SectionContainer
        dataTestId="cloud-org-repo-scope"
        title={
          scopeQuota
            ? `${t("cloud.orgPanel.repoScopesTitle")} · ${scopeQuota.counterLabel}`
            : t("cloud.orgPanel.repoScopesTitle")
        }
      >
        {isAdmin ? (
          <>
            {displayedAdminScopes.length === 0 && !coolingRows ? (
              <SectionRow label={t("cloud.orgPanel.repoScopesEmpty")} light />
            ) : (
              displayedAdminScopes.map((path) => {
                const pendingAdd =
                  draftScopeSet.has(path) && !savedScopeSet.has(path);
                const pendingRemoval =
                  savedScopeSet.has(path) && !draftScopeSet.has(path);
                const pending = pendingAdd || pendingRemoval;
                return (
                  <SectionRow
                    key={path}
                    label={
                      <span
                        className={
                          pendingRemoval ? "text-text-3 line-through" : ""
                        }
                        title={path}
                      >
                        {path}
                      </span>
                    }
                    truncateLabel
                    align="center"
                  >
                    <div className="flex items-center gap-2">
                      {pending ? (
                        <span
                          className="text-[12px] text-warning-6"
                          data-testid="cloud-org-repo-scope-row-unsaved"
                        >
                          {tCommon("placeholders.unsavedEdits")}
                        </span>
                      ) : null}
                      <Button
                        htmlType="button"
                        size="default"
                        variant="secondary"
                        disabled={savingScopes}
                        data-testid={
                          pendingRemoval
                            ? "cloud-org-undo-repo-scope-removal"
                            : pendingAdd
                              ? "cloud-org-cancel-repo-scope-addition"
                              : "cloud-org-remove-repo-scope"
                        }
                        onClick={() =>
                          setDraftScopes((current) =>
                            pendingRemoval
                              ? [
                                  ...savedScopes.filter(
                                    (scope) =>
                                      scope === path || current.includes(scope)
                                  ),
                                  ...current.filter(
                                    (scope) => !savedScopeSet.has(scope)
                                  ),
                                ]
                              : current.filter((scope) => scope !== path)
                          )
                        }
                      >
                        {pendingRemoval
                          ? tCommon("actions.undo")
                          : pendingAdd
                            ? tCommon("actions.cancel")
                            : t("cloud.orgPanel.removeRepoScope")}
                      </Button>
                    </div>
                  </SectionRow>
                );
              })
            )}
            {coolingRows}
            <SectionRow showHeader={false}>
              <div className="flex w-full flex-col gap-3">
                <div className="flex w-full flex-wrap items-center justify-between gap-2">
                  {!isAddingScope ? (
                    <Button
                      htmlType="button"
                      size="default"
                      variant="secondary"
                      disabled={savingScopes || Boolean(scopeQuota?.atCap)}
                      data-testid="cloud-org-add-repo-scope"
                      aria-expanded={false}
                      onClick={() => setIsAddingScope(true)}
                    >
                      {tCommon("actions.add")}
                    </Button>
                  ) : (
                    <Button
                      htmlType="button"
                      size="default"
                      variant="secondary"
                      disabled={savingScopes}
                      data-testid="cloud-org-cancel-add-repo-scope"
                      onClick={() => setIsAddingScope(false)}
                    >
                      {tCommon("actions.cancel")}
                    </Button>
                  )}
                  {scopesDirty ? (
                    <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
                      {scopesError ? (
                        <span className="text-[12px] text-danger-6">
                          {scopesError}
                        </span>
                      ) : (
                        <span
                          className="text-[12px] text-warning-6"
                          data-testid="cloud-org-repo-scopes-unsaved"
                        >
                          {tCommon("placeholders.unsavedEdits")}
                        </span>
                      )}
                      <Button
                        htmlType="button"
                        size="default"
                        variant="secondary"
                        disabled={savingScopes}
                        data-testid="cloud-org-cancel-repo-scopes"
                        onClick={() => {
                          setDraftScopes([...savedScopes]);
                          setIsAddingScope(false);
                        }}
                      >
                        {tCommon("actions.cancel")}
                      </Button>
                      <Button
                        htmlType="button"
                        size="default"
                        variant="primary"
                        onClick={() => void onSaveScopes()}
                        disabled={savingScopes}
                        loading={savingScopes}
                        data-testid="cloud-org-save-repo-scopes"
                      >
                        {t("cloud.orgPanel.saveRepoScopes")}
                      </Button>
                    </div>
                  ) : scopesSaved ? (
                    <span className="ml-auto text-[12px] text-success-6">
                      {t("cloud.orgPanel.repoScopesSaved")}
                    </span>
                  ) : null}
                </div>
                {isAddingScope ? (
                  <RepoScopePicker
                    selectedKeys={draftScopes}
                    onChange={handleScopeChange}
                    addOnly
                    disabled={savingScopes || Boolean(scopeQuota?.atCap)}
                  />
                ) : null}
              </div>
            </SectionRow>
            {scopeQuota?.atCap ? (
              <SectionRow showHeader={false}>
                <div
                  className="flex flex-wrap items-center gap-2 rounded-lg bg-warning-1 px-3 py-2 text-[12px] text-warning-6"
                  data-testid="cloud-org-scope-cap-upgrade"
                >
                  <span>
                    {t("cloud.orgPanel.scopeCapReached", {
                      used: scopeQuota.used,
                      cap: scopeQuota.cap,
                    })}
                  </span>
                  <Button
                    htmlType="button"
                    size="default"
                    variant="warning"
                    appearance="ghost"
                    onClick={openCloudBillingPage}
                    data-testid="cloud-org-scope-cap-upgrade-link"
                  >
                    {t("cloud.orgPanel.upgrade")}
                  </Button>
                </div>
              </SectionRow>
            ) : null}
          </>
        ) : (
          <>
            {savedScopes.length === 0 && !coolingRows ? (
              <SectionRow label={t("cloud.orgPanel.repoScopesEmpty")} light />
            ) : (
              savedScopes.map((path) => (
                <SectionRow
                  key={path}
                  label={<span title={path}>{path}</span>}
                  truncateLabel
                />
              ))
            )}
            {coolingRows}
          </>
        )}
      </SectionContainer>
      <p
        className={`m-0 px-1 ${SECTION_DESCRIPTION_CLASSES}`}
        data-testid="cloud-org-repo-scopes-note"
      >
        {t("cloud.orgPanel.repoScopesHelp")}
      </p>
    </div>
  );
}

export default CloudOrgRepoScopesSection;
