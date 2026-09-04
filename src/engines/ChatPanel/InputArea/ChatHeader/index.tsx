import { useAtomValue } from "jotai";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { wingmanStop } from "@src/api/tauri/agent";
import { useChatContext } from "@src/contexts/workspace/ChatContext";
import { useStepState } from "@src/engines/SessionCore";
import { useSessionId } from "@src/engines/SessionCore/hooks/session";
import { createLogger } from "@src/hooks/logger";
import { useWingmanStatus } from "@src/hooks/wingman/useWingmanStatus";
import {
  Cancel01Icon,
  Clock01Icon,
  HugeiconsIcon,
  ScreenRotationIcon,
} from "@src/icons";
import { streamRetryStatusAtom } from "@src/store/session/cliSessionStatusAtom";

import StreamingHud from "./StreamingHud";

const log = createLogger("ChatHeader");

const ChatHeader = () => {
  const { t } = useTranslation("sessions");
  const { isStepWaiting } = useStepState();
  useChatContext();

  const streamRetryStatus = useAtomValue(streamRetryStatusAtom);
  const { sessionId } = useSessionId();
  const streamRetry =
    streamRetryStatus?.sessionId === sessionId ? streamRetryStatus : null;
  const { activeSessionId: wingmanSessionId } = useWingmanStatus();
  const isWingmanActive = !!sessionId && wingmanSessionId === sessionId;

  const [feedBackInfo, setFeedBackInfo] = useState({ isFeedBack: false });

  return (
    <div className="relative flex flex-col">
      {isWingmanActive && (
        <div className="mx-auto mb-1 flex w-full items-center justify-center">
          <div className="flex h-[24px] items-center gap-1.5 rounded-full border border-solid border-primary-3 bg-primary-1 px-3 text-[12px] text-primary-7">
            <HugeiconsIcon
              icon={ScreenRotationIcon}
              data-icon="airplay"
              size={12}
              strokeWidth={1.75}
              className="animate-pulse"
            />
            <span>{t("chat.wingmanActive")}</span>
            <button
              type="button"
              className="ml-1 flex items-center gap-1 text-primary-5 hover:text-primary-7"
              title={t("chat.stopWingman")}
              onClick={() => {
                if (sessionId) {
                  wingmanStop(sessionId).catch(log.error);
                }
              }}
            >
              <HugeiconsIcon
                icon={Cancel01Icon}
                data-icon="x"
                size={11}
                strokeWidth={1.75}
              />
            </button>
          </div>
        </div>
      )}

      {/* Live streaming telemetry — suppressed while a retry is in flight,
          since a stalled stream produces no meaningful throughput. */}
      {!streamRetry && <StreamingHud sessionId={sessionId} />}

      {isStepWaiting && (
        <div className="bottom-[54px] mx-auto flex w-full items-center justify-between">
          {feedBackInfo.isFeedBack && (
            <div className="flex items-center gap-2">
              <div className="flex h-[28px] w-auto items-center gap-2 rounded-full border border-solid border-border-2 px-4">
                <HugeiconsIcon
                  icon={Clock01Icon}
                  data-icon="clock"
                  size={14}
                  strokeWidth={1.75}
                  className="text-text-2"
                />
                <span className="text-[14px] leading-0 text-text-2">
                  {t("chat.feedbackPending")}
                </span>
              </div>

              <button
                className="flex cursor-pointer items-center justify-center border-none bg-transparent p-0 text-text-2 hover:text-text-1"
                onClick={() => {
                  setFeedBackInfo({ isFeedBack: false });
                }}
              >
                <HugeiconsIcon
                  icon={Cancel01Icon}
                  data-icon="x"
                  size={16}
                  strokeWidth={1.75}
                />
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
export default ChatHeader;
