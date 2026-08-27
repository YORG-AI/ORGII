interface RuntimeMemoryEntry {
  bytes: number;
  items: number;
  label?: string;
}

type RuntimeMemoryEntryReader = () => RuntimeMemoryEntry;

export interface RuntimeMemoryTopEntry {
  label: string;
  bytes: number;
  items: number;
}

export interface RuntimeMemoryStats {
  bytes: number;
  entries: number;
  items: number;
  topEntries: RuntimeMemoryTopEntry[];
}

export type SidebarMemoryStatsByKind = Record<
  SidebarMemoryKind,
  RuntimeMemoryStats
>;

export interface WebViewRuntimeDiagnostics {
  domNodes: number;
  imageCount: number;
  dataUrlImageCount: number;
  dataUrlBytes: number;
  decodedImageBytes: number;
  canvasCount: number;
  canvasBytes: number;
  videoCount: number;
  videoFrameBytes: number;
  iframeCount: number;
  compositedSampleCount: number;
  compositedCandidateCount: number;
}

const EMPTY_RUNTIME_MEMORY_STATS: RuntimeMemoryStats = {
  bytes: 0,
  entries: 0,
  items: 0,
  topEntries: [],
};

export const SIDEBAR_MEMORY_KIND = {
  SESSION: "session",
  SECOND_LEVEL: "second_level",
  SETTINGS: "settings",
} as const;

export type SidebarMemoryKind =
  (typeof SIDEBAR_MEMORY_KIND)[keyof typeof SIDEBAR_MEMORY_KIND];

interface SidebarMemoryEntry extends RuntimeMemoryEntry {
  kind: SidebarMemoryKind;
}

const fileTreeMemoryEntries = new Map<symbol, RuntimeMemoryEntry>();
const codeMirrorMemoryEntries = new Map<symbol, RuntimeMemoryEntry>();
const chatRenderedTreeMemoryEntryReaders = new Map<
  symbol,
  RuntimeMemoryEntryReader
>();
const sidebarMemoryEntries = new Map<symbol, SidebarMemoryEntry>();

const DEFAULT_ESTIMATION_NODE_LIMIT = 5_000;
const MAX_DIAGNOSTIC_IMAGES = 500;
const MAX_DIAGNOSTIC_CANVASES = 200;
const MAX_DIAGNOSTIC_VIDEOS = 100;
const MAX_COMPOSITING_STYLE_SAMPLES = 500;
const OBJECT_OVERHEAD_BYTES = 48;
const ARRAY_OVERHEAD_BYTES = 32;
const MAP_OVERHEAD_BYTES = 56;
const POINTER_BYTES = 8;

interface RuntimeValueEstimationState {
  seen: WeakSet<object>;
  visitedNodes: number;
  nodeLimit: number;
}

function estimatePrimitiveBytes(value: unknown): number {
  if (typeof value === "string") return value.length * 2;
  if (typeof value === "number") return 8;
  if (typeof value === "boolean") return 4;
  if (typeof value === "bigint") return 16;
  if (typeof value === "symbol") return String(value).length * 2;
  return 0;
}

function canVisitNode(state: RuntimeValueEstimationState): boolean {
  if (state.visitedNodes >= state.nodeLimit) return false;
  state.visitedNodes += 1;
  return true;
}

function estimateRuntimeValueBytesInternal(
  value: unknown,
  state: RuntimeValueEstimationState
): number {
  if (value === null || value === undefined) return 0;
  if (typeof value !== "object") return estimatePrimitiveBytes(value);
  if (state.seen.has(value)) return 0;
  if (!canVisitNode(state)) return 0;

  state.seen.add(value);

  if (Array.isArray(value)) {
    let bytes = ARRAY_OVERHEAD_BYTES + value.length * POINTER_BYTES;
    for (const item of value) {
      bytes += estimateRuntimeValueBytesInternal(item, state);
      if (state.visitedNodes >= state.nodeLimit) break;
    }
    return bytes;
  }

  if (value instanceof Map) {
    let bytes = MAP_OVERHEAD_BYTES + value.size * POINTER_BYTES * 2;
    for (const [entryKey, entryValue] of value) {
      bytes += estimateRuntimeValueBytesInternal(entryKey, state);
      bytes += estimateRuntimeValueBytesInternal(entryValue, state);
      if (state.visitedNodes >= state.nodeLimit) break;
    }
    return bytes;
  }

  if (value instanceof Set) {
    let bytes = MAP_OVERHEAD_BYTES + value.size * POINTER_BYTES;
    for (const item of value) {
      bytes += estimateRuntimeValueBytesInternal(item, state);
      if (state.visitedNodes >= state.nodeLimit) break;
    }
    return bytes;
  }

  let bytes = OBJECT_OVERHEAD_BYTES;
  const record = value as Record<string, unknown>;
  for (const key in record) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    bytes += key.length * 2 + POINTER_BYTES;
    bytes += estimateRuntimeValueBytesInternal(record[key], state);
    if (state.visitedNodes >= state.nodeLimit) break;
  }
  return bytes;
}

