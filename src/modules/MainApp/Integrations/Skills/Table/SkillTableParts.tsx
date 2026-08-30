import type { TFunction } from "i18next";

import { SETTINGS_TABLE_CELL } from "@src/components/SettingsTable";
import type { CursorRepo } from "@src/hooks/policies";
import { CodeIcon, Home01Icon, HugeiconsIcon, UserIcon } from "@src/icons";
import { SKILL_SOURCE } from "@src/types/extensions";

import {
  getSkillResolvedSourceLabel,
  getSkillStorageLocationLabel,
  isRepoSkill,
} from "../skillSourceLabel";

export interface SkillTableRow {
  name: string;
  path: string;
  source: string;
  description: string;
  available: boolean;
  enabled: boolean;
}

interface SkillCellProps<TSkill extends SkillTableRow> {
  skill: TSkill;
}

interface SkillSourceCellProps<
  TSkill extends SkillTableRow,
> extends SkillCellProps<TSkill> {
  t: TFunction;
  cursorRepos?: CursorRepo[];
}

function renderSourceIcon<TSkill extends SkillTableRow>(
  skill: TSkill,
  cursorRepos?: CursorRepo[]
) {
  const className = "shrink-0 text-text-3";
  if (skill.source === SKILL_SOURCE.EMBEDDED_BUILTIN) {
    return (
      <HugeiconsIcon
        icon={Home01Icon}
        data-icon="home"
        size={14}
        className={className}
        aria-hidden
      />
    );
  }
  if (isRepoSkill(skill, cursorRepos)) {
    return (
      <HugeiconsIcon
        icon={CodeIcon}
        data-icon="code-2"
        size={14}
        className={className}
        aria-hidden
      />
    );
  }
  return (
    <HugeiconsIcon
      icon={UserIcon}
      data-icon="user"
      size={14}
      className={className}
      aria-hidden
    />
  );
}

export function SkillNameCell<TSkill extends SkillTableRow>({
  skill,
}: SkillCellProps<TSkill>) {
  return (
    <span className={`${SETTINGS_TABLE_CELL.primary} font-bold`}>
      {skill.name}
    </span>
  );
}

export function SkillSourceCell<TSkill extends SkillTableRow>({
  skill,
  t,
  cursorRepos,
}: SkillSourceCellProps<TSkill>) {
  return (
    <span
      className={`${SETTINGS_TABLE_CELL.value} inline-flex items-center gap-2 whitespace-nowrap`}
    >
      {renderSourceIcon(skill, cursorRepos)}
      <span>{getSkillResolvedSourceLabel(t, skill, cursorRepos)}</span>
    </span>
  );
}

export function SkillStorageCell<TSkill extends SkillTableRow>({
  skill,
  t,
  cursorRepos,
}: SkillSourceCellProps<TSkill>) {
  return (
    <span className={`${SETTINGS_TABLE_CELL.value} whitespace-nowrap`}>
      {getSkillStorageLocationLabel(t, skill, cursorRepos)}
    </span>
  );
}
