import Button from "@/src/components/Button";
import React from "react";
import { useTranslation } from "react-i18next";

import CountdownTimer from "@src/components/CountdownTimer";

interface NotifyBottomProps {
  handleApprove?: () => void;
  handleFeedBack?: () => void;
  handleReject?: () => void;
  handleTimeOut?: () => void;
  handleApply?: () => void;
  handleIgnore?: () => void;
  timeoutMin?: number;
  primaryButtonText?: string;
  secondaryButtonText?: string;
  showApplyIgnore?: boolean;
  applyText?: string;
  ignoreText?: string;
}

const NotifyBottom: React.FC<NotifyBottomProps> = ({
  handleApprove,
  handleFeedBack,
  handleReject,
  handleTimeOut,
  handleApply,
  handleIgnore,
  timeoutMin,
  primaryButtonText,
  secondaryButtonText,
  showApplyIgnore = false,
  applyText = "Reply",
  ignoreText = "Ignore",
}) => {
  const { t } = useTranslation("sessions");
  return (
    <div className="relative flex flex-col">
      <div className="bottom-[54px] mx-auto flex w-full items-center justify-between">
        <div className="flex items-center gap-3">
          {showApplyIgnore ? (
            <>
              {handleApply && (
                <Button
                  variant="primary"
                  appearance="outline"
                  className="flex h-[24px] items-center justify-center rounded-full border-warning-6 px-4 text-warning-6 hover:bg-primary-1"
                  onClick={handleApply}
                >
                  <span className="chat-block-content">{applyText}</span>
                </Button>
              )}
              {handleIgnore && (
                <Button
                  variant="secondary"
                  className="flex h-[24px] items-center justify-center rounded-full bg-bg-1 px-4 text-text-2 hover:bg-fill-2"
                  onClick={handleIgnore}
                >
                  <span className="chat-block-content">{ignoreText}</span>
                </Button>
              )}
            </>
          ) : (
            <>
              {handleApprove && (
                <Button
                  variant="primary"
                  appearance="outline"
                  className="h-6 rounded-full"
                  onClick={handleApprove}
                >
                  <span className="chat-block-content relative bottom-[1px] leading-[0px]">
                    {primaryButtonText || "Approve"}
                  </span>
                </Button>
              )}
              {handleReject && (
                <Button
                  variant="secondary"
                  className="h-6 rounded-full"
                  onClick={handleReject}
                >
                  <span className="chat-block-content">
                    {t("common:actions.rejectAll")}
                  </span>
                </Button>
              )}
              {handleFeedBack && (
                <div
                  className="flex cursor-pointer items-center gap-2 rounded-[100px] border border-solid border-border-2 bg-fill-2 px-3 py-[2px]"
                  onClick={handleFeedBack}
                >
                  <span className="chat-block-content text-text-2">
                    {secondaryButtonText || "Give Feedback"}
                  </span>
                </div>
              )}
            </>
          )}
        </div>

        {timeoutMin && (
          <CountdownTimer
            minutes={timeoutMin}
            onCountdownEnd={handleTimeOut ? () => handleTimeOut() : () => {}}
          />
        )}
      </div>
    </div>
  );
};

export default NotifyBottom;
