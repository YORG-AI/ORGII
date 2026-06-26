/**
 * Markdown Component (Implementation)
 *
 * Renders markdown content with syntax highlighting.
 *
 * Performance optimizations:
 * - Memoized component to prevent re-parsing unchanged content
 * - Static style objects moved outside component
 * - Memoized theme selection
 * - Custom comparison based on textContent
 *
 * NOTE: This file is lazy-loaded via index.tsx to avoid pulling ~700KB of
 * react-markdown + react-syntax-highlighter into the initial bundle.
 */
import { useAtomValue } from "jotai";
import { ArrowUpRight, Check, Clipboard } from "lucide-react";
import React, { memo, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown, { type Components } from "react-markdown";
import { Prism as SyntaxHighlighterPrism } from "react-syntax-highlighter";
import remarkGfm from "remark-gfm";

import Button from "@src/components/Button";
import { isThemeCssPathDark } from "@src/config/appearance/globalThemes";
import { getLanguageFromPath } from "@src/config/languageMap";
import CanvasInlineCard from "@src/engines/ChatPanel/blocks/CanvasInlineCard";
import ChatCodeBlock from "@src/engines/ChatPanel/blocks/CodeBlock";
import { codeMirrorPrismTheme } from "@src/features/CodeMirror/themes";
import { useCopyCheck } from "@src/hooks/ui";
import { themesAtom } from "@src/store";
import { activeWorkspaceRootAtom } from "@src/store/workspace";
import { copyText } from "@src/util/data/clipboard";
import { openFileInWorkStation } from "@src/util/ui/openFileInWorkStation";

import MermaidBlock from "./MermaidBlock";
import "./index.scss";
import {
  detectCodeType,
  openFileInEditor,
  openUrlInBrowserApp,
  preprocessTextContent,
  renderChildren,
} from "./markdownUtils";

const SyntaxHighlighter =
  SyntaxHighlighterPrism as unknown as React.ComponentType<
    Record<string, unknown>
  >;

/**
 * Fenced language aliases that trigger CanvasInlineCard instead of a code
 * block. The agent writes ```canvas or ```preview with a JSON payload.
 *
 * Payload schema (JSON on a single line or pretty-printed):
 *   { "mode": "html"|"url"|"a2ui", "content"?: "...", "url"?: "...", "title"?: "..." }
 */
const CANVAS_FENCED_LANGUAGES = new Set([
  "canvas",
  "preview",
  "canvas-html",
  "canvas-url",
  "canvas-a2ui",
]);

type CanvasFencedMode = "html" | "url" | "a2ui";

function isCanvasFencedMode(value: unknown): value is CanvasFencedMode {
  return value === "html" || value === "url" || value === "a2ui";
}

/**
 * Fenced languages whose title bar adds little value next to the snippet itself.
 * File-backed code references still keep their header because `filePath` is set.
 */
const CHAT_CODE_BLOCK_HIDE_HEADER_LANGUAGES = new Set([
  "bash",
  "fish",
  "plaintext",
  "powershell",
  "ps1",
  "sh",
  "shell",
  "text",
  "txt",
  "zsh",
]);

interface CodeFenceMeta {
  language: string;
  filePath?: string;
  title?: string;
  startLine?: string;
  endLine?: string;
}

function parseCodeFenceMeta(rawInfo: string): CodeFenceMeta {
  const referenceMatch = rawInfo.match(/^(\d+):(\d+):(.+)$/);
  if (referenceMatch) {
    const startLine = referenceMatch[1];
    const endLine = referenceMatch[2];
    const filePath = referenceMatch[3];
    const fileName = filePath.split("/").pop() || filePath;
    return {
      language: getLanguageFromPath(filePath, "text") || "text",
      filePath,
      title: fileName,
      startLine,
      endLine,
    };
  }

  return { language: rawInfo || "text" };
}

// ============================================
// Types
// ============================================

export interface MarkdownProps {
  textContent: string;
  darkMode?: boolean;
  onEditorScroll?: (scrollTop: number) => void;
  researchMode?: boolean;
  /** Use ChatCodeBlock component for code blocks (collapsible, scrollable) */
  useChatCodeBlock?: boolean;
  /** Container width for ChatCodeBlock (for diff view) */
  codeBlockContainerWidth?: number;
  /** Enable clicking on inline code to open files in editor */
  enableFileNavigation?: boolean;
  /**
   * Render content in stable chunks while text is actively streaming. Completed
   * paragraph blocks are memoized, so only the current tail is reparsed on token
   * updates instead of the full message.
   */
  streaming?: boolean;
  /**
   * Skip the heavyweight preprocessTextContent pass (code auto-detection regexes).
   * Set to true when content is already well-formatted markdown (e.g., agent output
   * that arrives after streaming completes — the text was already sanitized on the
   * streaming path).
   */
  skipPreprocess?: boolean;
}

// ============================================
// Static Styles (moved outside component for performance)
// ============================================

const CODE_CUSTOM_STYLE: React.CSSProperties = {
  fontFamily: "var(--cm-font-family)",
  fontSize: "12px",
  lineHeight: "1.6",
  margin: 0,
  padding: "12px 14px",
  borderRadius: "8px",
  background: "transparent",
};

const CODE_WRAPPER_STYLE: React.CSSProperties = {
  border: "none",
  borderRadius: "8px",
  margin: "8px 0",
};

const STREAMING_BLOCK_GAP_CLASS = "mt-3";

function splitIntoStableMarkdownBlocks(content: string): string[] {
  if (!content) return [""];

  const blocks: string[] = [];
  let blockStart = 0;
  let inFence = false;
  let index = 0;

  while (index < content.length) {
    if (
      content[index] === "`" &&
      index + 2 < content.length &&
      content[index + 1] === "`" &&
      content[index + 2] === "`"
    ) {
      inFence = !inFence;
      index += 3;
      continue;
    }

    if (
      !inFence &&
      content[index] === "\n" &&
      index + 1 < content.length &&
      content[index + 1] === "\n"
    ) {
      const block = content.slice(blockStart, index + 2);
      if (block.trim()) blocks.push(block);
      blockStart = index + 2;
      index = blockStart;
      continue;
    }

    index += 1;
  }

  blocks.push(content.slice(blockStart));
  return blocks;
}

// ============================================
// Memoized Code Block Component
// ============================================

interface CodeBlockProps {
  children: string;
  language: string;
  startLine?: string;
  openFilePath?: string;
}

const CodeBlock = memo<CodeBlockProps>(
  ({ children, language, startLine, openFilePath }) => {
    const onCopyContent = useCallback(async () => {
      await copyText(children);
    }, [children]);
    const { copied, handleCopy } = useCopyCheck(onCopyContent);
    const { t } = useTranslation("common");

    const handleOpenFile = useCallback(() => {
      if (!openFilePath) return;
      const line = startLine ? Number.parseInt(startLine, 10) : undefined;
      openFileInWorkStation(openFilePath, {
        line: Number.isFinite(line) ? line : undefined,
      });
    }, [openFilePath, startLine]);

    const copyLabel = copied ? t("status.copied") : t("actions.copy");
    const openLabel = t("actions.open");

    return (
      <div className="code-block-wrapper" style={CODE_WRAPPER_STYLE}>
        {openFilePath && (
          <Button
            variant="tertiary"
            appearance="ghost"
            size="mini"
            iconOnly
            icon={<ArrowUpRight size={12} strokeWidth={1.75} />}
            title={openLabel}
            aria-label={openLabel}
            className="code-block-open-button text-text-4 hover:text-text-2"
            onClick={handleOpenFile}
          />
        )}
        <Button
          variant="tertiary"
          appearance="ghost"
          size="mini"
          iconOnly
          icon={
            copied ? (
              <Check size={12} strokeWidth={1.75} />
            ) : (
              <Clipboard size={12} strokeWidth={1.75} />
            )
          }
          title={copyLabel}
          aria-label={copyLabel}
          className="code-block-copy-button text-text-4 hover:text-text-2"
          onClick={handleCopy}
        />
        <SyntaxHighlighter
          customStyle={CODE_CUSTOM_STYLE}
          style={codeMirrorPrismTheme}
          language={language}
          PreTag="div"
          showLineNumbers={false}
          wrapLongLines
          wrapLines={true}
        >
          {children}
        </SyntaxHighlighter>
      </div>
    );
  },
  (prev, next) =>
    prev.children === next.children &&
    prev.language === next.language &&
    prev.startLine === next.startLine &&
    prev.openFilePath === next.openFilePath
);
CodeBlock.displayName = "CodeBlock";

function normalizePathForRepoCheck(path: string): string {
  return path
    .replace(/^file:\/\//, "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
}

function isAbsolutePath(path: string): boolean {
  return /^(?:file:\/\/)?\//.test(path) || /^[A-Za-z]:[\\/]/.test(path);
}

function isPathInCurrentRepo(
  filePath: string | undefined,
  repoRoot: string
): boolean {
  if (!filePath || !repoRoot) return false;
  const normalizedFilePath = normalizePathForRepoCheck(filePath);
  if (!isAbsolutePath(normalizedFilePath)) return true;
  const normalizedRepoRoot = normalizePathForRepoCheck(repoRoot);
  return (
    normalizedFilePath === normalizedRepoRoot ||
    normalizedFilePath.startsWith(`${normalizedRepoRoot}/`)
  );
}

function resolveCurrentRepoFilePath(
  filePath: string | undefined,
  repoRoot: string
): string | undefined {
  if (!isPathInCurrentRepo(filePath, repoRoot) || !filePath) return undefined;
  const normalizedFilePath = normalizePathForRepoCheck(filePath);
  if (isAbsolutePath(normalizedFilePath)) return normalizedFilePath;
  return `${normalizePathForRepoCheck(repoRoot)}/${normalizedFilePath.replace(
    /^\.\//,
    ""
  )}`;
}

// ============================================
// Markdown render primitives
// ============================================

interface MarkdownRendererProps {
  content: string;
  components: Components;
  plugins: (typeof remarkGfm)[];
}

const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({
  content,
  components,
  plugins,
}) => (
  <ReactMarkdown
    className="chat-markdown-body"
    remarkPlugins={plugins}
    components={components}
  >
    {content}
  </ReactMarkdown>
);
MarkdownRenderer.displayName = "MarkdownRenderer";

interface StreamingMarkdownBlockProps extends MarkdownRendererProps {
  blockIndex: number;
}

const StreamingMarkdownBlock = memo<StreamingMarkdownBlockProps>(
  ({ content, components, plugins, blockIndex }) => (
    <div className={blockIndex > 0 ? STREAMING_BLOCK_GAP_CLASS : undefined}>
      <MarkdownRenderer
        content={content}
        components={components}
        plugins={plugins}
      />
    </div>
  ),
  (prev, next) =>
    prev.content === next.content &&
    prev.components === next.components &&
    prev.plugins === next.plugins &&
    prev.blockIndex === next.blockIndex
);
StreamingMarkdownBlock.displayName = "StreamingMarkdownBlock";

// ============================================
// Main Component
// ============================================

const MarkdownComponent: React.FC<MarkdownProps> = ({
  textContent,
  darkMode,
  researchMode,
  useChatCodeBlock = false,
  codeBlockContainerWidth,
  enableFileNavigation = false,
  streaming = false,
  skipPreprocess = false,
}) => {
  const themes = useAtomValue(themesAtom);
  const activeWorkspaceRoot = useAtomValue(activeWorkspaceRootAtom);
  const activeWorkspaceRootPath = activeWorkspaceRoot?.path ?? "";

  const handleLinkClick = useCallback(
    (event: React.MouseEvent<HTMLAnchorElement>, href: string) => {
      event.preventDefault();
      event.stopPropagation();
      openUrlInBrowserApp(href);
    },
    []
  );

  // Memoize dark mode calculation
  const isDarkMode = useMemo(() => {
    if (darkMode !== undefined) return darkMode;
    return isThemeCssPathDark(themes);
  }, [themes, darkMode]);

  // Types for ReactMarkdown custom components
  interface CodeElementProps {
    className?: string;
    children?: React.ReactNode;
  }

  // Memoize components object to prevent recreation
  const markdownComponents = useMemo((): Components => {
    const baseComponents: Components = {
      pre({ children, ...props }) {
        if (
          React.isValidElement(children) &&
          typeof (children as React.ReactElement<CodeElementProps>).props
            .className === "string" &&
          (
            children as React.ReactElement<CodeElementProps>
          ).props.className?.includes("language-")
        ) {
          const childProps = (children as React.ReactElement<CodeElementProps>)
            .props;
          const codeContent = String(childProps.children).replace(/\n$/, "");
          const match = /(?:^|\s)language-([^\s]+)/.exec(
            childProps.className || ""
          );
          const fenceMeta = parseCodeFenceMeta(match ? match[1] : "text");
          const { language } = fenceMeta;
          const lineSubtitle = fenceMeta.startLine
            ? fenceMeta.startLine === fenceMeta.endLine
              ? fenceMeta.startLine
              : `${fenceMeta.startLine}-${fenceMeta.endLine}`
            : undefined;

          if (language === "mermaid") {
            return <MermaidBlock code={codeContent} isDarkMode={isDarkMode} />;
          }

          // Canvas / preview fenced blocks — render as CanvasInlineCard
          if (CANVAS_FENCED_LANGUAGES.has(language.toLowerCase())) {
            let mode: CanvasFencedMode = "html";
            let cardContent: string | undefined;
            let cardUrl: string | undefined;
            let cardTitle: string | undefined;

            // Derive mode from language alias shortcuts (canvas-url, canvas-a2ui)
            if (language === "canvas-url") mode = "url";
            else if (language === "canvas-a2ui") mode = "a2ui";

            // Try to parse the body as a JSON payload
            const trimmed = codeContent.trim();
            if (trimmed.startsWith("{")) {
              try {
                const parsed = JSON.parse(trimmed) as Record<string, unknown>;
                // isCanvasFencedMode guards against unknown mode strings
                if (isCanvasFencedMode(parsed.mode)) mode = parsed.mode;
                if (typeof parsed.content === "string")
                  cardContent = parsed.content;
                if (typeof parsed.url === "string") cardUrl = parsed.url;
                if (typeof parsed.title === "string") cardTitle = parsed.title;
              } catch {
                // Not valid JSON — treat the raw content as HTML
                cardContent = codeContent;
              }
            } else {
              // Plain content — pass through as-is (HTML or A2UI JSONL)
              cardContent = codeContent;
            }

            return (
              <CanvasInlineCard
                mode={mode}
                content={cardContent}
                url={cardUrl}
                title={cardTitle}
              />
            );
          }

          // Use ChatCodeBlock if enabled
          if (useChatCodeBlock) {
            const openFilePath = resolveCurrentRepoFilePath(
              fenceMeta.filePath,
              activeWorkspaceRootPath
            );
            return (
              <div className="chat-markdown-fenced-block">
                <ChatCodeBlock
                  code={codeContent}
                  language={language}
                  filePath={openFilePath ?? fenceMeta.filePath}
                  title={fenceMeta.title}
                  subtitle={lineSubtitle}
                  maxHeight={300}
                  containerWidth={codeBlockContainerWidth}
                  showLineNumbers={true}
                  showLineCount={false}
                  hideHeader={
                    !fenceMeta.filePath &&
                    CHAT_CODE_BLOCK_HIDE_HEADER_LANGUAGES.has(
                      language.toLowerCase()
                    )
                  }
                  showOpenButton={Boolean(openFilePath)}
                />
              </div>
            );
          }

          const openFilePath = resolveCurrentRepoFilePath(
            fenceMeta.filePath,
            activeWorkspaceRootPath
          );
          return (
            <CodeBlock
              language={language}
              startLine={fenceMeta.startLine}
              openFilePath={openFilePath}
            >
              {codeContent}
            </CodeBlock>
          );
        }
        return <pre {...props}>{children}</pre>;
      },
      code({ children, className, ...props }) {
        // Handle inline code (not in pre block)
        if (className?.includes("language-")) {
          // This is actually a code block, let pre handle it
          return (
            <code className={className} {...props}>
              {children}
            </code>
          );
        }

        // Check if file navigation is enabled and this looks like a file path
        if (enableFileNavigation) {
          const text = String(children);
          const codeType = detectCodeType(text);

          if (codeType === "file") {
            return (
              <code
                {...props}
                className="clickable-code file-path"
                title={undefined}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  openFileInEditor(text, false);
                }}
              >
                {children}
              </code>
            );
          }

          if (codeType === "directory") {
            return (
              <code
                {...props}
                className="clickable-code directory-path"
                title={undefined}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  openFileInEditor(text, true);
                }}
              >
                {children}
              </code>
            );
          }

          if (codeType === "identifier") {
            return (
              <code
                {...props}
                className="clickable-code identifier"
                title={`Search for ${text}`}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  // For identifiers, we can search for them
                  openFileInEditor(text, false);
                }}
              >
                {children}
              </code>
            );
          }
        }

        // Regular inline code
        return <code {...props}>{children}</code>;
      },
      a({ children, href, ...props }) {
        const url = href ?? "";
        return (
          <a
            {...props}
            href={url}
            title={undefined}
            onClick={(event) => handleLinkClick(event, url)}
          >
            {children}
          </a>
        );
      },
      ul({ children, ...props }) {
        return <ul {...props}>{children}</ul>;
      },
      ol({ children, ...props }) {
        return <ol {...props}>{children}</ol>;
      },
      li({ children, ...props }) {
        return <li {...props}>{children}</li>;
      },
    };

    if (researchMode) {
      baseComponents.p = ({ children, ...props }) => (
        <p {...props}>{renderChildren(children)}</p>
      );
      baseComponents.li = ({ children, ...props }) => (
        <li {...props}>{renderChildren(children)}</li>
      );
    }

    return baseComponents;
  }, [
    isDarkMode,
    researchMode,
    useChatCodeBlock,
    codeBlockContainerWidth,
    enableFileNavigation,
    handleLinkClick,
    activeWorkspaceRootPath,
  ]);

  // Memoize plugins array to prevent recreation
  const plugins = useMemo(() => [remarkGfm], []);

  // Preprocess text content to auto-detect and format code.
  // Skip the expensive regex pass when the caller guarantees the content is
  // already well-formed markdown (e.g., post-stream agent messages).
  const processedContent = useMemo(
    () => (skipPreprocess ? textContent : preprocessTextContent(textContent)),
    [textContent, skipPreprocess]
  );

  const streamingBlocks = useMemo(
    () => (streaming ? splitIntoStableMarkdownBlocks(processedContent) : null),
    [processedContent, streaming]
  );

  if (streaming && streamingBlocks) {
    return (
      <div className="chat-markdown-streaming-blocks">
        {streamingBlocks.map((block, blockIndex) => (
          <StreamingMarkdownBlock
            key={blockIndex}
            blockIndex={blockIndex}
            content={block}
            components={markdownComponents}
            plugins={plugins}
          />
        ))}
      </div>
    );
  }

  return (
    <MarkdownRenderer
      content={processedContent}
      components={markdownComponents}
      plugins={plugins}
    />
  );
};

// ============================================
// Memoized Export
// ============================================

/**
 * Custom comparison - only re-render if content or mode changes
 */
const arePropsEqual = (prev: MarkdownProps, next: MarkdownProps): boolean => {
  if (prev.textContent !== next.textContent) return false;
  if (prev.darkMode !== next.darkMode) return false;
  if (prev.researchMode !== next.researchMode) return false;
  if (prev.useChatCodeBlock !== next.useChatCodeBlock) return false;
  if (prev.codeBlockContainerWidth !== next.codeBlockContainerWidth)
    return false;
  if (prev.enableFileNavigation !== next.enableFileNavigation) return false;
  if (prev.streaming !== next.streaming) return false;
  if (prev.skipPreprocess !== next.skipPreprocess) return false;
  return true;
};

const Markdown = memo(MarkdownComponent, arePropsEqual);
Markdown.displayName = "Markdown";

export default Markdown;
