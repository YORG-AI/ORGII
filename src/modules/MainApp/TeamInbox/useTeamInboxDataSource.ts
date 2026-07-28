import { useAtomValue, useStore } from "jotai";
import { useEffect, useLayoutEffect, useMemo, useState } from "react";

import { invalidateProjectCache, projectApi } from "@src/api/http/project";
import type { MemberEntry } from "@src/api/http/project";
import {
  org2CloudAuthAtom,
  org2CloudAuthIdentityKey,
} from "@src/features/Org2Cloud/org2CloudAuthAtom";
import {
  org2CloudCommentsSignalAtom,
  orgCommentsKey,
} from "@src/features/Org2Cloud/org2CloudCommentsBus";
import { sidebarActiveCloudOrgIdAtom } from "@src/features/Org2Cloud/org2CloudOrgsAtom";
import { createLogger } from "@src/hooks/logger";
import { useProjectDataChanged } from "@src/hooks/project";
import { useCurrentUserMemberIds } from "@src/hooks/project/useCurrentUserMemberId";
import { sessionByIdAtom } from "@src/store/session";

import { createWorkItemFromSession } from "./createWorkItemFromSession";
import { sessionHandoffDraft } from "./createWorkItemFromSession";
import type {
  TeamInboxDataSource,
  TeamInboxFilter,
  TeamInboxHandoffProject,
  TeamInboxIssue,
  TeamInboxItem,
  TeamInboxSessionHandoffDraft,
} from "./domain";
import { SessionHandoffPreparationError } from "./sessionHandoffError";
import {
  type SessionHandoffProjectRoster,
  eligibleSessionHandoffProjects,
  handoffProjectFromRoster,
} from "./sessionHandoffProjects";
import { observeSharedOperation } from "./sharedOperation";
import { teamInboxCacheAtom, teamInboxInvalidationAtom } from "./store";
import {
  type TeamInboxCoordinatorScope,
  teamInboxCoordinator,
} from "./teamInboxCoordinator";

const log = createLogger("TeamInboxDataSource");
const MEMBER_READ_CONCURRENCY = 8;
const sessionCreationFlights = new Map<
  string,
  ReturnType<typeof createWorkItemFromSession>
>();
const sessionPreparationFlights = new Map<
  string,
  Promise<TeamInboxSessionHandoffDraft>
>();

interface MemberSnapshot {
  members: MemberEntry[];
  projectRosters: SessionHandoffProjectRoster[];
  issue: TeamInboxIssue | null;
}

const EMPTY_MEMBER_SNAPSHOT: MemberSnapshot = {
  members: [],
  projectRosters: [],
  issue: null,
};

let membersRequest: Promise<MemberSnapshot> | null = null;

async function readAllProjectMembers(): Promise<MemberSnapshot> {
  if (membersRequest) return membersRequest;
  membersRequest = (async () => {
    const projects = await projectApi.readProjects();
    if (projects.length === 0) return EMPTY_MEMBER_SNAPSHOT;

    const projectRosters: SessionHandoffProjectRoster[] = [];
    const failures: unknown[] = [];
    let nextIndex = 0;
    const workerCount = Math.min(MEMBER_READ_CONCURRENCY, projects.length);
    const workers = Array.from({ length: workerCount }, async () => {
      while (nextIndex < projects.length) {
        const index = nextIndex;
        nextIndex += 1;
        const project = projects[index];
        try {
          const file = await projectApi.readMembers(project.slug);
          projectRosters.push({ project, members: file.members });
        } catch (error) {
          failures.push(error);
        }
      }
    });
    await Promise.all(workers);
    if (projectRosters.length === 0 && failures.length > 0) {
      throw failures[0];
    }
    if (failures.length > 0) {
      log.warn(
        `Skipped ${failures.length} project member file(s) while resolving Team Inbox identity`
      );
    }

    const members = new Map<string, MemberEntry>();
    for (const roster of projectRosters) {
      for (const member of roster.members) {
        const existing = members.get(member.id);
        if (
          !existing ||
          (member.last_commit_date ?? "") > (existing.last_commit_date ?? "")
        ) {
          members.set(member.id, member);
        }
      }
    }
    return {
      members: [...members.values()],
      projectRosters,
      issue:
        failures.length > 0
          ? {
              code: "partial_load",
              detail: `${failures.length} project member file(s) could not be read`,
            }
          : null,
    };
  })();
  try {
    return await membersRequest;
  } finally {
    membersRequest = null;
  }
}

function issueError(issue: TeamInboxIssue): Error & {
  issue: TeamInboxIssue;
} {
  return Object.assign(new Error(issue.detail ?? `Team Inbox ${issue.code}`), {
    issue,
  });
}

