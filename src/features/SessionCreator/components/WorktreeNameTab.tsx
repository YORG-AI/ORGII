import { CaseSensitive } from "lucide-react";
import { useTranslation } from "react-i18next";

import { DROPDOWN_ITEM } from "@src/components/Dropdown/tokens";
import Input from "@src/components/Input";
import type { WorktreeLaunchSource } from "@src/store/session/worktreeLaunchSourceAtom";

import {
  WorktreeSourceList,
  WorktreeSourceRow,
} from "./WorktreeSourceModalRows";

const NAME_INPUT_ID = "worktree-source-name-input";

export function WorktreeNameTab({
  value,
  source,
  selected,
  onChange,
  onSelect,
}: {
  value: string;
  source: WorktreeLaunchSource | null;
  selected: boolean;
  onChange: (value: string) => void;
  onSelect: (source: WorktreeLaunchSource) => void;
}) {
  const { t } = useTranslation("sessions");
  return (
    <div className="flex min-h-[250px] flex-col gap-2">
      <label
        htmlFor={NAME_INPUT_ID}
        className="text-[12px] font-medium text-text-3"
      >
        {t("creator.worktreeSource.worktreeLabel", {
          defaultValue: "Worktree label",
        })}
      </label>
      <Input
        id={NAME_INPUT_ID}
        value={value}
        onChange={onChange}
        prefix={
          <CaseSensitive size={DROPDOWN_ITEM.iconSize} strokeWidth={1.75} />
        }
        placeholder={t("creator.worktreeSource.namePlaceholder", {
          defaultValue: "feature-name",
        })}
      />
      {source && (
        <WorktreeSourceList>
          <div className="flex flex-col gap-0.5">
            <WorktreeSourceRow
              icon={<CaseSensitive size={14} strokeWidth={1.75} />}
              title={source.title ?? source.label}
              detail={
                source.baseBranch ? `Base: ${source.baseBranch}` : "Base: HEAD"
              }
              selected={selected}
              onClick={() => onSelect(source)}
            />
          </div>
        </WorktreeSourceList>
      )}
    </div>
  );
}
