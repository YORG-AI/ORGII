import type { TFunction } from "i18next";
import React from "react";

import { SectionContainer } from "@src/modules/shared/layouts/SectionLayout";

import { getMetadataId, getRecordField, getStringField } from "./utils";

interface MetadataSectionHeaderProps {
  title: string;
  description: string;
  countLabel: string;
}

function MetadataSectionHeader({
  title,
  description,
  countLabel,
}: MetadataSectionHeaderProps) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div>
        <div className="text-[13px] font-semibold text-text-1">{title}</div>
        <div className="mt-1 text-[12px] text-text-3">{description}</div>
      </div>
      <div className="rounded-full bg-fill-1 px-2 py-0.5 text-[11px] text-text-3">
        {countLabel}
      </div>
    </div>
  );
}

function MetadataError({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div className="rounded-lg bg-danger-1 px-3 py-2 text-[12px] text-danger-6">
      {error}
    </div>
  );
}

interface WorkItemsSectionProps {
  t: TFunction<"navigation">;
  workItems: Record<string, unknown>[];
  localMetadataError: string | null;
}

export function WorkItemsSection({
  t,
  workItems,
  localMetadataError,
}: WorkItemsSectionProps) {
  return (
    <SectionContainer color="chatPanelInfo" padding="default">
      <div className="flex min-h-[320px] flex-col gap-3">
        <MetadataSectionHeader
          title={t("collaboration.workItems.title")}
          description={t("collaboration.workItems.description")}
          countLabel={t("collaboration.workItems.count", {
            count: workItems.length,
          })}
        />
        <MetadataError error={localMetadataError} />
        {workItems.length === 0 ? (
          <div className="flex min-h-[220px] items-center justify-center rounded-lg bg-fill-1 px-4 text-center text-[13px] text-text-3">
            {t("collaboration.workItems.empty")}
          </div>
        ) : (
          <div className="flex flex-col divide-y divide-border-2 rounded-xl border border-border-2 bg-bg-2">
            {workItems.map((workItem, index) => {
              const project = getRecordField(workItem, "project");
              const projectName = project
                ? getStringField(project, ["name"])
                : getStringField(workItem, ["projectName", "projectId"]);
              return (
                <div
                  key={getMetadataId(workItem) ?? `work-item-${index}`}
                  className="flex flex-col gap-2 px-3 py-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-[13px] font-semibold text-text-1">
                        {getStringField(workItem, ["title", "name"])}
                      </div>
                      <div className="mt-1 truncate text-[12px] text-text-3">
                        {projectName}
                      </div>
                    </div>
                    <div className="shrink-0 rounded-full bg-fill-1 px-2 py-0.5 text-[11px] text-text-3">
                      {getStringField(workItem, ["status"])}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5 text-[11px] text-text-3">
                    <span className="rounded-full bg-fill-1 px-2 py-0.5">
                      {getStringField(workItem, ["priority"])}
                    </span>
                    <span className="rounded-full bg-fill-1 px-2 py-0.5">
                      {getStringField(
                        workItem,
                        ["assigneeName"],
                        t("collaboration.workItems.unassigned")
                      )}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </SectionContainer>
  );
}

interface ProjectsSectionProps {
  t: TFunction<"navigation">;
  projects: Record<string, unknown>[];
  localMetadataError: string | null;
}

export function ProjectsSection({
  t,
  projects,
  localMetadataError,
}: ProjectsSectionProps) {
  return (
    <SectionContainer color="chatPanelInfo" padding="default">
      <div className="flex min-h-[320px] flex-col gap-3">
        <MetadataSectionHeader
          title={t("collaboration.projects.title")}
          description={t("collaboration.projects.description")}
          countLabel={t("collaboration.projects.count", {
            count: projects.length,
          })}
        />
        <MetadataError error={localMetadataError} />
        {projects.length === 0 ? (
          <div className="flex min-h-[220px] items-center justify-center rounded-lg bg-fill-1 px-4 text-center text-[13px] text-text-3">
            {t("collaboration.projects.empty")}
          </div>
        ) : (
          <div className="grid gap-3 @[720px]:grid-cols-2">
            {projects.map((project, index) => (
              <div
                key={getMetadataId(project) ?? `project-${index}`}
                className="rounded-xl border border-border-2 bg-bg-2 px-3 py-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-semibold text-text-1">
                      {getStringField(project, ["name", "title"])}
                    </div>
                    <div className="mt-1 line-clamp-2 text-[12px] text-text-3">
                      {getStringField(
                        project,
                        ["description"],
                        t("collaboration.projects.noDescription")
                      )}
                    </div>
                  </div>
                  <div className="shrink-0 rounded-full bg-fill-1 px-2 py-0.5 text-[11px] text-text-3">
                    {getStringField(project, ["status"])}
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5 text-[11px] text-text-3">
                  <span className="rounded-full bg-fill-1 px-2 py-0.5">
                    {getStringField(project, ["priority"])}
                  </span>
                  <span className="rounded-full bg-fill-1 px-2 py-0.5">
                    {getStringField(project, ["health"])}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </SectionContainer>
  );
}