export function useTeamInboxDataSource(): {
  dataSource: TeamInboxDataSource;
  viewerMemberIds: readonly string[];
} {
  const store = useStore();
  const [memberSnapshot, setMemberSnapshot] = useState<MemberSnapshot>(
    EMPTY_MEMBER_SNAPSHOT
  );
  const { members } = memberSnapshot;
  const { memberIds } = useCurrentUserMemberIds(members);
  const viewerMemberIds = useMemo(() => [...memberIds].sort(), [memberIds]);
  const auth = useAtomValue(org2CloudAuthAtom);
  const authIdentityKey = auth ? org2CloudAuthIdentityKey(auth) : null;
  const activeCloudOrgId = useAtomValue(sidebarActiveCloudOrgIdAtom);
  const commentsSignals = useAtomValue(org2CloudCommentsSignalAtom);
  // Every consumer observes the same version; the coordinator single-flights
  // the resulting request instead of giving each hook its own request state.
  const invalidation = useAtomValue(teamInboxInvalidationAtom);
  const activeCloudCommentsRevision = activeCloudOrgId
    ? (commentsSignals[orgCommentsKey(activeCloudOrgId)] ?? 0)
    : 0;
  const viewerKey = `${viewerMemberIds.join("|")}::${authIdentityKey ?? "signed-out"}::${activeCloudOrgId ?? "local"}`;
  const scope = useMemo<TeamInboxCoordinatorScope>(
    () => ({
      key: viewerKey,
      viewerMemberIds,
      accessToken: auth?.accessToken ?? null,
      activeCloudOrgId,
      members,
      prerequisiteIssue: memberSnapshot.issue,
    }),
    [
      activeCloudOrgId,
      auth?.accessToken,
      memberSnapshot.issue,
      members,
      viewerKey,
      viewerMemberIds,
    ]
  );

  useLayoutEffect(() => {
    teamInboxCoordinator.ensureScope(store, viewerKey);
  }, [store, viewerKey]);

  useEffect(() => {
    let cancelled = false;
    void readAllProjectMembers()
      .then((nextSnapshot) => {
        if (!cancelled) setMemberSnapshot(nextSnapshot);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        log.warn("Failed to resolve Team Inbox member identity", error);
        store.set(teamInboxCacheAtom, (current) => ({
          ...current,
          loading: false,
          issue: {
            code: "load_failed",
            detail: error instanceof Error ? error.message : String(error),
          },
          revision: current.revision + 1,
        }));
      });
    return () => {
      cancelled = true;
    };
  }, [invalidation, store]);

  useEffect(() => {
    const requestVersion = `${invalidation}:${activeCloudCommentsRevision}:${members.length}:${memberSnapshot.issue?.code ?? "members-ok"}`;
    void teamInboxCoordinator.refresh(store, scope, requestVersion);
  }, [
    activeCloudCommentsRevision,
    invalidation,
    memberSnapshot.issue?.code,
    members.length,
    scope,
    store,
  ]);

  useProjectDataChanged(() => teamInboxCoordinator.invalidate(store));

  const dataSource = useMemo<TeamInboxDataSource>(() => {
    const prepareSessionHandoff = async ({
      sessionId,
      title,
      signal,
    }: {
      sessionId: string;
      title: string;
      signal?: AbortSignal;
    }): Promise<TeamInboxSessionHandoffDraft> => {
      const session = store.get(sessionByIdAtom(sessionId));
      if (!session) {
        throw new SessionHandoffPreparationError("session_unavailable");
      }
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      let sourceProjectSlug: string | undefined;
      let projects: TeamInboxHandoffProject[] = [];
      if (session.projectSlug || session.projectId) {
        const project = session.projectSlug
          ? await projectApi.readProject(session.projectSlug)
          : (await projectApi.readProjects()).find(
              (entry) => entry.meta.id === session.projectId
            );
        if (!project) {
          throw new SessionHandoffPreparationError("project_unavailable");
        }
        const entries = (await projectApi.readMembers(project.slug)).members;
        const candidate = handoffProjectFromRoster(
          project,
          entries,
          viewerMemberIds
        );
        if (candidate) projects = [candidate];
        sourceProjectSlug = project.slug;
      } else {
        // A standalone Session has no canonical project boundary. Resolve a
        // fresh roster for both preview and submit so a removed membership or
        // newly joined project cannot be accepted from a stale hook snapshot.
        const latestMemberSnapshot = await readAllProjectMembers();
        projects = eligibleSessionHandoffProjects(
          latestMemberSnapshot.projectRosters,
          viewerMemberIds
        );
      }
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      if (projects.length === 0) {
        throw new SessionHandoffPreparationError(
          sourceProjectSlug ? "identity_unavailable" : "no_project"
        );
      }
      return sessionHandoffDraft(session, projects, title, sourceProjectSlug);
    };

    return {
      listPage: async () => {
        const cache = store.get(teamInboxCacheAtom);
        if (
          cache.issue &&
          cache.items.length === 0 &&
          cache.issue.code !== "partial_load"
        ) {
          throw issueError(cache.issue);
        }
        return {
          items: cache.items,
          loading: cache.loading,
          issue: cache.issue,
          unreadCounts: cache.unreadCounts,
          nextCursor: cache.hasMore
            ? { occurredAt: "", itemKey: "team-inbox-has-more" }
            : null,
        };
      },
      loadMore: () => teamInboxCoordinator.loadMore(store, scope),
      refresh: async () => {
        // Never create a second roster fan-out while the first is active.
        // Explicit refresh waits for it, then starts one fresh post-invalidation
        // snapshot that both mounted consumers can share.
        await membersRequest?.catch(() => undefined);
        invalidateProjectCache();
        membersRequest = null;
        const nextSnapshot = await readAllProjectMembers();
        setMemberSnapshot(nextSnapshot);
        teamInboxCoordinator.invalidate(store);
      },
      markRead: (item) => teamInboxCoordinator.markRead(store, scope, item),
      markUnread: (item) => teamInboxCoordinator.markUnread(store, scope, item),
      markAllRead: (_items, filter = "all") =>
        teamInboxCoordinator.markAllRead(store, scope, filter),
      reconcileItem: (itemKey, nextItem) =>
        teamInboxCoordinator.reconcileItem(store, scope.key, itemKey, nextItem),
      prepareSessionHandoff: viewerMemberIds[0]
        ? ({ sessionId, title, signal }) => {
            const flightKey = `${scope.key}:${sessionId}:${title.trim()}`;
            const existing = sessionPreparationFlights.get(flightKey);
            if (existing) return observeSharedOperation(existing, signal);
            const flight = prepareSessionHandoff({
              sessionId,
              title,
            }).finally(() => {
              if (sessionPreparationFlights.get(flightKey) === flight) {
                sessionPreparationFlights.delete(flightKey);
              }
            });
            sessionPreparationFlights.set(flightKey, flight);
            return observeSharedOperation(flight, signal);
          }
        : undefined,
      createWorkItemFromSession: viewerMemberIds[0]
        ? ({
            sessionId,
            title,
            projectSlug,
            assigneeMemberId,
            handoffNote,
            signal,
          }) => {
            const flightKey = [
              scope.key,
              sessionId,
              projectSlug,
              assigneeMemberId,
              title.trim(),
              handoffNote?.trim() ?? "",
            ].join(":");
            const existing = sessionCreationFlights.get(flightKey);
            if (existing) return observeSharedOperation(existing, signal);

            const session = store.get(sessionByIdAtom(sessionId));
            if (!session) {
              return Promise.reject(
                new Error("The dropped Session is no longer available")
              );
            }

            const flight = prepareSessionHandoff({
              sessionId,
              title,
            })
              .then((draft) => {
                const project = draft.projects.find(
                  (candidate) => candidate.slug === projectSlug
                );
                if (!project) {
                  throw new Error(
                    "The selected project is no longer available"
                  );
                }
                const recipient = project.recipients.find(
                  (member) => member.id === assigneeMemberId
                );
                if (!recipient) {
                  throw new Error(
                    "The selected recipient is no longer available"
                  );
                }
                return createWorkItemFromSession({
                  session,
                  title,
                  activeOrgId: activeCloudOrgId,
                  selectedProjectSlug: project.slug,
                  assigneeMemberId: recipient.id,
                  assigneeMemberName: recipient.name,
                  senderMemberId: project.sender.id,
                  senderMemberName: project.sender.name,
                  recipientIsCurrentUser: recipient.isCurrentUser,
                  handoffNote,
                });
              })
              .then((result) => {
                invalidateProjectCache();
                teamInboxCoordinator.invalidate(store);
                return result;
              })
              .finally(() => {
                if (sessionCreationFlights.get(flightKey) === flight) {
                  sessionCreationFlights.delete(flightKey);
                }
              });
            sessionCreationFlights.set(flightKey, flight);
            return observeSharedOperation(flight, signal);
          }
        : undefined,
      subscribe: (listener) => {
        let revision = store.get(teamInboxCacheAtom).revision;
        return store.sub(teamInboxCacheAtom, () => {
          const nextRevision = store.get(teamInboxCacheAtom).revision;
          if (nextRevision === revision) return;
          revision = nextRevision;
          listener();
        });
      },
    };
  }, [activeCloudOrgId, scope, store, viewerMemberIds]);

  return { dataSource, viewerMemberIds };
}

export function filterForItem(item: TeamInboxItem): TeamInboxFilter {
  return item.kind === "comment_mention" ? "mentions" : "assigned";
}

export const __TEAM_INBOX_MEMBER_INTERNALS = {
  resetRequest: () => {
    membersRequest = null;
  },
};