function normalizeMemoryEntry(entry: RuntimeMemoryEntry): RuntimeMemoryEntry {
  return {
    bytes: Math.max(0, Math.round(entry.bytes)),
    items: Math.max(0, Math.round(entry.items)),
    label: entry.label,
  };
}

function summarizeRuntimeMemoryEntries(
  entries: Iterable<RuntimeMemoryEntry>,
  entryCount: number
): RuntimeMemoryStats {
  if (entryCount === 0) return EMPTY_RUNTIME_MEMORY_STATS;

  let bytes = 0;
  let items = 0;
  const topEntries: RuntimeMemoryTopEntry[] = [];
  for (const entry of entries) {
    bytes += entry.bytes;
    items += entry.items;
    if (entry.label) {
      topEntries.push({
        label: entry.label,
        bytes: entry.bytes,
        items: entry.items,
      });
    }
  }

  topEntries.sort((left, right) => right.bytes - left.bytes);

  return {
    bytes,
    entries: entryCount,
    items,
    topEntries: topEntries.slice(0, 3),
  };
}

function summarizeMemoryEntries(
  entries: Map<symbol, RuntimeMemoryEntry>
): RuntimeMemoryStats {
  return summarizeRuntimeMemoryEntries(entries.values(), entries.size);
}

export function estimateRuntimeValueBytes(
  value: unknown,
  nodeLimit = DEFAULT_ESTIMATION_NODE_LIMIT
): number {
  return estimateRuntimeValueBytesInternal(value, {
    seen: new WeakSet<object>(),
    visitedNodes: 0,
    nodeLimit,
  });
}

function estimateBase64DataUrlBytes(value: string): number {
  const commaIndex = value.indexOf(",");
  const payloadLength =
    commaIndex >= 0 ? value.length - commaIndex - 1 : value.length;
  return Math.ceil((payloadLength * 3) / 4);
}

function isCompositingCandidate(style: CSSStyleDeclaration): boolean {
  return (
    style.backdropFilter !== "none" ||
    style.filter !== "none" ||
    style.transform !== "none" ||
    style.willChange.includes("transform") ||
    style.willChange.includes("opacity") ||
    style.contain.includes("paint")
  );
}

export function collectWebViewRuntimeDiagnostics(): WebViewRuntimeDiagnostics {
  if (typeof document === "undefined") {
    return {
      domNodes: 0,
      imageCount: 0,
      dataUrlImageCount: 0,
      dataUrlBytes: 0,
      decodedImageBytes: 0,
      canvasCount: 0,
      canvasBytes: 0,
      videoCount: 0,
      videoFrameBytes: 0,
      iframeCount: 0,
      compositedSampleCount: 0,
      compositedCandidateCount: 0,
    };
  }

  const allElements = document.getElementsByTagName("*");
  const images = document.images;
  const canvases = document.getElementsByTagName("canvas");
  const videos = document.getElementsByTagName("video");

  let dataUrlImageCount = 0;
  let dataUrlBytes = 0;
  let decodedImageBytes = 0;
  const imageLimit = Math.min(images.length, MAX_DIAGNOSTIC_IMAGES);
  for (let index = 0; index < imageLimit; index++) {
    const image = images[index];
    if (!image) continue;
    const decodedBytes = image.naturalWidth * image.naturalHeight * 4;
    if (Number.isFinite(decodedBytes)) decodedImageBytes += decodedBytes;
    if (image.currentSrc.startsWith("data:")) {
      dataUrlImageCount += 1;
      dataUrlBytes += estimateBase64DataUrlBytes(image.currentSrc);
    }
  }

  let canvasBytes = 0;
  const canvasLimit = Math.min(canvases.length, MAX_DIAGNOSTIC_CANVASES);
  for (let index = 0; index < canvasLimit; index++) {
    const canvas = canvases[index];
    if (!canvas) continue;
    const bytes = canvas.width * canvas.height * 4;
    if (Number.isFinite(bytes)) canvasBytes += bytes;
  }

  let videoFrameBytes = 0;
  const videoLimit = Math.min(videos.length, MAX_DIAGNOSTIC_VIDEOS);
  for (let index = 0; index < videoLimit; index++) {
    const video = videos[index];
    if (!video) continue;
    const bytes = video.videoWidth * video.videoHeight * 4;
    if (Number.isFinite(bytes)) videoFrameBytes += bytes;
  }

  let compositedCandidateCount = 0;
  const compositedSampleCount = Math.min(
    allElements.length,
    MAX_COMPOSITING_STYLE_SAMPLES
  );
  for (let index = 0; index < compositedSampleCount; index++) {
    const element = allElements[index];
    if (!element) continue;
    if (isCompositingCandidate(window.getComputedStyle(element))) {
      compositedCandidateCount += 1;
    }
  }

  return {
    domNodes: allElements.length,
    imageCount: images.length,
    dataUrlImageCount,
    dataUrlBytes,
    decodedImageBytes,
    canvasCount: canvases.length,
    canvasBytes,
    videoCount: videos.length,
    videoFrameBytes,
    iframeCount: document.getElementsByTagName("iframe").length,
    compositedSampleCount,
    compositedCandidateCount,
  };
}

