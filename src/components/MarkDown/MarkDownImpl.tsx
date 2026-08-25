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
import React, { memo, useCallback, useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { isInternalComposerReferenceHref } from "@src/components/ComposerInput/postedReferenceHref";
import { isThemeCssPathDark } from "@src/config/appearance/globalThemes";
import CanvasInlineCard from "@src/engines/ChatPanel/blocks/CanvasInlineCard";
import ChatCodeBlock from "@src/engines/ChatPanel/blocks/CodeBlock";
import { parseCloudSessionReference } from "@src/features/Org2Cloud/cloudSessionReference";
import { useOpenCloudSessionReference } from "@src/features/Org2Cloud/useOpenCloudSessionReference";
import { themesAtom } from "@src/store";
import { activeWorkspaceRootAtom } from "@src/store/workspace";

import LinkHoverCard from "./LinkHoverCard";
import CodeBlock from "./MarkdownCodeBlock";
import MarkdownLinkIcon, { hasMarkdownLinkIcon } from "./MarkdownLinkIcon";
import MarkdownLocalImage, { openLocalMarkdownRef } from "./MarkdownLocalImage";
import MermaidBlock from "./MermaidBlock";
import SessionReferenceCards from "./SessionReferenceCards";
import "./index.scss";
import {
  CANVAS_FENCED_LANGUAGES,
  CHAT_CODE_BLOCK_HIDE_HEADER_LANGUAGES,
  type CanvasFencedMode,
  isCanvasFencedMode,
  parseCodeFenceMeta,
} from "./markdownCodeFence";
import { classifyMarkdownLinkTarget } from "./markdownLinkTarget";
import { resolveCurrentRepoFilePath } from "./markdownRepoPath";
import { splitIntoStableMarkdownBlocks } from "./markdownStableBlocks";
import { markdownUrlTransform } from "./markdownUrlTransform";
import {
  detectCodeType,
  normalizeCopyableMarkdownDocumentFence,
  openFileInEditor,
  openMarkdownLinkInBrowserApp,
  preprocessTextContent,
  renderChildren,
} from "./markdownUtils";
import { remarkCloudSessionReferences } from "./remarkCloudSessionReferences";
import { projectMarkdownSessionReferences } from "./sessionReferenceProjection";

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
  disableCanvasInline?: boolean;
  /** Promote local/cloud session references to attachment cards below prose. */
  sessionReferencesAsCards?: boolean;
}

const STREAMING_BLOCK_GAP_CLASS = "mt-3";

// ============================================
// Markdown render primitives
// ============================================

type MarkdownRemarkPlugins = React.ComponentProps<
  typeof ReactMarkdown
>["remarkPlugins"];

interface MarkdownRendererProps {
  content: string;
  components: Components;
  plugins: MarkdownRemarkPlugins;
}

const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({
  content,
  components,
  plugins,
}) => (
  <ReactMarkdown
    className="chat-markdown-body"
    remarkPlugins={plugins}
    urlTransform={markdownUrlTransform}
    components={components}
  >
    {content}
  </ReactMarkdown>
);
MarkdownRenderer.displayName = "MarkdownRenderer";

interface StreamingMarkdownBlockProps extends MarkdownRendererProps {
  blockIndex: number;
}

