export interface InternalFileDragPayload {
  path: string;
  name: string;
  type: "file" | "directory";
}

export interface WorkstationTabDragPayload {
  path: string;
  name?: string;
  iconType?: string;
  isFolder?: boolean;
  contextText?: string;
}

export interface ReferenceDragStash {
  timestamp: number;
  [key: string]: unknown;
}

const REFERENCE_STASH_TTL_MS = 30_000;

export function setInternalFileTreeDrag(
  payload: InternalFileDragPayload
): void {
  window.__internalFileTreeDrag = true;
  window.__internalFileTreeDragData = JSON.stringify(payload);
}

export function isInternalFileTreeDragActive(): boolean {
  return window.__internalFileTreeDrag === true;
}

export function clearInternalFileTreeDrag(): void {
  window.__internalFileTreeDrag = false;
  window.__internalFileTreeDragData = undefined;
}

export function consumeInternalFileTreeDragData(): string | undefined {
  const data = window.__internalFileTreeDragData;
  window.__internalFileTreeDragData = undefined;
  return typeof data === "string" ? data : undefined;
}

export function setWorkstationTabDrag(
  payload: WorkstationTabDragPayload
): void {
  window.__internalWorkstationTabDrag = true;
  window.__internalWorkstationTabDragData = JSON.stringify(payload);
}

export function isWorkstationTabDragActive(): boolean {
  return window.__internalWorkstationTabDrag === true;
}

export function clearWorkstationTabDrag(): void {
  window.__internalWorkstationTabDrag = false;
  window.__internalWorkstationTabDragData = undefined;
}

export function consumeWorkstationTabDragData(): string | undefined {
  const data = window.__internalWorkstationTabDragData;
  clearWorkstationTabDrag();
  return typeof data === "string" ? data : undefined;
}

export function hasFreshReferenceDragStash(): boolean {
  return Boolean(getFreshPrDragStash() || getFreshIssueDragStash());
}

export function getFreshPrDragStash(): ReferenceDragStash | undefined {
  return getFreshReferenceDragStash(window.__orgiiLastPrDrag);
}

export function getFreshIssueDragStash(): ReferenceDragStash | undefined {
  return getFreshReferenceDragStash(window.__orgiiLastIssueDrag);
}

export function setPrDragStash(payload: Record<string, unknown>): void {
  window.__orgiiLastPrDrag = { ...payload, timestamp: Date.now() };
}

export function setIssueDragStash(payload: Record<string, unknown>): void {
  window.__orgiiLastIssueDrag = { ...payload, timestamp: Date.now() };
}

export function clearPrDragStash(): void {
  window.__orgiiLastPrDrag = undefined;
}

export function clearIssueDragStash(): void {
  window.__orgiiLastIssueDrag = undefined;
}

function getFreshReferenceDragStash(
  stash: ReferenceDragStash | undefined
): ReferenceDragStash | undefined {
  return stash && Date.now() - stash.timestamp < REFERENCE_STASH_TTL_MS
    ? stash
    : undefined;
}
