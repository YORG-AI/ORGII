import Modal from "@/src/scaffold/ModalSystem";
import { useAtomValue } from "jotai";
import { ArrowLeft, ArrowRight } from "lucide-react";
import React from "react";
import a11yDark from "react-syntax-highlighter/dist/esm/styles/prism/a11y-dark";
import oneLight from "react-syntax-highlighter/dist/esm/styles/prism/one-light";

import Breadcrumb from "@src/components/Breadcrumb";
import Markdown from "@src/components/MarkDown";
import { isThemeCssPathDark } from "@src/config/appearance/globalThemes";
import { themesAtom } from "@src/store";
import { getLanguageFromFilePath } from "@src/util/editor/extension";
import { PrismLight as SyntaxHighlighter } from "@src/util/language/prismLight";

interface ContentViewModalProps {
  visible: boolean;
  onClose: () => void;
  title?: string;
  content: string;
  breadcrumbSegments?: Array<{
    segment: string;
    index: number;
    isLast: boolean;
  }>;
  filePath?: string; // Used to determine file type
  useCodeRenderer?: boolean; // Whether to use code renderer
}

const ContentViewModal: React.FC<ContentViewModalProps> = ({
  visible,
  onClose,
  title = "Content View",
  content,
  breadcrumbSegments,
  filePath,
  useCodeRenderer = false,
}) => {
  const themes = useAtomValue(themesAtom);
  const isDarkTheme = () => isThemeCssPathDark(themes);

  // Get file language type
  const language = filePath ? getLanguageFromFilePath(filePath) : "typescript";

  // Count lines
  const lineCount = content.split("\n").length;

  return (
    <Modal
      visible={visible}
      onCancel={onClose}
      footer={null}
      className="content-view-modal custom-modal"
      style={{ width: "800px", maxHeight: "80vh" }}
    >
      {/* Header */}
      <div className="flex h-[48px] items-center justify-between rounded-t-lg border-b border-solid border-border-2 px-4">
        <div className="flex items-center gap-2">
          <ArrowLeft size={16} />
          <ArrowRight size={16} />
        </div>
        <div className="text-[16px] font-[500]">
          {breadcrumbSegments ? (
            <Breadcrumb>
              {breadcrumbSegments.map((item) => (
                <Breadcrumb.Item
                  key={item.index}
                  className={`${item.isLast ? "text-text-1" : "text-text-2"} truncate`}
                >
                  {item.segment}
                </Breadcrumb.Item>
              ))}
            </Breadcrumb>
          ) : (
            title
          )}
        </div>
        <div className="w-10"></div>
      </div>

      {/* Content Container */}
      <div className="m-2 flex flex-col rounded-lg border border-solid border-border-2 bg-bg-2">
        {/* Tab Header */}
        <div className="relative flex h-[50px] items-center justify-center border-b border-solid border-border-2 px-4">
          <div className="flex items-center gap-4">
            <span className="text-[14px] text-primary-6">Content</span>
          </div>
        </div>

        {/* Content Body */}
        <div className="max-h-[60vh] overflow-y-auto">
          <div className="fileContent w-full rounded p-4">
            {useCodeRenderer ? (
              (() => {
                const SyntaxHighlighterComponent =
                  SyntaxHighlighter as unknown as React.ComponentType<
                    React.PropsWithChildren<Record<string, unknown>>
                  >;
                return (
                  <SyntaxHighlighterComponent
                    className="code__font__style"
                    language={language}
                    style={isDarkTheme() ? a11yDark : oneLight}
                    customStyle={{
                      backgroundColor: "transparent",
                      background: "transparent",
                      border: "none",
                      fontSize: "12px",
                      fontFamily: "var(--code-font-family)",
                      margin: 0,
                      padding: 0,
                    }}
                    showLineNumbers
                    wrapLines
                    lineNumberStyle={{
                      minWidth: "3em",
                      paddingRight: "1em",
                      color: "rgb(var(--text-3))",
                      userSelect: "none",
                    }}
                  >
                    {content}
                  </SyntaxHighlighterComponent>
                );
              })()
            ) : (
              <Markdown textContent={content} darkMode={isDarkTheme()} />
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex h-[50px] items-center justify-between rounded-b-lg border-t border-solid border-border-2 px-4">
          <div className="flex items-center gap-2">
            <span className="text-[14px] font-medium text-text-1">
              Read Only
            </span>
            <span className="mx-1 text-[14px] text-text-3">|</span>
            <span className="text-[14px] text-text-3">
              {lineCount} lines, {content.length} characters
            </span>
            {useCodeRenderer && language && (
              <>
                <span className="mx-1 text-[14px] text-text-3">|</span>
                <span className="text-[14px] text-text-3">
                  Language: {language}
                </span>
              </>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
};

export default ContentViewModal;
