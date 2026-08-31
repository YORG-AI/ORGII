/**
 * Lead, Members, Teams, Labels, and Linked Repos field rows.
 * Extracted to keep ProjectPropertyFields under the UI line limit.
 */
import React from "react";

import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
} from "@src/components/Dropdown/tokens";
import PersonAvatar from "@src/components/PersonAvatar";
import {
  FieldRow,
  type FieldRowVariant,
  Option,
  SearchableDropdown,
} from "@src/components/PropertyField/PropertyFieldEditable";
import {
  Airplane01Icon,
  CodeXmlIcon,
  HugeiconsIcon,
  Tag01Icon,
  UserIcon,
  UserMultipleIcon,
} from "@src/icons";

import type {
  Label,
  LinkedRepoOption,
  Person,
  PickerType,
  ProjectData,
  ProjectPropertyFieldKey,
  Team,
} from "../types";

export interface PeopleTeamsLabelsFieldsProps {
  project: ProjectData;
  openPicker: PickerType;
  togglePicker: (key: PickerType) => void;
  availableMembers: Person[];
  availableTeams: Team[];
  availableLabels: Label[];
  availableRepos: LinkedRepoOption[] | undefined;
  handleLeadChange: (person: Person | undefined) => void;
  handleMemberToggle: (person: Person) => void;
  handleTeamToggle: (team: Team) => void;
  handleLabelToggle: (label: Label) => void;
  handleLinkedRepoToggle: (repo: LinkedRepoOption) => void;
  linkedRepoLabel: string;
  linkedRepoCount: number;
  t: (key: string, opts?: Record<string, unknown>) => string;
  fieldVariant?: FieldRowVariant;
  visibleFields: Set<ProjectPropertyFieldKey>;
  showLabels?: boolean;
}

