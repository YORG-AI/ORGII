import { ChevronRight, Eye, SquareArrowOutUpRight } from "lucide-react";
import React, { useState } from "react";
import { useTranslation } from "react-i18next";

import Breadcrumb from "@src/components/Breadcrumb";
import Checkbox from "@src/components/Checkbox";
import Collapse from "@src/components/Collapse";
import Radio from "@src/components/Radio";

import NotifyBottom from "./NotifyBottom";

const CollapseItem = Collapse.Item;
const BreadcrumbItem = Breadcrumb.Item;

interface ChatNotifyProps {
  icon: React.ReactNode;
  status: string;
  titleInfo: { title: string; color: string };
  list: {
    type: string;
    title: string[];
    handleView: () => void;
    handleItemRedirect: () => void;
    id?: string;
  }[];
  handleRedirect: () => void;
  handleApprove?: (params: {
    checkList: { title: string[]; id?: string }[];
  }) => void;
  handleFeedBack?: (params: {
    checkList: { title: string[]; id?: string }[];
  }) => void;
  handleReject?: (params: {
    checkList: { title: string[]; id?: string }[];
  }) => void;
  timeoutMin: number;
  handleTimeOut?: (params: {
    checkList: { title: string[]; id?: string }[];
  }) => void;
  showCheck: boolean;
  showBottom?: boolean;
  isSelected?: boolean;
  isSelectable?: boolean;
}

const ChatNotify: React.FC<ChatNotifyProps> = ({
  icon,
  status,
  titleInfo,
  list,
  handleApprove,
  handleFeedBack,
  handleReject,
  timeoutMin,
  handleTimeOut,
  showCheck,
  showBottom = true,
  isSelected = false,
  isSelectable = false,
}: ChatNotifyProps) => {
  const { t } = useTranslation("sessions");
  const [checkList, setCheckList] = useState<
    { title: string[]; id?: string }[]
  >([]);

  const handleOnCheck = (e: boolean, title: string[], id?: string) => {
    if (e) {
      setCheckList((prev) => [...prev, { title, id }]);
    } else {
      setCheckList((prev) => prev.filter((item) => item.title !== title));
    }
  };

  return (
    <div className="wp__chat__notify w-full">
      <Collapse defaultActiveKey={["1"]} style={{ width: "100%" }}>
        <CollapseItem
          key="1"
          header={
            <div className="flex items-center gap-2">
              {icon}
              <span
                className={`max-w-[100%] whitespace-normal break-words text-[14px] leading-[20px] ${titleInfo.color}`}
              >
                {titleInfo.title}
              </span>
            </div>
          }
          style={{ background: "bg-fill-1" }}
          expandIcon={
            <ChevronRight
              size={14}
              className="text-text-4"
              strokeWidth={1.75}
            />
          }
          extra={
            <>
              {!isSelectable && status === "approved" ? (
                <span className="chat-block-content text-success-6">
                  {t("chatStatus.approved")}
                </span>
              ) : !isSelectable && status === "responsed" ? (
                <span className="text-[14px] text-warning-1">
                  {t("chatStatus.responded")}
                </span>
              ) : null}
              {isSelectable && <Radio checked={isSelected} className="ml-1" />}
            </>
          }
        >
          <div className="flex flex-col justify-between gap-2 px-3 pb-3">
            <div className="flex flex-col">
              {list.map(
                ({ type, title, handleView, handleItemRedirect, id }) => (
                  <div
                    className="group flex h-[34px] w-full items-center justify-between rounded-md pl-4 pr-2 hover:bg-fill-2"
                    key={id || title.join("/")}
                  >
                    <div className="flex w-[90%] items-center gap-1.5">
                      {showCheck && (
                        <Checkbox
                          onCheckedChange={(checked) =>
                            handleOnCheck(checked, title, id)
                          }
                        />
                      )}
                      <Breadcrumb
                        className={"chat-block-content truncate"}
                        maxCount={5}
                      >
                        <BreadcrumbItem>{type}</BreadcrumbItem>
                        {(title.length > 5 ? title.slice(-3) : title).map(
                          (titlePart) => (
                            <BreadcrumbItem key={titlePart}>
                              {titlePart}
                            </BreadcrumbItem>
                          )
                        )}
                      </Breadcrumb>
                    </div>
                    <div className="hidden items-center gap-1.5 group-hover:flex">
                      <button
                        className="flex cursor-pointer items-center justify-center border-none bg-transparent p-0 text-text-2 hover:text-text-1"
                        onClick={handleView}
                      >
                        <Eye size={12} strokeWidth={1.75} />
                      </button>
                      <button
                        className="flex cursor-pointer items-center justify-center border-none bg-transparent p-0 text-text-2 hover:text-text-1"
                        onClick={handleItemRedirect}
                      >
                        <SquareArrowOutUpRight size={12} />
                      </button>
                    </div>
                  </div>
                )
              )}
            </div>

            {showBottom &&
              (handleApprove ||
                handleFeedBack ||
                handleReject ||
                handleTimeOut) && (
                <div className="w-full pl-4 pr-2">
                  <NotifyBottom
                    handleApprove={
                      handleApprove && (() => handleApprove({ checkList }))
                    }
                    handleFeedBack={
                      handleFeedBack && (() => handleFeedBack({ checkList }))
                    }
                    handleReject={
                      handleReject && (() => handleReject({ checkList }))
                    }
                    handleTimeOut={
                      handleTimeOut && (() => handleTimeOut({ checkList }))
                    }
                    timeoutMin={timeoutMin}
                  />
                </div>
              )}
          </div>
        </CollapseItem>
      </Collapse>
    </div>
  );
};

export default ChatNotify;
