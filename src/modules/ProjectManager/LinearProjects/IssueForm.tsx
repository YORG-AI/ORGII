import React from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import { Add01Icon, HugeiconsIcon } from "@src/icons";

import type { IssueDraft } from "./types";

interface IssueFormProps {
  draft: IssueDraft;
  saving: boolean;
  onDraftChange: (draft: IssueDraft) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

export const IssueForm: React.FC<IssueFormProps> = ({
  draft,
  saving,
  onDraftChange,
  onSubmit,
  onCancel,
}) => {
  const { t } = useTranslation(["projects", "common"]);
  return (
    <div className="space-y-3">
      <input
        value={draft.title}
        onChange={(event) =>
          onDraftChange({ ...draft, title: event.target.value })
        }
        placeholder={t("linearProjects.forms.issueTitle")}
        className="h-9 w-full rounded-lg border border-border-1 bg-bg-1 px-3 text-sm outline-none focus:border-primary-5"
      />
      <textarea
        value={draft.description}
        onChange={(event) =>
          onDraftChange({ ...draft, description: event.target.value })
        }
        placeholder={t("linearProjects.forms.description")}
        className="min-h-[80px] w-full resize-y rounded-lg border border-border-1 bg-bg-1 px-3 py-2 text-sm outline-none focus:border-primary-5"
      />
      <div className="flex justify-end gap-2">
        <Button
          size="small"
          variant="tertiary"
          appearance="ghost"
          onClick={onCancel}
        >
          {t("common:actions.cancel")}
        </Button>
        <Button
          size="small"
          variant="primary"
          appearance="solid"
          icon={<HugeiconsIcon icon={Add01Icon} data-icon="plus" size={14} />}
          loading={saving}
          disabled={!draft.title.trim()}
          onClick={onSubmit}
        >
          {t("linearProjects.createIssue")}
        </Button>
      </div>
    </div>
  );
};
