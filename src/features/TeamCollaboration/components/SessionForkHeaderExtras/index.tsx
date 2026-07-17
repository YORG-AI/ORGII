/**
 * SessionForkHeaderExtras — chat-panel header contributions for the fork
 * relay (design §16.11), self-contained so the header prop plumbing stays a
 * single ReactNode:
 *
 * - explicit Fork button when the open session is an imported teammate copy
 *   (`Session.importedFrom`) — same relay as the collab/cloud panel row
 *   action, resolved back to the right backend by org id;
 * - "⑂ @owner" provenance chip when the open session IS a fork
 *   (`getSessionForkedFrom`, registry-backed so it survives list reloads);
 * - "Addressing comment: …" provenance chip when the fork was created by the
 *   comment-task runner (agent-pickup design §4 UI-5) — registry
 *   `taskContext` on the runner's machine, wire `addressesComment` on a
 *   teammate's imported copy of the pushed fork (see `addressingComment.ts`).
 *   Non-interactive like the ⑂ chip: the source thread lives on the SOURCE
 *   session (usually another machine's), and no cross-session thread-open
 *   navigation exists in the header — the chip is attribution, not a link.
 */
import { useAtomValue } from "jotai";
import { Cloud, GitFork, MessageSquare } from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";

import { IMPORTED_HISTORY_SOURCE_DESCRIPTORS } from "@src/api/tauri/externalHistory";
import Button from "@src/components/Button";
import Message from "@src/components/Message";
import Tag from "@src/components/Tag";
import Tooltip from "@src/components/Tooltip";
import { org2CloudRemoteSessionsAtom } from "@src/features/Org2Cloud/org2CloudRemoteSessionsAtom";
import { useSessionView } from "@src/hooks/ui/tabs/useSessionView";
import type { Session } from "@src/store/session/sessionAtom/types";

import { getSessionForkedFrom, getSessionTaskContext } from "../../forkSession";
import type { ForkImportedErrorKind } from "../../useForkImportedSession";
import { useForkImportedSession } from "../../useForkImportedSession";
import { resolveAddressingComment } from "./addressingComment";

const FORK_ERROR_KEYS: Record<
  Exclude<ForkImportedErrorKind, "cancelled">,
  string
> = {
  retention: "collaboration.forkImported.retentionError",
  gone: "collaboration.forkImported.goneError",
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
  const { fork, state } = useForkImportedSession(session);
  const remoteEntries = useAtomValue(org2CloudRemoteSessionsAtom);

  if (!session) return null;
  const forkedFrom = getSessionForkedFrom(session);
  const addressing = resolveAddressingComment({
    taskContext: getSessionTaskContext(session),
    importedFrom: session.importedFrom,
    remoteEntries,
  });
  const showForkButton = Boolean(session.importedFrom);
  const externalSource = IMPORTED_HISTORY_SOURCE_DESCRIPTORS.find(
    (source) => source.sourceId === session.importedFrom?.externalHistorySource
  );
  if (!showForkButton && !forkedFrom && !addressing) return null;

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

  const forkLabel = t("collaboration.forkImported.headerButton");
  // The registry carrier has the bounded thread-head excerpt; the wire
  // carrier (teammate view) deliberately does not — generic copy there.
  const addressingLabel = addressing?.excerpt
    ? t("cloud.comments.task.addressingChip", {
        excerpt: addressing.excerpt,
      })
    : t("cloud.comments.task.addressingChipGeneric");
  const addressingTooltip = addressing?.excerpt
    ? // The chip truncates; the tooltip carries the full quoted excerpt.
      addressingLabel
    : t("cloud.comments.task.addressingChipTooltip");

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
          {/* Tag owns the pill chrome; the wrapper span carries the testid
              (Tag does not forward data-* props) and the header placement. */}
          <span
            data-testid="session-forked-from-chip"
            className="mr-1 inline-flex"
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
          </span>
        </Tooltip>
      )}
      {addressing && (
        <Tooltip
          content={addressingTooltip}
          position="bottom-end"
          mouseEnterDelay={200}
          framedPanel
        >
          {/* Same non-interactive Tag treatment as the ⑂ chip above — the
              wrapper span carries the testid and header placement. */}
          <span
            data-testid="session-addressing-comment-chip"
            className="mr-1 inline-flex"
          >
            <Tag
              size="mini"
              pill
              bordered
              icon={<MessageSquare size={10} strokeWidth={1.75} />}
              className="h-[20px] max-w-[180px]"
            >
              <span className="truncate">{addressingLabel}</span>
            </Tag>
          </span>
        </Tooltip>
      )}
      {showForkButton && session.importedFrom && (
        <Tooltip
          content={t("collaboration.forkImported.sourceChipTooltip", {
            name:
              session.importedFrom.ownerDisplayName ??
              session.importedFrom.ownerMemberId ??
              "",
          })}
          position="bottom-end"
          mouseEnterDelay={200}
          framedPanel
        >
          {/* Provenance for an imported teammate REPLAY (not a fork): who
              shared it. Non-interactive, mirrors the ⑂ forked-from chip. */}
          <span
            data-testid="session-imported-from-chip"
            className="mr-1 inline-flex"
          >
            <Tag
              size="mini"
              pill
              bordered
              icon={<Cloud size={10} strokeWidth={1.75} />}
              className="h-[20px] max-w-[140px]"
            >
              <span className="truncate">
                {[
                  externalSource?.displayName,
                  session.importedFrom.ownerDisplayName ??
                    session.importedFrom.ownerMemberId,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </Tag>
          </span>
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
