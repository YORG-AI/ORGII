/**
 * MermaidBlock — renders mermaid diagram code into SVG.
 *
 * Performance strategy:
 * - mermaid library (~2MB) is loaded lazily on first use via dynamic import()
 * - SVG is rendered once via mermaid.render() and cached per (code + theme) key
 * - Module-level SVG cache (FIFO, max 50) avoids re-rendering identical diagrams
 * - Renders asynchronously; shows a shimmer placeholder while loading
 * - Debounces rendering during streaming (300ms stability wait)
 * - Click-to-zoom: click diagram to toggle fullscreen overlay
 */
import React, { memo, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  EventBlockHeader,
  EventBlockHeaderIcon,
  EventBlockHeaderTitle,
  getEventBlockContainerClasses,
} from "@src/engines/ChatPanel/blocks/primitives";
import {
  Add01Icon,
  ArrowExpand01Icon,
  Cancel01Icon,
  HugeiconsIcon,
  MinusSignIcon,
  RotateLeft01Icon,
  WorkflowCircle01Icon,
} from "@src/icons";

// ============================================
// Module-level SVG cache (FIFO, max 50)
// ============================================

const MAX_CACHE = 50;
const MAX_CACHE_BYTES = 2 * 1024 * 1024;
const MAX_CACHEABLE_DIAGRAM_BYTES = 64 * 1024;
const HASH_SEED = 0x811c9dc5;
const HASH_MULTIPLIER = 0x01000193;

const textEncoder = new TextEncoder();
const svgCache = new Map<string, { svg: string; bytes: number }>();
let svgCacheBytes = 0;

function getByteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function getStableHash(value: string): string {
  let hash = HASH_SEED;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, HASH_MULTIPLIER);
  }
  return (hash >>> 0).toString(36);
}

function cacheKey(code: string, dark: boolean): string {
  return `${dark ? "d" : "l"}:${code.length}:${getStableHash(code)}`;
}

function getCacheEligibility(code: string): {
  cacheable: boolean;
  bytes: number;
} {
  const bytes = getByteLength(code);
  return { cacheable: bytes <= MAX_CACHEABLE_DIAGRAM_BYTES, bytes };
}

function evictOldestCacheEntry(): void {
  const firstKey = svgCache.keys().next().value;
  if (!firstKey) return;

  const entry = svgCache.get(firstKey);
  if (entry) {
    svgCacheBytes -= entry.bytes;
  }
  svgCache.delete(firstKey);
}

function getCachedSvg(code: string, dark: boolean): string | undefined {
  const eligibility = getCacheEligibility(code);
  if (!eligibility.cacheable) return undefined;

  return svgCache.get(cacheKey(code, dark))?.svg;
}

function setCachedSvg(code: string, dark: boolean, svg: string): void {
  const eligibility = getCacheEligibility(code);
  if (!eligibility.cacheable) return;

  const key = cacheKey(code, dark);
  const entryBytes =
    eligibility.bytes + getByteLength(svg) + getByteLength(key);
  if (entryBytes > MAX_CACHE_BYTES) return;

  const existing = svgCache.get(key);
  if (existing) {
    svgCacheBytes -= existing.bytes;
  }

  while (
    svgCache.size >= MAX_CACHE ||
    svgCacheBytes + entryBytes > MAX_CACHE_BYTES
  ) {
    evictOldestCacheEntry();
  }

  svgCache.set(key, { svg, bytes: entryBytes });
  svgCacheBytes += entryBytes;
}

// ============================================
// Lazy mermaid loader (singleton per theme)
// ============================================

interface MermaidAPI {
  initialize: (config: Record<string, unknown>) => void;
  render: (
    id: string,
    code: string
  ) => Promise<{ svg: string; bindFunctions?: (el: Element) => void }>;
}

let mermaidModule: MermaidAPI | null = null;
let mermaidPromise: Promise<MermaidAPI> | null = null;
let currentTheme: string | null = null;
let renderCounter = 0;

type MermaidThemeVariables = Record<string, string | boolean>;

const LIGHT_MERMAID_THEME: MermaidThemeVariables = {
  background: "transparent",
  mainBkg: "#f8fafc",
  primaryColor: "#f8fafc",
  primaryTextColor: "#1f2937",
  primaryBorderColor: "#cbd5e1",
  secondaryColor: "#eff6ff",
  secondaryTextColor: "#1f2937",
  secondaryBorderColor: "#93c5fd",
  tertiaryColor: "#f1f5f9",
  tertiaryTextColor: "#334155",
  tertiaryBorderColor: "#cbd5e1",
  lineColor: "#64748b",
  textColor: "#1f2937",
  nodeTextColor: "#1f2937",
  edgeLabelBackground: "#ffffff",
  clusterBkg: "#f8fafc",
  clusterBorder: "#d8dee8",
  noteBkgColor: "#fff7ed",
  noteTextColor: "#374151",
  noteBorderColor: "#fed7aa",
};

