import { useTranslation } from "react-i18next";

import { DROPDOWN_ITEM } from "@src/components/Dropdown/tokens";
import Input from "@src/components/Input";
import { CaseSensitiveIcon, HugeiconsIcon } from "@src/icons";
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
    <div className="flex min-h-72 flex-col gap-2">
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
          <HugeiconsIcon
            icon={CaseSensitiveIcon}
            data-icon="case-sensitive"
            size={DROPDOWN_ITEM.iconSize}
            strokeWidth={1.75}
          />
        }
        placeholder={t("creator.worktreeSource.namePlaceholder", {
          defaultValue: "feature-name",
        })}
      />
      {source && (
        <WorktreeSourceList>
          <div className="flex flex-col gap-px">
            <WorktreeSourceRow
              icon={
                <HugeiconsIcon
                  icon={CaseSensitiveIcon}
                  data-icon="case-sensitive"
                  size={14}
                  strokeWidth={1.75}
                />
              }
              title={source.title ?? source.label}
              detail={
                source.baseBranch
                  ? t("creator.worktreeSource.nameBase", {
                      branch: source.baseBranch,
                      defaultValue: `Base: ${source.baseBranch}`,
                    })
                  : t("creator.worktreeSource.nameBaseHead", {
                      defaultValue: "Base: HEAD",
                    })
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
