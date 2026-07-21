import { useAtomValue, useSetAtom } from "jotai";
import { GitFork } from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import Message from "@src/components/Message";
import Tag from "@src/components/Tag";
import Tooltip from "@src/components/Tooltip";
import { org2CloudRemoteSessionsAtom } from "@src/features/Org2Cloud/org2CloudRemoteSessionsAtom";
import { useCloudSessionActions } from "@src/features/Org2Cloud/useCloudSessionActions";
import { useSessionView } from "@src/hooks/ui/tabs/useSessionView";
import { openOrReplaceSessionInChatPanelTabAtom } from "@src/store/chatPanel/chatPanelTabsAtom";
import { sessionsAtom } from "@src/store/session/sessionAtom/atoms";
import type { Session } from "@src/store/session/sessionAtom/types";

import { getSessionForkedFrom } from "../../forkSession";
import type { ForkImportedErrorKind } from "../../useForkImportedSession";
import { useForkImportedSession } from "../../useForkImportedSession";

const FORK_ERROR_KEYS: Record<
  Exclude<ForkImportedErrorKind, "cancelled">,
  string
> = {
  retention: "collaboration.forkImported.retentionError",
  gone: "collaboration.forkImported.goneError",
  replay: "collaboration.forkImported.replayError",
  snapshot: "collaboration.forkImported.snapshotError",
  agent: "collaboration.forkImported.agentError",
  backend: "collaboration.forkImported.backendError",
  generic: "collaboration.forkImported.error",
};

export interface SessionForkHeaderExtrasProps {
  session: Session | null;
}

const SessionForkHeaderExtras: React.FC<SessionForkHeaderExtrasProps> = ({
  session,
}) => {
  const { t } = useTranslation("navigation");
  const { openSession } = useSessionView();
  const openOrReplaceSessionTab = useSetAtom(
    openOrReplaceSessionInChatPanelTabAtom
  );
  const { fork, state } = useForkImportedSession(session);
  const sessions = useAtomValue(sessionsAtom);
  const remoteEntries = useAtomValue(org2CloudRemoteSessionsAtom);
  const forkedFrom = session ? getSessionForkedFrom(session) : undefined;
  const { replaySession: openRemoteParent } = useCloudSessionActions(
    forkedFrom?.orgId ?? null
  );

  if (!session) return null;
  const showForkButton = Boolean(session.importedFrom);
  if (!showForkButton && !forkedFrom) return null;

  const handleFork = async (): Promise<void> => {
    if (state === "forking") return;
    const outcome = await fork();
    if (!outcome.ok) {
      if (outcome.errorKind !== "cancelled") {
        Message.error(t(FORK_ERROR_KEYS[outcome.errorKind]));
      }
      return;
    }
    openSession(outcome.localSessionId, outcome.name, outcome.repoPath);
  };

  const handleOpenParent = async (): Promise<void> => {
    if (!forkedFrom) return;
    const localMatch = sessions.find(
      (candidate) =>
        candidate.session_id === forkedFrom.sourceSessionId ||
        (candidate.importedFrom?.orgId === forkedFrom.orgId &&
          candidate.importedFrom.sourceSessionId === forkedFrom.sourceSessionId)
    );
    if (localMatch) {
      openOrReplaceSessionTab({
        sessionId: localMatch.session_id,
        sessionName: localMatch.name,
        repoPath: localMatch.repoPath,
      });
      openSession(localMatch.session_id, localMatch.name, localMatch.repoPath);
      return;
    }
    const remoteMatch = remoteEntries[forkedFrom.orgId]?.rows.find(
      (entry) => entry.sourceSessionId === forkedFrom.sourceSessionId
    );
    if (remoteMatch) {
      const outcome = await openRemoteParent(remoteMatch);
      if (outcome === "opened") return;
    }
    Message.info(t("collaboration.forkImported.parentOpenUnavailable"));
  };

  const forkLabel = t("collaboration.forkImported.headerButton");
  return (
    <>
      {forkedFrom && (
        <Tooltip
          content={t("collaboration.forkImported.forkedChipTooltip", {
            name: forkedFrom.ownerDisplayName,
          })}
          position="bottom-end"
          mouseEnterDelay={200}
          framedPanel
        >
          {/* Tag owns the pill chrome; the wrapper button carries focus, testid
              and click affordance. The control is not a link because the
              resolver may need to open an already materialized local copy. */}
          <button
            type="button"
            data-testid="session-forked-from-chip"
            className="mr-1 inline-flex cursor-pointer border-0 bg-transparent p-0"
            onClick={() => void handleOpenParent()}
            aria-label={t("collaboration.forkImported.openParentButton", {
              name: forkedFrom.ownerDisplayName,
            })}
          >
            <Tag
              size="mini"
              pill
              bordered
              icon={<GitFork size={10} strokeWidth={1.75} />}
              className="h-[20px] max-w-[140px]"
            >
              <span className="truncate">{forkedFrom.ownerDisplayName}</span>
            </Tag>
          </button>
        </Tooltip>
      )}
      {showForkButton && (
        <Tooltip
          content={t("collaboration.forkImported.headerTooltip")}
          position="bottom-end"
          mouseEnterDelay={200}
          framedPanel
        >
          <span className="inline-flex">
            <Button
              htmlType="button"
              variant="tertiary"
              size="small"
              iconOnly
              loading={state === "forking"}
              onClick={() => void handleFork()}
              aria-label={forkLabel}
              data-testid="session-fork-button"
              icon={<GitFork size={14} strokeWidth={2} />}
            />
          </span>
        </Tooltip>
      )}
    </>
  );
};

export default SessionForkHeaderExtras;
