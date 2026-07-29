/**
 * useCurrentUserMemberId
 *
 * Resolves the current user's project member ID(s) by matching against
 * all known user identities:
 * - Stable account/member IDs
 * - Local git config user.email (from Tauri command)
 * - userAtom.git_user_email (if populated)
 * - Exact GitHub/GitLab usernames when a member carries that provider field
 *
 * A single person often has multiple member entries (from git shortlog)
 * because they commit with different emails. This hook returns ALL
 * exact matching member IDs so assignment notifications work regardless of
 * which verified member entry was used. Display names and email local-parts
 * are deliberately excluded because they are not unique identities.
 */
import { invoke } from "@tauri-apps/api/core";
import { useAtomValue } from "jotai";
import { useEffect, useMemo, useRef, useState } from "react";

import type { MemberEntry } from "@src/api/http/project";
import { userAtom } from "@src/store/user/userAtom";
import type { Person } from "@src/types/core/shared";
import type { IUserInfo } from "@src/types/core/user";

// ============================================
// Git identity from Tauri
// ============================================

export interface GitUserIdentity {
  email: string | null;
  name: string | null;
  /** GitHub username from gh CLI config (~/.config/gh/hosts.yml) */
  github_username: string | null;
}

/** Cached git identity to avoid repeated Tauri calls */
let cachedGitIdentity: GitUserIdentity | null = null;
let identityPromise: Promise<GitUserIdentity> | null = null;

async function fetchGitIdentity(repoPath?: string): Promise<GitUserIdentity> {
  if (cachedGitIdentity) return cachedGitIdentity;
  if (identityPromise) return identityPromise;

  identityPromise = invoke<GitUserIdentity>("get_git_user_identity", {
    repoPath: repoPath ?? null,
  })
    .then((result) => {
      cachedGitIdentity = result;
      return result;
    })
    .catch(() => {
      const fallback: GitUserIdentity = {
        email: null,
        name: null,
        github_username: null,
      };
      cachedGitIdentity = fallback;
      return fallback;
    });

  return identityPromise;
}

/** Reset cached identity (e.g. when repo changes) */
export function resetGitIdentityCache() {
  cachedGitIdentity = null;
  identityPromise = null;
}

// ============================================
// Identity collection
// ============================================

interface UserIdentities {
  emails: string[];
  accountIds: string[];
  usernames: string[];
}

export type MemberIdentity = Pick<
  MemberEntry,
  "id" | "name" | "email" | "avatar" | "github_username" | "linked_emails"
> & {
  color?: string;
};

export function resolveCurrentUserIdentity(
  members: readonly MemberIdentity[],
  memberIds: ReadonlySet<string>,
  user: IUserInfo,
  gitIdentity: GitUserIdentity | null
): Person | null {
  const accountIds = new Set(
    [user.uuid, user.authing_id].map((value) => value.trim()).filter(Boolean)
  );
  const currentMember = members.find(
    (member) => memberIds.has(member.id) || accountIds.has(member.id)
  );
  if (currentMember) {
    const memberName = currentMember.name.trim();
    const accountName = (
      user.name ||
      gitIdentity?.name ||
      user.git_user_name ||
      ""
    ).trim();
    const memberNameIsOpaque =
      !memberName ||
      memberName === currentMember.id ||
      /^user-[a-z0-9]+$/i.test(memberName);

    return {
      id: currentMember.id,
      name:
        memberNameIsOpaque && accountName
          ? accountName
          : memberName || accountName,
      email: currentMember.email,
      avatar:
        currentMember.avatar ||
        user.profile_image_url ||
        user.picture ||
        undefined,
      color: currentMember.color,
    };
  }

  const name = (
    user.name ||
    gitIdentity?.name ||
    user.git_user_name ||
    ""
  ).trim();
  const id = (
    user.uuid ||
    user.authing_id ||
    gitIdentity?.email ||
    user.git_user_email ||
    name
  ).trim();
  if (!id || !name) return null;

  return {
    id,
    name,
    email: gitIdentity?.email || user.git_user_email || undefined,
    avatar: user.profile_image_url || user.picture || undefined,
    color: "#52c41a",
  };
}

/**
 * Collect all emails/usernames the current user might be known by.
 */