const DARK_MERMAID_THEME: MermaidThemeVariables = {
  darkMode: true,
  background: "transparent",
  mainBkg: "#20242b",
  primaryColor: "#20242b",
  primaryTextColor: "#e5e7eb",
  primaryBorderColor: "#475569",
  secondaryColor: "#172554",
  secondaryTextColor: "#dbeafe",
  secondaryBorderColor: "#3b82f6",
  tertiaryColor: "#111827",
  tertiaryTextColor: "#d1d5db",
  tertiaryBorderColor: "#374151",
  lineColor: "#94a3b8",
  textColor: "#e5e7eb",
  nodeTextColor: "#e5e7eb",
  edgeLabelBackground: "#1f2937",
  clusterBkg: "#111827",
  clusterBorder: "#374151",
  noteBkgColor: "#422006",
  noteTextColor: "#fed7aa",
  noteBorderColor: "#9a3412",
};

function getMermaid(dark: boolean): Promise<MermaidAPI> {
  const theme = dark ? "orgii-dark" : "orgii-light";

  if (mermaidModule && currentTheme === theme) {
    return Promise.resolve(mermaidModule);
  }

  if (mermaidPromise && currentTheme === theme) {
    return mermaidPromise;
  }

  mermaidPromise = (
    mermaidModule
      ? Promise.resolve(mermaidModule)
      : import("mermaid").then((mod) => mod.default as unknown as MermaidAPI)
  ).then((mermaid) => {
    mermaid.initialize({
      startOnLoad: false,
      theme: "base",
      securityLevel: "strict",
      fontFamily: "inherit",
      logLevel: "error",
      themeVariables: dark ? DARK_MERMAID_THEME : LIGHT_MERMAID_THEME,
    });
    mermaidModule = mermaid;
    currentTheme = theme;
    return mermaid;
  });

  return mermaidPromise;
}

// ============================================
// Component
// ============================================

interface MermaidBlockProps {
  code: string;
  isDarkMode?: boolean;
}

interface MermaidBlockHeaderProps {
  isCollapsed: boolean;
  isHeaderHovered: boolean;
  onToggle: () => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  rightContent?: React.ReactNode;
}

const MermaidBlockHeader: React.FC<MermaidBlockHeaderProps> = ({
  isCollapsed,
  isHeaderHovered,
  onToggle,
  onMouseEnter,
  onMouseLeave,
  rightContent,
}) => (
  <EventBlockHeader
    isCollapsed={isCollapsed}
    withHover={false}
    onClick={onToggle}
    onMouseEnter={onMouseEnter}
    onMouseLeave={onMouseLeave}
    rightContent={rightContent}
  >
    <EventBlockHeaderIcon
      icon={
        <HugeiconsIcon
          icon={WorkflowCircle01Icon}
          data-icon="workflow"
          size={14}
        />
      }
      isCollapsed={isCollapsed}
      isHeaderHovered={isHeaderHovered}
      onToggle={onToggle}
      hasContent
    />
    <EventBlockHeaderTitle>Mermaid</EventBlockHeaderTitle>
  </EventBlockHeader>
);