const CloudSessionMarkdownLink: React.FC<{
  href: string;
  children: React.ReactNode;
  reference: NonNullable<ReturnType<typeof parseCloudSessionReference>>;
}> = ({ href, children, reference }) => {
  const openReference = useOpenCloudSessionReference();
  return (
    <a
      href={href}
      title={undefined}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        openReference(reference, { autoReplay: true });
      }}
    >
      {children}
    </a>
  );
};
CloudSessionMarkdownLink.displayName = "CloudSessionMarkdownLink";

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
  disableCanvasInline = false,
  sessionReferencesAsCards = false,
}) => {
  const themes = useAtomValue(themesAtom);
  const activeWorkspaceRoot = useAtomValue(activeWorkspaceRootAtom);
  const activeWorkspaceRootPath = activeWorkspaceRoot?.path ?? "";
  const sessionProjection = useMemo(
    () =>
      sessionReferencesAsCards
        ? projectMarkdownSessionReferences(textContent)
        : { text: textContent, references: [], referenceOnly: false },
    [sessionReferencesAsCards, textContent]
  );

  const handleLinkClick = useCallback(
    (event: React.MouseEvent<HTMLAnchorElement>, href: string) => {
      event.preventDefault();
      event.stopPropagation();
      const linkTarget = classifyMarkdownLinkTarget(
        href,
        activeWorkspaceRootPath
      );
      if (linkTarget.kind === "local") {
        void openLocalMarkdownRef(
          linkTarget.path,
          linkTarget.homeRelative === true
        );
        return;
      }
      openMarkdownLinkInBrowserApp(linkTarget.url);
    },
    [activeWorkspaceRootPath]
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
          if (
            !disableCanvasInline &&
            CANVAS_FENCED_LANGUAGES.has(language.toLowerCase())
          ) {
            let mode: CanvasFencedMode = "html";
            let cardContent: string | undefined;
            let cardUrl: string | undefined;
            let cardTitle: string | undefined;

            // Derive mode from language alias shortcuts (canvas-url, canvas-a2ui, canvas-react)
            if (language === "canvas-url") mode = "url";
            else if (language === "canvas-a2ui") mode = "a2ui";
            else if (language === "canvas-react") mode = "react";

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
        }

        // Regular inline code
        return <code {...props}>{children}</code>;
      },
      img({ src, alt }) {
        return (
          <MarkdownLocalImage
            src={typeof src === "string" ? src : undefined}
            alt={typeof alt === "string" ? alt : undefined}
            workspaceRootPath={activeWorkspaceRootPath}
          />
        );
      },
      a({ children, href, ...props }) {
        const url = href ?? "";
        const cloudReference = parseCloudSessionReference(url);
        if (cloudReference) {
          return (
            <CloudSessionMarkdownLink href={url} reference={cloudReference}>
              {children}
            </CloudSessionMarkdownLink>
          );
        }
        if (isInternalComposerReferenceHref(url)) {
          return (
            <a
              {...props}
              href={url}
              title={undefined}
              onClick={(event) => {
                // Composer reference URIs are identity tokens, not OS URLs.
                // Preserve native link semantics without handing an internal
                // scheme to the system browser.
                event.preventDefault();
                event.stopPropagation();
              }}
            >
              {children}
            </a>
          );
        }
        const linkTarget = classifyMarkdownLinkTarget(
          url,
          activeWorkspaceRootPath
        );
        const linkHasIcon = hasMarkdownLinkIcon(url, linkTarget);
        return (
          <LinkHoverCard
            url={url}
            workspaceRootPath={activeWorkspaceRootPath}
            workspaceRootRepoId={activeWorkspaceRoot?.repoId}
            workspaceRootRepoUrl={activeWorkspaceRoot?.repo?.repo_url}
          >
            <a
              {...props}
              className={
                linkHasIcon
                  ? ["markdown-link-with-icon", props.className]
                      .filter(Boolean)
                      .join(" ")
                  : props.className
              }
              href={url}
              title={undefined}
              onClick={(event) => handleLinkClick(event, url)}
            >
              <MarkdownLinkIcon href={url} target={linkTarget} />
              {children}
            </a>
          </LinkHoverCard>
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
    activeWorkspaceRoot,
    activeWorkspaceRootPath,
    disableCanvasInline,
  ]);

  // Memoize plugins array to prevent recreation
  const plugins = useMemo(() => [remarkGfm, remarkCloudSessionReferences], []);

  // Preprocess text content to auto-detect and format code.
  // Skip the expensive regex pass when the caller guarantees the content is
  // already well-formed markdown (e.g., post-stream agent messages).
  const processedContent = useMemo(() => {
    const content = skipPreprocess
      ? sessionProjection.text
      : preprocessTextContent(sessionProjection.text);
    return normalizeCopyableMarkdownDocumentFence(content);
  }, [sessionProjection.text, skipPreprocess]);

  const streamingBlocks = useMemo(
    () => (streaming ? splitIntoStableMarkdownBlocks(processedContent) : null),
    [processedContent, streaming]
  );

  if (streaming && streamingBlocks) {
    return (
      <>
        {processedContent ? (
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
        ) : null}
        {sessionProjection.references.length > 0 ? (
          <SessionReferenceCards references={sessionProjection.references} />
        ) : null}
      </>
    );
  }

  return (
    <>
      {processedContent ? (
        <MarkdownRenderer
          content={processedContent}
          components={markdownComponents}
          plugins={plugins}
        />
      ) : null}
      {sessionProjection.references.length > 0 ? (
        <SessionReferenceCards references={sessionProjection.references} />
      ) : null}
    </>
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
  if (prev.disableCanvasInline !== next.disableCanvasInline) return false;
  if (prev.sessionReferencesAsCards !== next.sessionReferencesAsCards)
    return false;
  return true;
};

const Markdown = memo(MarkdownComponent, arePropsEqual);
Markdown.displayName = "Markdown";

export default Markdown;
