import type { MemberEntry, ProjectData } from "@src/api/http/project";

import type {
  TeamInboxCloudOrgHandoffDestination,
  TeamInboxProjectHandoffDestination,
} from "./domain";

export interface SessionHandoffProjectRoster {
  project: ProjectData;
  members: MemberEntry[];
}

export interface SessionHandoffCloudOrg {
  orgId: string;
  name: string;
}

export interface SessionHandoffCloudMember {
  userId: string;
  displayName?: string;
  status: string;
}

export function projectHandoffDestinationKey(projectSlug: string): string {
  return `project:${projectSlug}`;
}

export function cloudOrgHandoffDestinationKey(orgId: string): string {
  return `cloud-org:${orgId}`;
}

export function teamInboxViewerMemberIds(
  projectMemberIds: ReadonlySet<string>,
  cloudUserId?: string
): string[] {
  return [
    ...new Set([...(cloudUserId ? [cloudUserId] : []), ...projectMemberIds]),
  ]
    .filter(Boolean)
    .sort();
}

export function handoffProjectFromRoster(
  project: ProjectData,
  entries: readonly MemberEntry[],
  viewerMemberIds: readonly string[]
): TeamInboxProjectHandoffDestination | null {
  const candidateMap = new Map<string, MemberEntry>();
  for (const member of entries) {
    if (member.active === false) continue;
    candidateMap.set(member.id, member);
  }

  const senderEntry = [...candidateMap.values()].find((member) =>
    viewerMemberIds.includes(member.id)
  );
  if (!senderEntry) return null;

  const recipients = [...candidateMap.values()]
    .map((member) => ({
      id: member.id,
      name: member.name,
      avatar: member.avatar,
      isCurrentUser: viewerMemberIds.includes(member.id),
    }))
    .sort(
      (left, right) =>
        Number(right.isCurrentUser) - Number(left.isCurrentUser) ||
        left.name.localeCompare(right.name)
    );

  return {
    kind: "project",
    key: projectHandoffDestinationKey(project.slug),
    projectId: project.meta.id,
    projectSlug: project.slug,
    name: project.meta.name,
    sender: {
      id: senderEntry.id,
      name: senderEntry.name,
      avatar: senderEntry.avatar,
      isCurrentUser: true,
    },
    recipients,
  };
}

/**
 * Resolve a managed-cloud handoff in the cloud account-id namespace.
 *
 * Cloud membership is authoritative here. Project/git aliases are
 * intentionally not consulted: mixing those ids made another cloud account
 * disappear from the recipient picker and mislabeled a local git identity as
 * the signed-in cloud user.
 */
export function handoffCloudOrgFromRoster(
  org: SessionHandoffCloudOrg,
  entries: readonly SessionHandoffCloudMember[],
  viewerUserId: string
): TeamInboxCloudOrgHandoffDestination | null {
  const activeMembers = new Map<string, SessionHandoffCloudMember>();
  for (const member of entries) {
    if (member.status !== "active") continue;
    activeMembers.set(member.userId, member);
  }

  const senderEntry = activeMembers.get(viewerUserId);
  if (!senderEntry) return null;

  const recipients = [...activeMembers.values()]
    .map((member) => ({
      id: member.userId,
      name: member.displayName?.trim() || member.userId,
      isCurrentUser: member.userId === viewerUserId,
    }))
    .sort(
      (left, right) =>
        Number(right.isCurrentUser) - Number(left.isCurrentUser) ||
        left.name.localeCompare(right.name)
    );

  return {
    kind: "cloud_org",
    key: cloudOrgHandoffDestinationKey(org.orgId),
    orgId: org.orgId,
    name: org.name,
    sender: {
      id: senderEntry.userId,
      name: senderEntry.displayName?.trim() || senderEntry.userId,
      isCurrentUser: true,
    },
    recipients,
  };
}

export function eligibleSessionHandoffProjects(
  rosters: readonly SessionHandoffProjectRoster[],
  viewerMemberIds: readonly string[]
): TeamInboxProjectHandoffDestination[] {
  return rosters
    .map(({ project, members }) =>
      handoffProjectFromRoster(project, members, viewerMemberIds)
    )
    .filter(
      (project): project is TeamInboxProjectHandoffDestination =>
        project != null
    )
    .sort((left, right) => left.name.localeCompare(right.name));
}