export function updateFileTreeMemoryEntry(
  key: symbol,
  entry: RuntimeMemoryEntry
): void {
  fileTreeMemoryEntries.set(key, normalizeMemoryEntry(entry));
}

export function removeFileTreeMemoryEntry(key: symbol): void {
  fileTreeMemoryEntries.delete(key);
}

export function getFileTreeMemoryStats(): RuntimeMemoryStats {
  return summarizeMemoryEntries(fileTreeMemoryEntries);
}

export function updateCodeMirrorMemoryEntry(
  key: symbol,
  entry: RuntimeMemoryEntry
): void {
  codeMirrorMemoryEntries.set(key, normalizeMemoryEntry(entry));
}

export function removeCodeMirrorMemoryEntry(key: symbol): void {
  codeMirrorMemoryEntries.delete(key);
}

export function getCodeMirrorMemoryStats(): RuntimeMemoryStats {
  return summarizeMemoryEntries(codeMirrorMemoryEntries);
}

export function registerChatRenderedTreeMemoryEntry(
  key: symbol,
  readEntry: RuntimeMemoryEntryReader
): () => void {
  chatRenderedTreeMemoryEntryReaders.set(key, readEntry);
  return () => {
    if (chatRenderedTreeMemoryEntryReaders.get(key) === readEntry) {
      chatRenderedTreeMemoryEntryReaders.delete(key);
    }
  };
}

export function getChatRenderedTreeMemoryStats(): RuntimeMemoryStats {
  const entries = Array.from(
    chatRenderedTreeMemoryEntryReaders.values(),
    (readEntry) => normalizeMemoryEntry(readEntry())
  );
  return summarizeRuntimeMemoryEntries(
    entries,
    chatRenderedTreeMemoryEntryReaders.size
  );
}

export function updateSidebarMemoryEntry(
  key: symbol,
  kind: SidebarMemoryKind,
  entry: RuntimeMemoryEntry
): void {
  sidebarMemoryEntries.set(key, {
    ...normalizeMemoryEntry(entry),
    kind,
  });
}

export function removeSidebarMemoryEntry(key: symbol): void {
  sidebarMemoryEntries.delete(key);
}

export function getSidebarMemoryStatsByKind(): SidebarMemoryStatsByKind {
  const entriesByKind: Record<SidebarMemoryKind, SidebarMemoryEntry[]> = {
    [SIDEBAR_MEMORY_KIND.SESSION]: [],
    [SIDEBAR_MEMORY_KIND.SECOND_LEVEL]: [],
    [SIDEBAR_MEMORY_KIND.SETTINGS]: [],
  };

  for (const entry of sidebarMemoryEntries.values()) {
    entriesByKind[entry.kind].push(entry);
  }

  return {
    [SIDEBAR_MEMORY_KIND.SESSION]: summarizeRuntimeMemoryEntries(
      entriesByKind[SIDEBAR_MEMORY_KIND.SESSION],
      entriesByKind[SIDEBAR_MEMORY_KIND.SESSION].length
    ),
    [SIDEBAR_MEMORY_KIND.SECOND_LEVEL]: summarizeRuntimeMemoryEntries(
      entriesByKind[SIDEBAR_MEMORY_KIND.SECOND_LEVEL],
      entriesByKind[SIDEBAR_MEMORY_KIND.SECOND_LEVEL].length
    ),
    [SIDEBAR_MEMORY_KIND.SETTINGS]: summarizeRuntimeMemoryEntries(
      entriesByKind[SIDEBAR_MEMORY_KIND.SETTINGS],
      entriesByKind[SIDEBAR_MEMORY_KIND.SETTINGS].length
    ),
  };
}