const MermaidBlock: React.FC<MermaidBlockProps> = memo(
  ({ code, isDarkMode = false }) => {
    const [svg, setSvg] = useState<string | null>(
      () => getCachedSvg(code, isDarkMode) ?? null
    );
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(!svg);
    const [expanded, setExpanded] = useState(false);
    const [isCollapsed, setIsCollapsed] = useState(false);
    const [isHeaderHovered, setIsHeaderHovered] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);
    const codeRef = useRef(code);
    const darkRef = useRef(isDarkMode);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const cancelledRef = useRef(false);

    useEffect(() => {
      cancelledRef.current = false;
      return () => {
        cancelledRef.current = true;
      };
    }, []);

    const renderDiagram = useCallback(
      async (diagramCode: string, dark: boolean) => {
        const cached = getCachedSvg(diagramCode, dark);
        if (cached) {
          if (!cancelledRef.current) {
            setSvg(cached);
            setLoading(false);
            setError(null);
          }
          return;
        }

        if (!cancelledRef.current) {
          setLoading(true);
          setError(null);
        }

        try {
          const mermaid = await getMermaid(dark);
          if (cancelledRef.current) return;
          const id = `mermaid-${++renderCounter}`;
          const result = await mermaid.render(id, diagramCode);
          if (cancelledRef.current) return;
          setCachedSvg(diagramCode, dark, result.svg);
          setSvg(result.svg);

          if (result.bindFunctions && containerRef.current) {
            result.bindFunctions(containerRef.current);
          }
        } catch (err) {
          if (cancelledRef.current) return;
          const message = err instanceof Error ? err.message : String(err);
          setError(message);
          setSvg(null);
        } finally {
          if (!cancelledRef.current) {
            setLoading(false);
          }
        }
      },
      []
    );

    useEffect(() => {
      codeRef.current = code;
      darkRef.current = isDarkMode;

      if (timerRef.current) clearTimeout(timerRef.current);

      if (getCachedSvg(code, isDarkMode)) {
        setSvg(getCachedSvg(code, isDarkMode)!);
        setLoading(false);
        setError(null);
        return;
      }

      timerRef.current = setTimeout(() => {
        if (codeRef.current === code && darkRef.current === isDarkMode) {
          renderDiagram(code, isDarkMode);
        }
      }, 300);

      return () => {
        if (timerRef.current) clearTimeout(timerRef.current);
      };
    }, [code, isDarkMode, renderDiagram]);

    // Close fullscreen on Escape
    useEffect(() => {
      if (!expanded) return;

      const handleKey = (event: KeyboardEvent) => {
        if (event.key === "Escape") setExpanded(false);
      };
      window.addEventListener("keydown", handleKey);
      return () => window.removeEventListener("keydown", handleKey);
    }, [expanded]);

    const toggleExpand = useCallback(() => {
      setExpanded((prev) => !prev);
    }, []);

    const toggleCollapse = useCallback(() => {
      setIsCollapsed((prev) => !prev);
    }, []);

    const handleHeaderMouseEnter = useCallback(() => {
      setIsHeaderHovered(true);
    }, []);

    const handleHeaderMouseLeave = useCallback(() => {
      setIsHeaderHovered(false);
    }, []);

    // Zoom + pan state for fullscreen overlay
    const [zoom, setZoom] = useState(1);
    const [pan, setPan] = useState({ x: 0, y: 0 });
    const viewportRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const dragState = useRef<{
      startX: number;
      startY: number;
      startPanX: number;
      startPanY: number;
    } | null>(null);

    const MIN_ZOOM = 0.1;
    const MAX_ZOOM = 5;
    const ZOOM_STEP = 0.25;

    // Reset zoom/pan to 100% when opening.
    useEffect(() => {
      if (!expanded) return;
      setZoom(1);
      setPan({ x: 0, y: 0 });
    }, [expanded]);

    const zoomIn = useCallback(() => {
      setZoom((prev) => Math.min(prev + ZOOM_STEP, MAX_ZOOM));
    }, []);

    const zoomOut = useCallback(() => {
      setZoom((prev) => Math.max(prev - ZOOM_STEP, MIN_ZOOM));
    }, []);

    const resetZoom = useCallback(() => {
      setZoom(1);
      setPan({ x: 0, y: 0 });
    }, []);

    // Wheel zoom
    const onWheel = useCallback((event: React.WheelEvent) => {
      event.preventDefault();
      const delta = event.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
      setZoom((prev) => Math.min(Math.max(prev + delta, MIN_ZOOM), MAX_ZOOM));
    }, []);

    // Drag to pan
    const onPointerDown = useCallback(
      (event: React.PointerEvent) => {
        const viewport = viewportRef.current;
        if (!viewport) return;
        viewport.setPointerCapture(event.pointerId);
        dragState.current = {
          startX: event.clientX,
          startY: event.clientY,
          startPanX: pan.x,
          startPanY: pan.y,
        };
        viewport.style.cursor = "grabbing";
      },
      [pan]
    );

    const onPointerMove = useCallback((event: React.PointerEvent) => {
      const state = dragState.current;
      if (!state) return;
      setPan({
        x: state.startPanX + (event.clientX - state.startX),
        y: state.startPanY + (event.clientY - state.startY),
      });
    }, []);

    const onPointerUp = useCallback((event: React.PointerEvent) => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      viewport.releasePointerCapture(event.pointerId);
      dragState.current = null;
      viewport.style.cursor = "grab";
    }, []);

    if (error) {
      return (
        <div
          className={`${getEventBlockContainerClasses()} mermaid-block mermaid-block--error`}
        >
          <MermaidBlockHeader
            isCollapsed={isCollapsed}
            isHeaderHovered={isHeaderHovered}
            onToggle={toggleCollapse}
            onMouseEnter={handleHeaderMouseEnter}
            onMouseLeave={handleHeaderMouseLeave}
            rightContent={
              <span className="mermaid-block__error-badge">Error</span>
            }
          />
          {!isCollapsed && (
            <>
              <pre className="mermaid-block__code">{code}</pre>
              <div className="mermaid-block__error-msg">{error}</div>
            </>
          )}
        </div>
      );
    }

    if (loading) {
      return (
        <div
          className={`${getEventBlockContainerClasses()} mermaid-block mermaid-block--loading`}
        >
          <MermaidBlockHeader
            isCollapsed={isCollapsed}
            isHeaderHovered={isHeaderHovered}
            onToggle={toggleCollapse}
            onMouseEnter={handleHeaderMouseEnter}
            onMouseLeave={handleHeaderMouseLeave}
          />
          {!isCollapsed && <div className="mermaid-block__shimmer" />}
        </div>
      );
    }

    return (
      <>
        <div
          ref={containerRef}
          className={`${getEventBlockContainerClasses()} mermaid-block ${isDarkMode ? "mermaid-block--dark" : ""}`}
        >
          <MermaidBlockHeader
            isCollapsed={isCollapsed}
            isHeaderHovered={isHeaderHovered}
            onToggle={toggleCollapse}
            onMouseEnter={handleHeaderMouseEnter}
            onMouseLeave={handleHeaderMouseLeave}
            rightContent={
              <button
                className="mermaid-block__expand-btn"
                onClick={(event) => {
                  event.stopPropagation();
                  toggleExpand();
                }}
                title="Fullscreen"
              >
                <HugeiconsIcon
                  icon={ArrowExpand01Icon}
                  data-icon="maximize-2"
                  size={14}
                />
              </button>
            }
          />
          {!isCollapsed && svg && (
            <div
              className="mermaid-block__svg"
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          )}
        </div>

        {expanded &&
          svg &&
          createPortal(
            <div
              className="fixed inset-0 z-[99999] flex flex-col bg-black/80"
              onClick={toggleExpand}
              role="dialog"
              aria-modal="true"
              aria-label="Mermaid diagram preview"
            >
              {/* Toolbar */}
              <div
                className="flex shrink-0 items-center justify-end px-4 py-2"
                onClick={(event) => event.stopPropagation()}
              >
                <div className="flex items-center gap-1">
                  <button
                    className="flex h-7 w-7 items-center justify-center rounded-md text-white/70 transition-colors hover:bg-white/15 hover:text-white"
                    onClick={zoomOut}
                    title="Zoom out"
                  >
                    <HugeiconsIcon
                      icon={MinusSignIcon}
                      data-icon="minus"
                      size={15}
                    />
                  </button>
                  <span className="min-w-[3rem] text-center text-xs text-white/70">
                    {Math.round(zoom * 100)}%
                  </span>
                  <button
                    className="flex h-7 w-7 items-center justify-center rounded-md text-white/70 transition-colors hover:bg-white/15 hover:text-white"
                    onClick={zoomIn}
                    title="Zoom in"
                  >
                    <HugeiconsIcon
                      icon={Add01Icon}
                      data-icon="plus"
                      size={15}
                    />
                  </button>
                  <div className="mx-1 h-4 w-px bg-white/20" />
                  <button
                    className="flex h-7 w-7 items-center justify-center rounded-md text-white/70 transition-colors hover:bg-white/15 hover:text-white"
                    onClick={resetZoom}
                    title="Reset (100%)"
                  >
                    <HugeiconsIcon
                      icon={RotateLeft01Icon}
                      data-icon="rotate-ccw"
                      size={15}
                    />
                  </button>
                  <div className="mx-1 h-4 w-px bg-white/20" />
                  <button
                    className="flex h-7 w-7 items-center justify-center rounded-md text-white/70 transition-colors hover:bg-white/15 hover:text-white"
                    onClick={toggleExpand}
                    title="Close"
                  >
                    <HugeiconsIcon
                      icon={Cancel01Icon}
                      data-icon="x"
                      size={15}
                    />
                  </button>
                </div>
              </div>

              {/* Zoomable viewport */}
              <div
                ref={viewportRef}
                className="flex flex-1 items-center justify-center overflow-hidden"
                style={{ cursor: "grab" }}
                onClick={(event) => event.stopPropagation()}
                onWheel={onWheel}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
              >
                <div
                  ref={contentRef}
                  style={{
                    transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                    transformOrigin: "center center",
                    transition: dragState.current
                      ? "none"
                      : "transform 0.15s ease-out",
                  }}
                  dangerouslySetInnerHTML={{ __html: svg }}
                />
              </div>
            </div>,
            document.body
          )}
      </>
    );
  },
  (prev, next) => prev.code === next.code && prev.isDarkMode === next.isDarkMode
);

MermaidBlock.displayName = "MermaidBlock";

export default MermaidBlock;
