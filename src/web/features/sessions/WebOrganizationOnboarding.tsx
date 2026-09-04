import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import Input from "@src/components/Input";
import Message from "@src/components/Message";
import { cloudManagementErrorMessage } from "@src/features/Org2Cloud/org2CloudOrgManagement";
import {
  CloudOrgMembershipActionFailure,
  useCloudOrgMembershipActions,
} from "@src/features/Org2Cloud/useCloudOrgMembershipActions";
import { Building02Icon, HugeiconsIcon } from "@src/icons";

type OrganizationMode = "create" | "join";

function membershipActionErrorMessage(
  error: unknown,
  translate: (key: string) => string
): string {
  if (error instanceof CloudOrgMembershipActionFailure) {
    if (error.code === "invalid_invite") {
      return translate("cloud.orgManagement.errors.inviteInvalid");
    }
    if (error.code === "session_expired") {
      return translate("cloud.sessionExpired");
    }
    return translate("cloud.orgPanel.loadError");
  }
  return cloudManagementErrorMessage(error, translate);
}

/** First-use organization boundary for an authoritatively empty Web roster. */
export function WebOrganizationOnboarding({
  refreshError,
  onRetry,
}: {
  refreshError?: string | null;
  onRetry?: () => void;
}) {
  const { t } = useTranslation("navigation");
  const { createOrganization, joinOrganization } =
    useCloudOrgMembershipActions();
  const [mode, setMode] = useState<OrganizationMode>("create");
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const submittingRef = useRef(false);

  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    []
  );

  const trimmedValue = value.trim();
  const inputLabel =
    mode === "create"
      ? t("collaboration.orgName")
      : t("collaboration.inviteCode");
  const submitLabel =
    mode === "create"
      ? t("web.sessionsPage.createOrganization")
      : t("web.sessionsPage.joinOrganization");
  const placeholder =
    mode === "create"
      ? t("web.sessionsPage.organizationNamePlaceholder")
      : t("web.sessionsPage.invitePlaceholder");

  const modeOptions = useMemo(
    () =>
      [
        {
          value: "create" as const,
          label: t("web.sessionsPage.createOrganization"),
        },
        {
          value: "join" as const,
          label: t("web.sessionsPage.joinOrganization"),
        },
      ] satisfies Array<{ value: OrganizationMode; label: string }>,
    [t]
  );

  const selectMode = useCallback((nextMode: OrganizationMode) => {
    setMode(nextMode);
    setValue("");
    setError(null);
  }, []);

  const submit = useCallback(async () => {
    if (!trimmedValue || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      if (mode === "create") {
        await createOrganization(trimmedValue);
        Message.success(t("cloud.orgManagement.create.createdToast"));
      } else {
        const joined = await joinOrganization(trimmedValue);
        Message.success(
          t("cloud.orgManagement.join.joinedToast", { org: joined.name })
        );
      }
    } catch (caught) {
      if (mountedRef.current) {
        setError(membershipActionErrorMessage(caught, t));
      }
    } finally {
      submittingRef.current = false;
      if (mountedRef.current) setSubmitting(false);
    }
  }, [createOrganization, joinOrganization, mode, t, trimmedValue]);

  return (
    <main className="flex h-full items-center justify-center bg-workstation-bg p-6">
      <section
        className="flex w-full max-w-md flex-col items-center gap-4 rounded-xl border border-border-2 bg-bg-1 p-6 text-center shadow-sm"
        aria-labelledby="web-organization-onboarding-title"
        data-testid="web-organization-onboarding"
      >
        <HugeiconsIcon
          icon={Building02Icon}
          data-icon="building-2"
          size={28}
          className="text-text-3"
          aria-hidden
        />
        <div>
          <h1
            id="web-organization-onboarding-title"
            className="text-base font-medium text-text-1"
          >
            {t("web.sessionsPage.organizationSetupTitle")}
          </h1>
          <p className="mt-1 text-sm text-text-3">
            {t("web.sessionsPage.organizationSetupHint")}
          </p>
        </div>

        <div
          className="flex w-full gap-2"
          role="group"
          aria-label={t("web.sessionsPage.organizationModeLabel")}
        >
          {modeOptions.map((option) => (
            <Button
              key={option.value}
              long
              size="small"
              variant={mode === option.value ? "primary" : "secondary"}
              appearance={mode === option.value ? "solid" : "outline"}
              disabled={submitting}
              aria-pressed={mode === option.value}
              onClick={() => selectMode(option.value)}
              data-testid={`web-organization-mode-${option.value}`}
            >
              {option.label}
            </Button>
          ))}
        </div>

        {refreshError ? (
          <div
            className="flex w-full items-center gap-3 rounded-lg border border-warning-3 bg-warning-1 px-3 py-2 text-left text-sm text-text-2"
            role="alert"
            data-testid="web-organization-refresh-error"
          >
            <span className="min-w-0 flex-1">{refreshError}</span>
            {onRetry ? (
              <Button size="small" onClick={onRetry}>
                {t("web.sessionsPage.retry")}
              </Button>
            ) : null}
          </div>
        ) : null}

        <form
          className="flex w-full flex-col gap-3 text-left"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label
            className="text-sm font-medium text-text-2"
            htmlFor="web-organization-input"
          >
            {inputLabel}
          </label>
          <Input
            id="web-organization-input"
            value={value}
            onChange={setValue}
            placeholder={placeholder}
            disabled={submitting}
            autoComplete="off"
            data-testid="web-organization-input"
          />
          {error ? (
            <div
              className="rounded-lg border border-danger-2 bg-danger-1 px-3 py-2 text-sm text-danger-6"
              role="alert"
              data-testid="web-organization-error"
            >
              {error}
            </div>
          ) : null}
          <Button
            htmlType="submit"
            variant="primary"
            long
            loading={submitting}
            disabled={submitting || !trimmedValue}
            data-testid="web-organization-submit"
          >
            {submitLabel}
          </Button>
        </form>
      </section>
    </main>
  );
}
