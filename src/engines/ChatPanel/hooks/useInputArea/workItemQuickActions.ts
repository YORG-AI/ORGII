import { useAtomValue } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  type QuickAction,
  projectApi,
  quickActionsCacheKey,
} from "@src/api/http/project";
import Message from "@src/components/Message";
import { useProjectCachedResource } from "@src/hooks/project";
import type { Session } from "@src/store/session/sessionAtom/types";
import { userAtom } from "@src/store/user/userAtom";
import type { SlashItem } from "@src/types/extensions";

const QUICK_ACTION_SOURCE = "Work Item Quick Actions";
const MAX_QUICK_ACTION_MENU_ITEMS = 50;
const EMPTY_QUICK_ACTIONS: QuickAction[] = [];

export interface WorkItemQuickActionScope {
  orgId: string;
  projectSlug: string | null;
  workItemId: string;
}

type QuickActionMenuDefinition = Pick<
  QuickAction,
  "id" | "orgId" | "name" | "description" | "targetKind" | "targetId"
>;

function toQuickActionMenuDefinitions(
  actions: readonly QuickAction[]
): QuickActionMenuDefinition[] {
  return actions.slice(0, MAX_QUICK_ACTION_MENU_ITEMS).map((action) => ({
    id: action.id,
    orgId: action.orgId,
    name: action.name,
    description: action.description,
    targetKind: action.targetKind,
    targetId: action.targetId,
  }));
}

function clean(value: string | null | undefined): string {
  return value?.trim() ?? "";
}

/** Only explicit persisted Session scope may expose executable presets. */
export function resolveWorkItemQuickActionScope(
  session: Pick<Session, "orgId" | "projectSlug" | "workItemId"> | null
): WorkItemQuickActionScope | null {
  const orgId = clean(session?.orgId);
  const workItemId = clean(session?.workItemId);
  if (!orgId || !workItemId) return null;
  return {
    orgId,
    projectSlug: clean(session?.projectSlug) || null,
    workItemId,
  };
}

function scopeKey(scope: WorkItemQuickActionScope): string {
  return `${scope.orgId}\0${scope.projectSlug ?? ""}\0${scope.workItemId}`;
}

export function quickActionToSlashItem(
  action: QuickActionMenuDefinition,
  selectedScope?: WorkItemQuickActionScope
): SlashItem {
  return {
    name: action.name,
    description:
      action.description || `Run on ${action.targetKind}:${action.targetId}`,
    category: "action",
    source: QUICK_ACTION_SOURCE,
    acceptsArgs: false,
    selection: selectedScope
      ? {
          kind: "work_item_quick_action",
          actionId: action.id,
          orgId: action.orgId,
          scopeKey: scopeKey(selectedScope),
        }
      : undefined,
  };
}

interface QuickActionActor {
  actorId: string;
  actorName: string;
}

export interface WorkItemQuickActionInvocation extends WorkItemQuickActionScope {
  actionId: string;
  actorId: string;
  actorName: string;
}

/** Re-check the current scope at click time before constructing a mutation. */
export function buildWorkItemQuickActionInvocation(
  item: SlashItem,
  selectedScope: WorkItemQuickActionScope | null,
  actor: QuickActionActor
): WorkItemQuickActionInvocation | null {
  const selection = item.selection;
  if (
    !selectedScope ||
    selection?.kind !== "work_item_quick_action" ||
    selection.orgId !== selectedScope.orgId ||
    selection.scopeKey !== scopeKey(selectedScope)
  ) {
    return null;
  }
  return {
    ...selectedScope,
    actionId: selection.actionId,
    actorId: actor.actorId,
    actorName: actor.actorName,
  };
}

function resolveActor(user: {
  uuid: string;
  authing_id: string;
  git_user_email: string;
  name: string;
  git_user_name: string;
}): { actorId: string; actorName: string } {
  const actorId =
    clean(user.uuid) ||
    clean(user.authing_id) ||
    clean(user.git_user_email) ||
    "local";
  return {
    actorId,
    actorName: clean(user.name) || clean(user.git_user_name) || actorId,
  };
}

interface UseWorkItemQuickActionsResult {
  items: SlashItem[];
  loading: boolean;
  prefetch: () => void;
  handleSelect: (item: SlashItem) => boolean;
}

export function useWorkItemQuickActions(
  session: Pick<Session, "orgId" | "projectSlug" | "workItemId"> | null,
  closeMenu: () => void
): UseWorkItemQuickActionsResult {
  const { t } = useTranslation("projects");
  const user = useAtomValue(userAtom);
  const { actorId, actorName } = useMemo(() => resolveActor(user), [user]);
  const scope = useMemo(
    () => resolveWorkItemQuickActionScope(session),
    [session]
  );
  const requestKey = scope ? `${actorId}\0${scope.orgId}` : "";
  const readActions = useCallback(
    () =>
      scope
        ? projectApi.listQuickActions(scope.orgId)
        : Promise.resolve([] as QuickAction[]),
    [scope]
  );
  const { data: cachedActions, refresh: refreshActions } =
    useProjectCachedResource({
      cacheKey: scope ? quickActionsCacheKey(scope.orgId) : null,
      read: readActions,
      empty: EMPTY_QUICK_ACTIONS,
      enabled: false,
    });
  const [loadingKey, setLoadingKey] = useState("");
  const requestGenerationRef = useRef(0);
  const requestKeyRef = useRef(requestKey);

  useEffect(() => {
    requestKeyRef.current = requestKey;
    requestGenerationRef.current += 1;
    return () => {
      // Reject any load callback after scope replacement or unmount. The
      // shared bounded cache may still finish warming for another consumer.
      requestGenerationRef.current += 1;
    };
  }, [requestKey]);

  const prefetch = useCallback(() => {
    if (!scope || !requestKey) return;
    const generation = requestGenerationRef.current + 1;
    requestGenerationRef.current = generation;
    setLoadingKey(requestKey);
    void refreshActions().then(
      () => {
        if (
          requestGenerationRef.current !== generation ||
          requestKeyRef.current !== requestKey
        ) {
          return;
        }
        setLoadingKey("");
      },
      (error: unknown) => {
        if (
          requestGenerationRef.current !== generation ||
          requestKeyRef.current !== requestKey
        ) {
          return;
        }
        setLoadingKey("");
        Message.error(String(error));
      }
    );
  }, [refreshActions, requestKey, scope]);

  const handleSelect = useCallback(
    (item: SlashItem): boolean => {
      if (item.selection?.kind !== "work_item_quick_action") return false;
      closeMenu();
      const invocation = buildWorkItemQuickActionInvocation(item, scope, {
        actorId,
        actorName,
      });
      if (!invocation || !requestKey) {
        Message.error(
          t("workItems.quickActions.scopeChanged", {
            defaultValue: "Quick action is no longer in this Work Item scope",
          })
        );
        return true;
      }

      void projectApi.invokeQuickAction(invocation).then(
        () => {
          Message.success(
            t("workItems.quickActions.started", {
              defaultValue: "Quick action “{{name}}” started",
              name: item.name,
            })
          );
        },
        (error: unknown) => Message.error(String(error))
      );
      return true;
    },
    [actorId, actorName, closeMenu, requestKey, scope, t]
  );

  return {
    items: toQuickActionMenuDefinitions(cachedActions).map((action) =>
      quickActionToSlashItem(action, scope ?? undefined)
    ),
    loading: Boolean(requestKey) && loadingKey === requestKey,
    prefetch,
    handleSelect,
  };
}
