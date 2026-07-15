/**
 * Tree <-> flat list helpers shared between AgentTeamWizard (creation/editing
 * inside the wizard) and OrgDetailView (always-editable detail panel).
 *
 * The on-disk shape is a tree (`OrgMember` with `children`); the table UI
 * works on a flat `TeamMember[]` keyed by `parentId`. These helpers convert
 * between the two representations.
 */
import type { TeamMember } from "@src/components/TeamMemberTable";
import type { OrgMember } from "@src/modules/MainApp/AgentOrgs/types";

/**
 * Compute the set of member IDs whose `name` collides (case-insensitively)
 * with another row in the same list. Empty / whitespace-only names are
 * skipped — that's a separate "name must not be empty" validation.
 *
 * Why uniqueness matters: names are still the human-facing labels in the
 * editor. Runtime routing uses stable `member_id` values only, so duplicate
 * labels are blocked here to keep the UI understandable without leaking
 * display names into LLM tool routing.
 */
export function findDuplicateMemberNameIds(
  members: { id: string; name: string }[]
): Set<string> {
  const buckets = new Map<string, string[]>();
  for (const member of members) {
    const key = member.name.trim().toLowerCase();
    if (key.length === 0) continue;
    const existing = buckets.get(key);
    if (existing) {
      existing.push(member.id);
    } else {
      buckets.set(key, [member.id]);
    }
  }
  const duplicateIds = new Set<string>();
  for (const ids of buckets.values()) {
    if (ids.length > 1) {
      for (const id of ids) duplicateIds.add(id);
    }
  }
  return duplicateIds;
}

/** Build an OrgMember[] tree from a flat TeamMember[] using parentId. */
export function buildOrgTreeFromMembers(members: TeamMember[]): OrgMember[] {
  const nodeMap = new Map<string, OrgMember>();
  for (const member of members) {
    nodeMap.set(member.id, {
      id: member.id,
      name: member.name,
      role: member.role,
      agentId: member.agentId,
      runtimeConfig: member.runtimeConfig,
      instructions: member.instructions?.trim() || undefined,
      children: [],
    });
  }

  const roots: OrgMember[] = [];
  for (const member of members) {
    const node = nodeMap.get(member.id)!;
    const parent = member.parentId ? nodeMap.get(member.parentId) : undefined;
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

/** Flatten an OrgMember tree into a TeamMember[], preserving parentId. */
export function flattenOrgToMembers(
  nodes: OrgMember[],
  parentId?: string
): TeamMember[] {
  const result: TeamMember[] = [];
  for (const node of nodes) {
    if (node.role === "org") {
      result.push(...flattenOrgToMembers(node.children, parentId));
    } else {
      result.push({
        id: node.id,
        name: node.name,
        role: node.role,
        agentId: node.agentId,
        runtimeConfig: node.runtimeConfig,
        instructions: node.instructions,
        parentId,
      });
      result.push(...flattenOrgToMembers(node.children, node.id));
    }
  }
  return result;
}
