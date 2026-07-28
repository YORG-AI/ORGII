import type { MemberEntry, ProjectData } from "@src/api/http/project";

import type { TeamInboxHandoffProject } from "./domain";

export interface SessionHandoffProjectRoster {
  project: ProjectData;
  members: MemberEntry[];
}

export function handoffProjectFromRoster(
  project: ProjectData,
  entries: readonly MemberEntry[],
  viewerMemberIds: readonly string[]
): TeamInboxHandoffProject | null {
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
    id: project.meta.id,
    slug: project.slug,
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

export function eligibleSessionHandoffProjects(
  rosters: readonly SessionHandoffProjectRoster[],
  viewerMemberIds: readonly string[]
): TeamInboxHandoffProject[] {
  return rosters
    .map(({ project, members }) =>
      handoffProjectFromRoster(project, members, viewerMemberIds)
    )
    .filter((project): project is TeamInboxHandoffProject => project != null)
    .sort((left, right) => left.name.localeCompare(right.name));
}
