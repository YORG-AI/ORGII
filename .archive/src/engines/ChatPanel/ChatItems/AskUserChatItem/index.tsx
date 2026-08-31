import Button from "@/src/components/Button";
import React, { memo, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import Collapse from "@src/components/Collapse";
import Input from "@src/components/Input";
import Textarea from "@src/components/Textarea";
import { ChevronsDownUpIcon, HugeiconsIcon, UnfoldMoreIcon } from "@src/icons";

import "./index.scss";

interface InputField {
  key: string;
  label: string;
  type: "text" | "password" | "textarea";
  required: boolean;
  placeholder?: string;
}

interface AskUserChatItemProps {
  eventId: string;
  question: string;
  inputFields: InputField[];
  status: "pending" | "approved" | "responsed" | "ignored";
  onSubmit: (eventId: string, answers: Record<string, string>) => void;
  onSkip: (eventId: string) => void;
}

const AskUserChatItem: React.FC<AskUserChatItemProps> = memo(
  ({ eventId, question, inputFields, status, onSubmit, onSkip }) => {
    const { t } = useTranslation("sessions");
    const [isExpanded, setIsExpanded] = useState(true);
    const [answers, setAnswers] = useState<Record<string, string>>({});

    // Check if all required fields are filled
    const canSubmit = useMemo(() => {
      return inputFields.every((field) => {
        if (field.required) {
          return answers[field.key]?.trim();
        }
        return true;
      });
    }, [inputFields, answers]);

    const handleInputChange = useCallback((key: string, value: string) => {
      setAnswers((prev) => ({ ...prev, [key]: value }));
    }, []);

    const handleSubmit = useCallback(() => {
      if (canSubmit) {
        onSubmit(eventId, answers);
      }
    }, [canSubmit, eventId, answers, onSubmit]);

    const handleSkip = useCallback(() => {
      onSkip(eventId);
    }, [eventId, onSkip]);

    const isPending = status === "pending" || status === "approved";
    // Handled (responsed/ignored) = Blue primary-6
    // Pending (pending/approved) = Orange warning-5
    const isHandled = status === "responsed" || status === "ignored";
    const indicatorColor = isHandled ? "bg-primary-4" : "bg-warning-4";
    const titleColor = isHandled ? "text-primary-6" : "text-warning-6";

    return (
      <div className="ask-user-chat-item w-full">
        {/* Left indicator line + content area */}
        <div className="flex">
          {/* Left indicator line: Blue for handled, orange for pending */}
          <div className={`w-[2px] flex-shrink-0 ${indicatorColor}`} />
          {/* Content area */}
          <div className="flex-1">
            <Collapse
              activeKey={isExpanded ? ["1"] : []}
              onChange={(key: string | string[]) => {
                const keys = Array.isArray(key) ? key : [key];
                setIsExpanded(keys.includes("1"));
              }}
              style={{ background: "transparent", border: "none" }}
            >
              <Collapse.Item
                key="1"
                header={
                  <div className="flex items-center gap-1">
                    <span className={`text-[14px] font-[500] ${titleColor}`}>
                      {isHandled
                        ? "You responded to agent's question(s)"
                        : "Agent has questions for you"}
                      {!isHandled &&
                        inputFields.some((field) => field.required) && (
                          <span className={`ml-1 ${titleColor}`}>
                            (required)
                          </span>
                        )}
                    </span>
                    {isExpanded ? (
                      <HugeiconsIcon
                        icon={ChevronsDownUpIcon}
                        data-icon="chevrons-down-up"
                        size={14}
                        strokeWidth={1.75}
                        className="ml-1 text-text-3"
                      />
                    ) : (
                      <HugeiconsIcon
                        icon={UnfoldMoreIcon}
                        data-icon="chevrons-up-down"
                        size={14}
                        strokeWidth={1.75}
                        className="ml-1 text-text-3"
                      />
                    )}
                  </div>
                }
                showArrow={false}
                extra={
                  status === "responsed" ? (
                    <span className="chat-block-content text-primary-6">
                      Submitted
                    </span>
                  ) : status === "ignored" ? (
                    <span className="chat-block-content text-text-3">
                      {t("chatStatus.skipped")}
                    </span>
                  ) : status === "approved" ? (
                    <span className="chat-block-content text-success-6">
                      {t("chatStatus.approved")}
                    </span>
                  ) : (
                    <span className="chat-block-content text-warning-6">
                      {t("chatStatus.pending")}
                    </span>
                  )
                }
                style={{ background: "transparent" }}
              >
                <div className="flex flex-col gap-4 px-4 pb-4">
                  {/* Question text */}
                  <div className="question-text text-[14px] text-text-1">
                    {inputFields.map((field) => (
                      <div key={field.key} className="mb-3">
                        <div className="mb-2 flex items-start gap-1">
                          {field.required && (
                            <span className="text-danger-6">*</span>
                          )}
                          <span className="text-[14px] text-text-1">
                            {field.label || question}
                          </span>
                        </div>

                        {/* Input field */}
                        {isPending ? (
                          field.type === "textarea" ? (
                            <Textarea
                              placeholder={
                                field.placeholder || t("chat.enterYourAnswer")
                              }
                              value={answers[field.key] || ""}
                              onChange={(value: string) =>
                                handleInputChange(field.key, value)
                              }
                              autoSize={{ minRows: 3, maxRows: 6 }}
                              className="ask-user-input"
                            />
                          ) : (
                            <Input
                              type={
                                field.type === "password" ? "password" : "text"
                              }
                              placeholder={
                                field.placeholder || t("chat.enterYourAnswer")
                              }
                              value={answers[field.key] || ""}
                              onChange={(value) =>
                                handleInputChange(field.key, value)
                              }
                              className="ask-user-input"
                            />
                          )
                        ) : (
                          <div className="rounded-lg bg-bg-3 px-3 py-2 text-[14px] text-text-2">
                            {field.type === "password"
                              ? "••••••••••••••••••••"
                              : answers[field.key] ||
                                t("chat.noAnswerProvided")}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>

                  {/* Button area */}
                  {isPending && (
                    <div className="flex items-center gap-3">
                      <Button
                        variant="primary"
                        appearance="outline"
                        onClick={handleSubmit}
                        disabled={!canSubmit}
                        className="submit-btn bg-bg-2"
                      >
                        {t("chat.submit")}
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={handleSkip}
                        className="skip-btn bg-bg-2"
                      >
                        {t("chat.skip")}
                      </Button>
                    </div>
                  )}
                </div>
              </Collapse.Item>
            </Collapse>
          </div>
        </div>
      </div>
    );
  }
);

AskUserChatItem.displayName = "AskUserChatItem";

export default AskUserChatItem;
