import Button from "@/src/components/Button";
import { useAtomValue } from "jotai";
import React, { useEffect, useState } from "react";

import { ChatBubbleCopyButton } from "@src/components/ChatBubble";
import Markdown from "@src/components/MarkDown";
import { isThemeCssPathDark } from "@src/config/appearance/globalThemes";
import { themesAtom } from "@src/store";
import { chatAppearanceAtom } from "@src/store/config/configAtom";

import DecryptedText from "../components/DecryptedText";

interface AgentChatItemProps {
  children: string;
  expand: boolean;
  finish: boolean;
  handleResultClick?: () => void;
  resultPresent?: boolean;
  title?: string;
  itemIndex: number;
  streamHtml?: boolean;
  /** Container width for code block diff view */
  codeBlockContainerWidth?: number;
  /** Current check status (for showing result indicator) */
  curCheckStatus?: string;
  appendedContent?: React.ReactNode;
}
const AgentChatItemDefault: React.FC<AgentChatItemProps> = ({
  children,
  expand,
  handleResultClick,
  title,
  streamHtml,
  codeBlockContainerWidth,
  curCheckStatus,
  appendedContent,
}) => {
  const [isShow, setIsShow] = useState(expand);
  const themes = useAtomValue(themesAtom);
  const chatAppearance = useAtomValue(chatAppearanceAtom);

  const isStreaming = Boolean(streamHtml);
  const shouldUseDecryptEffect =
    !isStreaming && chatAppearance.decryptEffectEnabled;

  useEffect(() => {
    setIsShow(expand);
  }, [expand]);

  return (
    <div className="group/agent-msg box-border flex w-full flex-row items-stretch self-stretch">
      <div className="relative flex min-w-0 flex-1 flex-col items-start gap-2">
        {isShow && (
          <>
            <div
              className="chat-text relative flex flex-col items-start gap-3 self-stretch text-text-1"
              data-testid="chat-message-assistant"
            >
              {!isStreaming && children && (
                <ChatBubbleCopyButton
                  content={children}
                  hoverGroupClass="group-hover/agent-msg:opacity-100"
                  placement="message-corner"
                />
              )}
              <div className="resultBgc allow-select w-full overflow-visible break-words font-normal">
                {isStreaming ? (
                  children?.length > 0 ? (
                    <Markdown
                      textContent={children}
                      useChatCodeBlock={true}
                      codeBlockContainerWidth={codeBlockContainerWidth}
                      enableFileNavigation={false}
                      streaming
                      skipPreprocess={true}
                    />
                  ) : (
                    <span className="text-text-3"> </span>
                  )
                ) : shouldUseDecryptEffect ? (
                  <DecryptedText
                    text={children}
                    speed={chatAppearance.typingSpeed}
                    className="allow-select"
                  />
                ) : (
                  <Markdown
                    textContent={children || ""}
                    useChatCodeBlock={true}
                    codeBlockContainerWidth={codeBlockContainerWidth}
                    enableFileNavigation={true}
                    skipPreprocess={true}
                  />
                )}

                {handleResultClick &&
                  (curCheckStatus === title ? (
                    <div
                      className={`chat-text-sm mr-3 mt-3 flex h-6 w-[6rem] items-center justify-center rounded-[1.75rem] border border-solid border-primary-5 bg-primary-1 ${
                        isThemeCssPathDark(themes)
                          ? "text-text-1"
                          : "text-primary-5"
                      } `}
                    >
                      <p>{"Result"}</p>
                    </div>
                  ) : (
                    <div>
                      <Button
                        variant="secondary"
                        onClick={handleResultClick}
                        className="chat-text-sm mb-1 mt-3 h-[24px] rounded-[100px] py-[2px]"
                      >
                        {"Result"}
                      </Button>
                    </div>
                  ))}
                {appendedContent}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default AgentChatItemDefault;
