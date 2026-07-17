import Button from "@/src/components/Button";
import { useAtomValue } from "jotai";
import React, { memo, useEffect, useState } from "react";

import { ChatBubbleCopyButton } from "@src/components/ChatBubble";
import Markdown from "@src/components/MarkDown";
import { containsMarkdownFence } from "@src/components/MarkDown/markdownUtils";
import { isThemeCssPathDark } from "@src/config/appearance/globalThemes";
import { themesAtom } from "@src/store";
import { chatAppearanceAtom } from "@src/store/config/configAtom";

import TypewriterText from "../components/TypewriterText";

/**
 * Messages created within this window before mounting count as "fresh" and
 * get the typewriter reveal; anything older is history and renders in full.
 */
const TYPEWRITER_FRESH_WINDOW_MS = 5_000;

interface AgentChatItemProps {
  children: string;
  expand: boolean;
  finish: boolean;
  handleResultClick?: () => void;
  resultPresent?: boolean;
  title?: string;
  itemIndex: number;
  streamHtml?: boolean;
  /**
   * ISO timestamp of the underlying message. Gates the typewriter effect:
   * only a message that arrived moments before mounting types out —
   * history loaded from a past session renders in full immediately.
   */
  messageTimestamp?: string;
  /** Container width for code block diff view */
  codeBlockContainerWidth?: number;
  /** Current check status (for showing result indicator) */
  curCheckStatus?: string;
  appendedContent?: React.ReactNode;
  /** Whether to render the legacy hover copy button over the message body. */
  showCopyButton?: boolean;
}
const AgentChatItemDefault: React.FC<AgentChatItemProps> = ({
  children,
  expand,
  handleResultClick,
  title,
  streamHtml,
  messageTimestamp,
  codeBlockContainerWidth,
  curCheckStatus,
  appendedContent,
  showCopyButton = true,
}) => {
  const [isShow, setIsShow] = useState(expand);
  const themes = useAtomValue(themesAtom);
  const chatAppearance = useAtomValue(chatAppearanceAtom);

  const isStreaming = Boolean(streamHtml);
  const hasCodeBlockCopy = !isStreaming && containsMarkdownFence(children);

  // Typewriter applies ONLY to a fresh, non-streamed message:
  // - history rows (loaded from a past session) render in full immediately
  //   (freshness gate: created moments before mount);
  // - a message that streamed in this mount already revealed itself token by
  //   token — re-typing it after completion would be a regression.
  const [hasStreamed, setHasStreamed] = useState(isStreaming);
  if (isStreaming && !hasStreamed) {
    // Official render-time state adjustment: remember that this mount saw
    // the message stream, so completion doesn't re-type it.
    setHasStreamed(true);
  }
  const [isFreshAtMount] = useState(() => {
    if (!messageTimestamp) return false;
    const createdMs = new Date(messageTimestamp).getTime();
    return (
      Number.isFinite(createdMs) &&
      Date.now() - createdMs < TYPEWRITER_FRESH_WINDOW_MS
    );
  });
  const shouldUseTypewriterEffect =
    !isStreaming &&
    !hasStreamed &&
    isFreshAtMount &&
    chatAppearance.decryptEffectEnabled;

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
              {showCopyButton &&
                !isStreaming &&
                children &&
                !hasCodeBlockCopy && (
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
                ) : shouldUseTypewriterEffect ? (
                  <TypewriterText
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

export default memo(AgentChatItemDefault);
