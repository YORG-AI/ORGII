import type { Person } from "@src/types/core/shared";
import type { WorkItem } from "@src/types/core/workItem";

function resolveMember(
  person: Person | undefined,
  memberById: ReadonlyMap<string, Person>
): Person | undefined {
  if (!person) return undefined;
  const member = memberById.get(person.id);
  if (!member) return person;

  return {
    ...person,
    name: member.name,
    ...(member.avatar ? { avatar: member.avatar } : {}),
    ...(member.email ? { email: member.email } : {}),
    ...(member.color ? { color: member.color } : {}),
  };
}

/**
 * Projects stable persisted member ids onto the active roster's display
 * identity. The Work Item remains id-addressed for writes; only its UI-facing
 * Person references are enriched here.
 */
export function resolveWorkItemMemberIdentities(
  workItem: WorkItem,
  members: readonly Person[]
): WorkItem {
  if (members.length === 0) return workItem;

  const memberById = new Map(members.map((member) => [member.id, member]));
  const assigneeIsMember =
    workItem.assigneeType !== "agent" && workItem.assigneeType !== "org";

  return {
    ...workItem,
    assignee: assigneeIsMember
      ? resolveMember(workItem.assignee, memberById)
      : workItem.assignee,
    createdBy: resolveMember(workItem.createdBy, memberById),
    lead: workItem.lead?.map(
      (person) => resolveMember(person, memberById) ?? person
    ),
    members: workItem.members?.map(
      (person) => resolveMember(person, memberById) ?? person
    ),
  };
}
