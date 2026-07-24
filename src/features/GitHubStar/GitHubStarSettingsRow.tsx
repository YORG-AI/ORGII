import { useSetAtom } from "jotai";
import { Check, ExternalLink, Star } from "lucide-react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import {
  SECTION_ACTION_GAP_CLASSES,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";

import { type GitHubStarSource } from "./constants";
import { githubStarPromptSettingsAtom } from "./promptSettings";
import { useGitHubStarController } from "./useGitHubStarController";

export interface GitHubStarSettingsRowProps {
  source?: GitHubStarSource;
  onConfirmedStarred?: () => void;
}

export function GitHubStarSettingsRow({
  source = "settings",
  onConfirmedStarred,
}: GitHubStarSettingsRowProps) {
  const { t } = useTranslation("settings");
  const updatePromptSettings = useSetAtom(githubStarPromptSettingsAtom);
  const handleConfirmedStarred = () => {
    updatePromptSettings({ completed: true, deferredUntil: 0 });
    onConfirmedStarred?.();
  };
  const { state, confirmStar, openFallback } = useGitHubStarController({
    source,
    onConfirmedStarred: handleConfirmedStarred,
  });

  const statusText = (() => {
    switch (state.status) {
      case "loading":
        return t("general.githubStar.loading");
      case "not-starred":
        return t("general.githubStar.star");
      case "starring":
        return t("general.githubStar.starring");
      case "starred":
        return t("general.githubStar.thanks");
      case "web-fallback": {
        const reasonKeys = {
          gh_missing: "unavailableGhMissing",
          not_authenticated: "unavailableNotAuthenticated",
          network: "unavailableNetwork",
          permission: "unavailablePermission",
          timeout: "unavailableTimeout",
          unexpected: "unavailableUnexpected",
        } as const;
        return t(`general.githubStar.${reasonKeys[state.reason]}`);
      }
      case "error":
        return t("general.githubStar.unavailableUnexpected");
    }
  })();
  const isBusy = state.status === "loading" || state.status === "starring";

  let action = null;
  if (state.status === "not-starred") {
    action = (
      <Button
        variant="primary"
        size="small"
        icon={<Star size={14} aria-hidden="true" />}
        onClick={() => void confirmStar()}
      >
        {t("general.githubStar.star")}
      </Button>
    );
  } else if (state.status === "web-fallback") {
    action = (
      <Button
        variant="secondary"
        size="small"
        icon={<ExternalLink size={14} aria-hidden="true" />}
        onClick={() => void openFallback()}
      >
        {t("general.githubStar.openGitHub")}
      </Button>
    );
  } else if (state.status === "error") {
    action = (
      <Button
        variant="secondary"
        size="small"
        icon={<ExternalLink size={14} aria-hidden="true" />}
        onClick={() => void openFallback()}
      >
        {t("general.githubStar.openGitHub")}
      </Button>
    );
  } else if (state.status === "starred") {
    action = (
      <span className="flex items-center gap-1 text-sm text-success-6">
        <Check size={14} aria-hidden="true" />
        {t("general.githubStar.thanks")}
      </span>
    );
  } else {
    action = (
      <Button size="small" loading disabled aria-label={statusText}>
        {statusText}
      </Button>
    );
  }

  return (
    <SectionRow
      label={t("general.githubStar.label")}
      description={t("general.githubStar.description")}
    >
      <div className={SECTION_ACTION_GAP_CLASSES}>
        <span
          className="sr-only"
          role="status"
          aria-live="polite"
          aria-busy={isBusy}
        >
          {statusText}
        </span>
        {action}
      </div>
    </SectionRow>
  );
}