function collectIdentities(
  user: IUserInfo,
  gitIdentity: GitUserIdentity | null
): UserIdentities {
  const emailSet = new Set<string>();
  const usernameSet = new Set<string>();
  const accountIdSet = new Set<string>();

  for (const accountId of [user.uuid, user.authing_id]) {
    const normalized = accountId.trim();
    if (normalized) accountIdSet.add(normalized);
  }

  // GitHub username from gh CLI.
  if (gitIdentity?.github_username) {
    usernameSet.add(gitIdentity.github_username.toLowerCase().trim());
  }

  // Exact email identities.
  if (gitIdentity?.email) {
    emailSet.add(gitIdentity.email.toLowerCase().trim());
  }

  if (user.git_user_email) {
    emailSet.add(user.git_user_email.toLowerCase().trim());
  }

  // Exact provider usernames.
  for (const gh of user.github_infos ?? []) {
    if (gh.user_name) {
      usernameSet.add(gh.user_name.toLowerCase().trim());
    }
  }

  for (const gl of user.gitlab_infos ?? []) {
    if (gl.user_name) {
      usernameSet.add(gl.user_name.toLowerCase().trim());
    }
  }

  return {
    emails: [...emailSet],
    accountIds: [...accountIdSet],
    usernames: [...usernameSet],
  };
}

// ============================================
// Member matching
// ============================================

/**
 * Check if a member entry matches any of the user's known identities.
 */
function memberMatchesUser(
  member: MemberIdentity,
  identities: UserIdentities
): boolean {
  const memberEmail = (member.email || "").toLowerCase().trim();
  const memberUsername = (member.github_username || "").toLowerCase().trim();

  if (identities.accountIds.includes(member.id)) return true;
  if (memberEmail && identities.emails.includes(memberEmail)) return true;
  if (memberUsername && identities.usernames.includes(memberUsername)) {
    return true;
  }

  for (const linked of member.linked_emails ?? []) {
    const email = linked.email.toLowerCase().trim();
    if (email && identities.emails.includes(email)) return true;
  }

  return false;
}

/**
 * Find a member entry by exact email match.
 */
export function findMemberByEmail(
  members: readonly MemberIdentity[],
  email: string
): MemberIdentity | undefined {
  const normalized = email.toLowerCase().trim();
  return members.find(
    (member) => (member.email || "").toLowerCase().trim() === normalized
  );
}

// ============================================
// Public API
// ============================================

/**
 * Find ALL member IDs that belong to the current user.
 * Returns a Set for O(1) lookup.
 *
 * This is the synchronous version — uses whatever identity data is available.
 * For the async version that fetches git config, use the hook.
 */
export function findMemberIdsByUser(
  members: readonly MemberIdentity[],
  user: IUserInfo,
  gitIdentity?: GitUserIdentity | null
): Set<string> {
  const identities = collectIdentities(user, gitIdentity ?? cachedGitIdentity);
  const ids = new Set<string>();

  for (const member of members) {
    if (memberMatchesUser(member, identities)) {
      ids.add(member.id);
    }
  }

  return ids;
}

// ============================================
// Hook
// ============================================

interface UseCurrentUserMemberIdsReturn {
  /** Set of member IDs belonging to the current user */
  memberIds: Set<string>;
  /** Current user's git email (primary) */
  gitEmail: string;
  /** Display identity used by Work Item comments and mutation history. */
  currentUser: Person | null;
}

/**
 * Hook that provides all member IDs belonging to the current user.
 * Fetches git identity from local config on mount.
 */
export function useCurrentUserMemberIds(
  members: readonly MemberIdentity[]
): UseCurrentUserMemberIdsReturn {
  const user = useAtomValue(userAtom);
  const [gitIdentity, setGitIdentity] = useState<GitUserIdentity | null>(
    cachedGitIdentity
  );
  const fetchedRef = useRef(false);

  useEffect(() => {
    if (fetchedRef.current && cachedGitIdentity) return;
    let cancelled = false;

    fetchGitIdentity().then((identity) => {
      if (!cancelled) {
        setGitIdentity(identity);
        fetchedRef.current = true;
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const memberIds = useMemo(
    () => findMemberIdsByUser(members, user, gitIdentity),
    [members, user, gitIdentity]
  );

  const gitEmail = gitIdentity?.email || user.git_user_email || "";
  const currentUser = useMemo(
    () => resolveCurrentUserIdentity(members, memberIds, user, gitIdentity),
    [gitIdentity, memberIds, members, user]
  );

  return { memberIds, gitEmail, currentUser };
}