const PeopleTeamsLabelsFields: React.FC<PeopleTeamsLabelsFieldsProps> = ({
  project,
  openPicker,
  togglePicker,
  availableMembers,
  availableTeams,
  availableLabels,
  availableRepos,
  handleLeadChange,
  handleMemberToggle,
  handleTeamToggle,
  handleLabelToggle,
  handleLinkedRepoToggle,
  linkedRepoLabel,
  linkedRepoCount,
  t,
  fieldVariant = "row",
  visibleFields,
  showLabels = true,
}) => (
  <>
    {/* Lead */}
    {(visibleFields.has("lead") || openPicker === "lead") && (
      <div
        className={
          fieldVariant === "pill"
            ? "relative flex min-h-7 min-w-0 max-w-[220px] items-center"
            : "relative flex min-h-[36px] w-full items-center"
        }
      >
        <FieldRow
          icon={
            project.lead ? (
              <PersonAvatar
                size={DROPDOWN_ITEM.iconSize}
                name={project.lead.name}
                src={project.lead.avatar}
                color={project.lead.color}
              />
            ) : (
              <HugeiconsIcon
                icon={UserIcon}
                data-icon="user"
                size={DROPDOWN_ITEM.iconSize}
              />
            )
          }
          label={showLabels ? t("properties.lead") : undefined}
          value={project.lead?.name || t("properties.addLead")}
          isSelected={!!project.lead}
          isActive={openPicker === "lead"}
          variant={fieldVariant}
          onClick={() => togglePicker("lead")}
        />
        {openPicker === "lead" && (
          <SearchableDropdown
            placeholder={t("common:actions.search")}
            widthMode={fieldVariant === "pill" ? "menu" : "match-parent"}
            align={fieldVariant === "pill" ? "auto" : "left"}
          >
            {(searchQuery) => {
              const filtered = searchQuery
                ? availableMembers.filter((person) =>
                    person.name
                      .toLowerCase()
                      .includes(searchQuery.toLowerCase())
                  )
                : availableMembers;
              return (
                <>
                  {!searchQuery && (
                    <Option
                      icon={
                        <HugeiconsIcon
                          icon={UserIcon}
                          data-icon="user"
                          size={DROPDOWN_ITEM.iconSize}
                        />
                      }
                      label={t("properties.noLead")}
                      onClick={() => handleLeadChange(undefined)}
                    />
                  )}
                  {filtered.map((person) => (
                    <Option
                      key={person.id}
                      isSelected={project.lead?.id === person.id}
                      label={person.name}
                      onClick={() => handleLeadChange(person)}
                    >
                      <PersonAvatar
                        size={DROPDOWN_ITEM.iconSize}
                        name={person.name}
                        src={person.avatar}
                        color={person.color}
                      />
                      <span className="flex-1 truncate">{person.name}</span>
                    </Option>
                  ))}
                </>
              );
            }}
          </SearchableDropdown>
        )}
      </div>
    )}

    {/* Members */}
    {(visibleFields.has("members") || openPicker === "members") && (
      <div
        className={
          fieldVariant === "pill"
            ? "relative flex min-h-7 min-w-0 max-w-[220px] items-center"
            : "relative flex min-h-[36px] w-full items-center"
        }
      >
        <FieldRow
          icon={
            <HugeiconsIcon
              icon={UserMultipleIcon}
              data-icon="users"
              size={DROPDOWN_ITEM.iconSize}
            />
          }
          label={showLabels ? t("properties.members") : undefined}
          value={
            project.members && project.members.length > 0
              ? t("properties.memberCount", { count: project.members.length })
              : t("properties.addMembers")
          }
          isSelected={!!project.members && project.members.length > 0}
          isActive={openPicker === "members"}
          showChevron
          variant={fieldVariant}
          onClick={() => togglePicker("members")}
        />
        {openPicker === "members" && (
          <SearchableDropdown
            placeholder={t("common:actions.search")}
            widthMode={fieldVariant === "pill" ? "menu" : "match-parent"}
            align={fieldVariant === "pill" ? "auto" : "left"}
          >
            {(searchQuery) => {
              const filtered = searchQuery
                ? availableMembers.filter((person) =>
                    person.name
                      .toLowerCase()
                      .includes(searchQuery.toLowerCase())
                  )
                : availableMembers;
              return filtered.map((person) => {
                const isSelected = project.members?.some(
                  (item) => item.id === person.id
                );
                return (
                  <Option
                    key={person.id}
                    isSelected={isSelected}
                    label={person.name}
                    onClick={() => handleMemberToggle(person)}
                  >
                    <PersonAvatar
                      size={DROPDOWN_ITEM.iconSize}
                      name={person.name}
                      src={person.avatar}
                      color={person.color}
                    />
                    <span className="flex-1 truncate">{person.name}</span>
                  </Option>
                );
              });
            }}
          </SearchableDropdown>
        )}
      </div>
    )}

    {/* Teams */}
    {(visibleFields.has("teams") || openPicker === "teams") && (
      <div
        className={
          fieldVariant === "pill"
            ? "relative flex min-h-7 min-w-0 max-w-[220px] items-center"
            : "relative flex min-h-[36px] w-full items-center"
        }
      >
        <FieldRow
          icon={
            <HugeiconsIcon
              icon={Airplane01Icon}
              data-icon="plane"
              size={DROPDOWN_ITEM.iconSize}
            />
          }
          label={showLabels ? t("properties.teams") : undefined}
          value={
            project.teams && project.teams.length > 0
              ? project.teams.map((team) => team.name).join(", ")
              : t("properties.addTeams")
          }
          isSelected={!!project.teams && project.teams.length > 0}
          isActive={openPicker === "teams"}
          variant={fieldVariant}
          onClick={() => togglePicker("teams")}
        />
        {openPicker === "teams" && (
          <SearchableDropdown
            placeholder={t("common:actions.search")}
            widthMode={fieldVariant === "pill" ? "menu" : "match-parent"}
            align={fieldVariant === "pill" ? "auto" : "left"}
          >
            {(searchQuery) => {
              const filtered = searchQuery
                ? availableTeams.filter((team) =>
                    team.name.toLowerCase().includes(searchQuery.toLowerCase())
                  )
                : availableTeams;
              if (filtered.length === 0) {
                return (
                  <div className={DROPDOWN_CLASSES.listMessage}>
                    {t("properties.noTeamsHint")}
                  </div>
                );
              }
              return filtered.map((team) => {
                const isSelected = project.teams?.some(
                  (item) => item.id === team.id
                );
                return (
                  <Option
                    key={team.id}
                    label={team.name}
                    isSelected={isSelected}
                    onClick={() => handleTeamToggle(team)}
                  >
                    <HugeiconsIcon
                      icon={Airplane01Icon}
                      data-icon="plane"
                      size={DROPDOWN_ITEM.iconSize}
                      style={{ color: team.color }}
                    />
                    <span className="flex-1 truncate">{team.name}</span>
                  </Option>
                );
              });
            }}
          </SearchableDropdown>
        )}
      </div>
    )}

    {/* Labels */}
    {(visibleFields.has("labels") || openPicker === "labels") && (
      <div
        className={
          fieldVariant === "pill"
            ? "relative flex min-h-7 min-w-0 max-w-[220px] items-center"
            : "relative flex min-h-[36px] w-full items-center"
        }
      >
        <FieldRow
          icon={
            <HugeiconsIcon
              icon={Tag01Icon}
              data-icon="tag"
              size={DROPDOWN_ITEM.iconSize}
            />
          }
          label={showLabels ? t("properties.labels") : undefined}
          value={
            project.labels && project.labels.length > 0
              ? project.labels.map((label) => label.name).join(", ")
              : t("properties.addLabels")
          }
          isSelected={!!project.labels && project.labels.length > 0}
          isActive={openPicker === "labels"}
          variant={fieldVariant}
          onClick={() => togglePicker("labels")}
        />
        {openPicker === "labels" && (
          <SearchableDropdown
            placeholder={t("common:actions.search")}
            widthMode={fieldVariant === "pill" ? "menu" : "match-parent"}
            align={fieldVariant === "pill" ? "auto" : "left"}
          >
            {(searchQuery) => {
              const filtered = searchQuery
                ? availableLabels.filter((label) =>
                    label.name.toLowerCase().includes(searchQuery.toLowerCase())
                  )
                : availableLabels;
              return filtered.map((label) => {
                const isSelected = project.labels?.some(
                  (item) => item.id === label.id
                );
                return (
                  <Option
                    key={label.id}
                    label={label.name}
                    isSelected={isSelected}
                    onClick={() => handleLabelToggle(label)}
                  >
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: label.color }}
                    />
                    <span className="flex-1 truncate">{label.name}</span>
                  </Option>
                );
              });
            }}
          </SearchableDropdown>
        )}
      </div>
    )}

    {/* Linked Repos */}
    {availableRepos !== undefined &&
      (visibleFields.has("linkedRepos") || openPicker === "linkedRepos") && (
        <div
          className={
            fieldVariant === "pill"
              ? "relative flex min-h-7 min-w-0 max-w-[220px] items-center"
              : "relative flex min-h-[36px] w-full items-center"
          }
        >
          <FieldRow
            icon={
              <HugeiconsIcon
                icon={CodeXmlIcon}
                data-icon="code-2"
                size={DROPDOWN_ITEM.iconSize}
              />
            }
            label={showLabels ? t("properties.repos") : undefined}
            value={linkedRepoLabel}
            isSelected={linkedRepoCount > 0}
            isActive={openPicker === "linkedRepos"}
            showChevron
            variant={fieldVariant}
            onClick={() => togglePicker("linkedRepos")}
          />
          {openPicker === "linkedRepos" && (
            <SearchableDropdown
              placeholder={t("common:actions.search")}
              widthMode={fieldVariant === "pill" ? "menu" : "match-parent"}
              align={fieldVariant === "pill" ? "auto" : "left"}
            >
              {(searchQuery) => {
                const filtered = searchQuery
                  ? availableRepos.filter((repo) =>
                      repo.name
                        .toLowerCase()
                        .includes(searchQuery.toLowerCase())
                    )
                  : availableRepos;
                if (filtered.length === 0) {
                  return (
                    <div className={DROPDOWN_CLASSES.listMessage}>
                      {t("properties.noReposHint")}
                    </div>
                  );
                }
                return filtered.map((repo) => {
                  const isSelected = project.linkedRepos?.some(
                    (item) => item.id === repo.id
                  );
                  return (
                    <Option
                      key={repo.id}
                      label={repo.name}
                      isSelected={isSelected}
                      onClick={() => handleLinkedRepoToggle(repo)}
                    >
                      <HugeiconsIcon
                        icon={CodeXmlIcon}
                        data-icon="code-2"
                        size={DROPDOWN_ITEM.iconSize}
                        className="text-text-3"
                      />
                      <span className="flex-1 truncate">{repo.name}</span>
                    </Option>
                  );
                });
              }}
            </SearchableDropdown>
          )}
        </div>
      )}
  </>
);

export default PeopleTeamsLabelsFields;
