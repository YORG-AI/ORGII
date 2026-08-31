/**
 * RepoSettingsTabContent
 *
 * Self-loading wrapper that fetches members + labels for the repo settings page.
 *
 * Since members/labels are now per-project (slug-keyed), this picks the
 * first project linked to the current repo. If no project exists, the
 * page renders empty.
 */
import { useAtomValue } from "jotai";
import { type FC, lazy, useCallback, useEffect, useState } from "react";

import { type MemberEntry, projectApi } from "@src/api/http/project";
import { Placeholder } from "@src/components/Placeholder";
import { createLogger } from "@src/hooks/logger";
import { activeWorkspaceRootPathAtom } from "@src/store/workspace";
import type { Label } from "@src/types/core/shared";

const RepoSettingsPage = lazy(
  () => import("../../Projects/components/RepoSettings")
);

const log = createLogger("RepoSettingsTab");

interface RepoSettingsTabContentProps {
  initialSection?: string;
}

export const RepoSettingsTabContent: FC<RepoSettingsTabContentProps> = ({
  initialSection,
}) => {
  const repoPath = useAtomValue(activeWorkspaceRootPathAtom) || null;
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  const [members, setMembers] = useState<MemberEntry[]>([]);
  const [labels, setLabels] = useState<Label[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!repoPath) {
      setLoading(false);
      return;
    }
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      try {
        const projects = await projectApi.readProjects();
        if (cancelled) return;
        const slug = projects[0]?.slug ?? null;
        setActiveSlug(slug);
        if (!slug) {
          setMembers([]);
          setLabels([]);
          return;
        }
        const [membersFile, labelsFile] = await Promise.all([
          projectApi.readMembers(slug),
          projectApi.readLabels(slug),
        ]);
        if (cancelled) return;
        setMembers(
          membersFile.members.map((member) => ({
            ...member,
            active: member.active ?? true,
          }))
        );
        setLabels(labelsFile.labels);
      } catch (err) {
        if (cancelled) return;
        log.error("[RepoSettingsTab] Failed to load data:", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [repoPath]);

  const handleUpdateMembers = useCallback(
    async (updated: MemberEntry[]) => {
      if (!activeSlug) return;
      setMembers(updated);
      await projectApi.writeMembers(activeSlug, { members: updated });
    },
    [activeSlug]
  );

  const handleUpdateLabels = useCallback(
    async (updated: Label[]) => {
      if (!activeSlug) return;
      setLabels(updated);
      await projectApi.writeLabels(activeSlug, { labels: updated });
    },
    [activeSlug]
  );

  if (loading) return <Placeholder variant="loading" />;

  const normalizedSection: "profile" | "members" | "labels" | undefined =
    initialSection === "profile" ||
    initialSection === "members" ||
    initialSection === "labels"
      ? initialSection
      : undefined;

  return (
    <RepoSettingsPage
      repoPath={repoPath}
      members={members}
      onUpdateMembers={handleUpdateMembers}
      labels={labels}
      onUpdateLabels={handleUpdateLabels}
      initialSection={normalizedSection}
    />
  );
};

export default RepoSettingsTabContent;
