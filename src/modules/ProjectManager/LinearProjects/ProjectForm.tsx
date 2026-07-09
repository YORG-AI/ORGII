import { Save } from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";

import type { LinearTeamSummary } from "@src/api/http/integrations";
import Button from "@src/components/Button";
import Select from "@src/components/Select";
import Textarea from "@src/components/Textarea";

import type { ProjectDraft } from "./types";

interface ProjectFormProps {
  draft: ProjectDraft;
  teams: LinearTeamSummary[];
  saving: boolean;
  submitLabel: string;
  hideTeamSelect?: boolean;
  onDraftChange: (draft: ProjectDraft) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

export const ProjectForm: React.FC<ProjectFormProps> = ({
  draft,
  teams,
  saving,
  submitLabel,
  hideTeamSelect = false,
  onDraftChange,
  onSubmit,
  onCancel,
}) => {
  const { t } = useTranslation(["projects", "common"]);
  return (
    <div className="mt-4 space-y-3">
      <input
        value={draft.name}
        onChange={(event) =>
          onDraftChange({ ...draft, name: event.target.value })
        }
        placeholder={t("linearProjects.forms.projectName")}
        className="h-9 w-full rounded-lg border border-border-1 bg-bg-1 px-3 text-sm outline-none focus:border-primary-5"
      />
      <Textarea
        value={draft.description}
        onChange={(value) => onDraftChange({ ...draft, description: value })}
        placeholder={t("linearProjects.forms.description")}
        autoSize={{ minRows: 4 }}
        className="w-full"
      />
      {!hideTeamSelect && (
        <Select
          value={draft.teamId}
          options={teams.map((team) => ({
            value: team.id,
            label: `${team.name} (${team.key})`,
          }))}
          onChange={(value) =>
            onDraftChange({ ...draft, teamId: value as string })
          }
          className="w-full"
          dropdownWidthMode="match"
        />
      )}
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
          icon={<Save size={14} />}
          loading={saving}
          disabled={!draft.name.trim() || (!hideTeamSelect && !draft.teamId)}
          onClick={onSubmit}
        >
          {submitLabel}
        </Button>
      </div>
    </div>
  );
};
