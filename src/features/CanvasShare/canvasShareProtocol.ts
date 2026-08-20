import type { CanvasInlinePayload } from "@src/engines/ChatPanel/blocks/CanvasInlineCard/types";

export const CANVAS_SHARE_PROTOCOL_VERSION = 1 as const;
export const CANVAS_SHARE_HASH_PREFIX = "#/share/g1/";
export const CANVAS_SHARE_SHORT_HASH_PREFIX = "#/s/";
export const MAX_CANVAS_SHARE_SOURCE_BYTES = 512 * 1024;
export const MAX_CANVAS_SHARE_LINK_CHARACTERS = 64 * 1024;
export const MAX_CANVAS_SHARE_UPLOAD_CHARACTERS = 768 * 1024;
const MAX_CANVAS_SHARE_URL_CHARACTERS = 4_096;
const MAX_UTF8_BYTES_PER_CODE_UNIT = 3;
const CANVAS_SHARE_UPLOAD_TIMEOUT_MS = 8_000;
const MAX_CANVAS_SHARE_ENVELOPE_BYTES =
  MAX_CANVAS_SHARE_SOURCE_BYTES * 2 + 16 * 1024;

export const CANVAS_SHARE_VIEWER_URL = "https://canvas.org2.dev/";
export const CANVAS_SHARE_API_URL = "https://canvas.org2.dev/api/canvas-shares";
const CANVAS_SHARE_MODES = new Set(["html", "react", "a2ui", "url"]);
const CANVAS_SHARE_SHORT_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const MAX_CANVAS_SHARE_TITLE_CHARACTERS = 200;
const LOCAL_HOSTNAME_SUFFIXES = [".localhost", ".local", ".internal"];

export interface CanvasShareSnapshotV1 {
  mode: CanvasInlinePayload["mode"];
  title?: string;
  content?: string;
  url?: string;
}

export interface CanvasShareEnvelopeV1 {
  version: typeof CANVAS_SHARE_PROTOCOL_VERSION;
  canvas: CanvasShareSnapshotV1;
}

export type CanvasShareLinkResult =
  | { link: string; kind: "short"; expiresAt: string }
  | { link: string; kind: "self-contained" };

export type CanvasShareAvailability =
  | { available: true }
  | {
      available: false;
      reason:
        | "empty"
        | "streaming"
        | "local-url"
        | "source-too-large"
        | "unsupported-mode";
    };

export class CanvasShareProtocolError extends Error {
  constructor(
    public readonly code:
      | "invalid-payload"
      | "unsupported-runtime"
      | "source-too-large"
      | "link-too-large"
      | "short-link-unavailable"
      | "short-link-unavailable-too-large"
      | "unsupported-version",
    message: string
  ) {
    super(message);
    this.name = "CanvasShareProtocolError";
  }
}

function exceedsUtf8ByteLimit(source: string, limit: number): boolean {
  if (source.length > limit) return true;
  if (source.length * MAX_UTF8_BYTES_PER_CODE_UNIT <= limit) return false;
  return new TextEncoder().encode(source).byteLength > limit;
}

function parseIpv4Octets(hostname: string): number[] | null {
  const parts = hostname.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    octets.push(octet);
  }
  return octets;
}

function isPrivateIpv4(hostname: string): boolean {
  const octets = parseIpv4Octets(hostname);
  if (!octets) return false;
  const [first, second] = octets;
  return (
    first === 127 || // loopback
    first === 10 || // RFC 1918
    (first === 172 && second >= 16 && second <= 31) || // RFC 1918
    (first === 192 && second === 168) || // RFC 1918
    (first === 169 && second === 254) || // link-local
    first === 0 // "this network"
  );
}

function isPrivateIpv6(hostname: string): boolean {
  // The WHATWG URL parser serializes IPv6 hosts in brackets, e.g. "[::1]".
  if (!hostname.startsWith("[") || !hostname.endsWith("]")) return false;
  const address = hostname.slice(1, -1).toLowerCase();
  if (address === "::" || address === "::1") return true; // unspecified / loopback
  if (address.startsWith("::ffff:")) {
    // IPv4-mapped address; the URL parser canonicalizes it into hex groups.
    const groups = address.slice("::ffff:".length).split(":");
    if (groups.length === 2) {
      const high = Number.parseInt(groups[0], 16);
      const low = Number.parseInt(groups[1], 16);
      if (Number.isFinite(high) && Number.isFinite(low)) {
        return isPrivateIpv4(
          `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`
        );
      }
    }
    return false;
  }
  const firstGroup = address.split(":", 1)[0];
  const value = firstGroup === "" ? 0 : Number.parseInt(firstGroup, 16);
  if (!Number.isFinite(value)) return false;
  return (
    (value & 0xfe00) === 0xfc00 || // unique-local fc00::/7
    (value & 0xffc0) === 0xfe80 // link-local fe80::/10
  );
}

function isLocalHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  if (normalized === "localhost") return true;
  return LOCAL_HOSTNAME_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

/**
 * Shared by the producing availability gate and the decode validator: a
 * shareable URL must be HTTP(S) *and* resolve to a publicly routable host.
 * Loopback, RFC 1918, link-local, and `.local`/`.internal` hosts would leak a
 * link that only works on the author's machine or network, so both boundaries
 * reject them (availability reason `local-url`).
 */
function isPublicWebUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    return (
      !isLocalHostname(url.hostname) &&
      !isPrivateIpv4(url.hostname) &&
      !isPrivateIpv6(url.hostname)
    );
  } catch {
    return false;
  }
}

export function getCanvasShareAvailability(
  payload: CanvasInlinePayload | null,
  isStreaming: boolean
): CanvasShareAvailability {
  if (!payload) return { available: false, reason: "empty" };
  if (isStreaming || payload.streaming) {
    return { available: false, reason: "streaming" };
  }
  // The upstream extract casts unknown tool output, so an unrecognized mode
  // can reach this producer boundary; reject it before it is encoded into an
  // envelope the decode validator would refuse.
  if (!CANVAS_SHARE_MODES.has(payload.mode)) {
    return { available: false, reason: "unsupported-mode" };
  }

  if (payload.mode === "url") {
    if (!isPublicWebUrl(payload.url)) {
      return { available: false, reason: "local-url" };
    }
    if (payload.url.length > MAX_CANVAS_SHARE_URL_CHARACTERS) {
      return { available: false, reason: "source-too-large" };
    }
  } else if (!payload.content) {
    return { available: false, reason: "empty" };
  } else if (
    exceedsUtf8ByteLimit(payload.content, MAX_CANVAS_SHARE_SOURCE_BYTES)
  ) {
    return { available: false, reason: "source-too-large" };
  }
  return { available: true };
}

export function createCanvasShareEnvelope(
  payload: CanvasInlinePayload
): CanvasShareEnvelopeV1 {
  const availability = getCanvasShareAvailability(payload, false);
  if (!availability.available) {
    const code =
      availability.reason === "source-too-large"
        ? "source-too-large"
        : "invalid-payload";
    throw new CanvasShareProtocolError(
      code,
      `Canvas cannot be shared: ${availability.reason}`
    );
  }

  const title = payload.title?.trim();
  const canvas: CanvasShareSnapshotV1 = {
    mode: payload.mode,
    ...(title
      ? {
          title: truncateAtCodePointBoundary(
            title,
            MAX_CANVAS_SHARE_TITLE_CHARACTERS
          ),
        }
      : {}),
    ...(payload.mode === "url"
      ? { url: payload.url }
      : { content: payload.content }),
  };

  return { version: CANVAS_SHARE_PROTOCOL_VERSION, canvas };
}

/**
 * Truncates to at most `maxUnits` UTF-16 code units without bisecting a
 * surrogate pair; a bisected pair would round-trip through UTF-8 as U+FFFD in
 * the shared title.
 */
function truncateAtCodePointBoundary(value: string, maxUnits: number): string {
  if (value.length <= maxUnits) return value;
  const cut = value.slice(0, maxUnits);
  const lastUnit = cut.charCodeAt(cut.length - 1);
  const bisectsSurrogatePair = lastUnit >= 0xd800 && lastUnit <= 0xdbff;
  return bisectsSurrogatePair ? cut.slice(0, -1) : cut;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunkSize)
    );
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function toBufferSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy;
}

async function gzip(
  bytes: Uint8Array,
  signal?: AbortSignal
): Promise<Uint8Array> {
  if (typeof CompressionStream === "undefined") {
    throw new CanvasShareProtocolError(
      "unsupported-runtime",
      "This WebView cannot create compressed Canvas links."
    );
  }
  const compressed = new Blob([toBufferSource(bytes)])
    .stream()
    .pipeThrough(new CompressionStream("gzip"), { signal });
  return new Uint8Array(await new Response(compressed).arrayBuffer());
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Canvas share generation was cancelled.", "AbortError");
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    throw new CanvasShareProtocolError(
      "unsupported-runtime",
      "This runtime cannot open compressed Canvas links."
    );
  }
  const decompressed = new Blob([toBufferSource(bytes)])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  const reader = decompressed.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let done = false;
  while (!done) {
    const result = await reader.read();
    done = result.done;
    if (result.done) continue;
    const { value } = result;
    total += value.byteLength;
    if (total > MAX_CANVAS_SHARE_ENVELOPE_BYTES) {
      await reader.cancel();
      throw new CanvasShareProtocolError(
        "source-too-large",
        "Canvas share payload exceeds the supported size."
      );
    }
    chunks.push(value);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function resolveViewerUrl(viewerUrl?: string): URL {
  const configured =
    viewerUrl ??
    process.env.REACT_APP_CANVAS_SHARE_VIEWER_URL ??
    CANVAS_SHARE_VIEWER_URL;
  const url = new URL(configured);
  if (url.protocol !== "https:" && url.hostname !== "localhost") {
    throw new CanvasShareProtocolError(
      "invalid-payload",
      "Canvas share viewer must use HTTPS."
    );
  }
  url.search = "";
  url.hash = "";
  return url;
}

function resolveApiUrl(apiUrl?: string): URL {
  const configured =
    apiUrl ??
    process.env.REACT_APP_CANVAS_SHARE_API_URL ??
    CANVAS_SHARE_API_URL;
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new CanvasShareProtocolError(
      "invalid-payload",
      "Canvas share API URL is not a valid absolute URL."
    );
  }
  if (url.protocol !== "https:" && url.hostname !== "localhost") {
    throw new CanvasShareProtocolError(
      "invalid-payload",
      "Canvas share API must use HTTPS."
    );
  }
  url.hash = "";
  return url;
}

function buildViewerLink(hash: string, viewerUrl?: string): string {
  const url = resolveViewerUrl(viewerUrl);
  url.hash = hash.slice(1);
  return url.toString();
}

export async function encodeCanvasSharePayload(
  payload: CanvasInlinePayload,
  signal?: AbortSignal
): Promise<string> {
  throwIfAborted(signal);
  const envelope = createCanvasShareEnvelope(payload);
  const encoded = bytesToBase64Url(
    await gzip(new TextEncoder().encode(JSON.stringify(envelope)), signal)
  );
  throwIfAborted(signal);
  return encoded;
}

export function buildSelfContainedCanvasShareLink(
  encoded: string,
  viewerUrl?: string
): string {
  const link = buildViewerLink(
    `${CANVAS_SHARE_HASH_PREFIX}${encoded}`,
    viewerUrl
  );
  if (link.length > MAX_CANVAS_SHARE_LINK_CHARACTERS) {
    throw new CanvasShareProtocolError(
      "link-too-large",
      "Canvas is too large to fit in a reliable share link."
    );
  }
  return link;
}

interface ShortCanvasShareResponse {
  id: string;
  expiresAt: string;
}

function isShortCanvasShareResponse(
  value: unknown
): value is ShortCanvasShareResponse {
  if (!value || typeof value !== "object") return false;
  const response = value as Record<string, unknown>;
  return (
    typeof response.id === "string" &&
    CANVAS_SHARE_SHORT_ID_PATTERN.test(response.id) &&
    typeof response.expiresAt === "string" &&
    Number.isFinite(Date.parse(response.expiresAt))
  );
}

async function uploadCanvasSharePayload(
  encoded: string,
  apiUrl: string | undefined,
  signal?: AbortSignal
): Promise<ShortCanvasShareResponse> {
  if (encoded.length > MAX_CANVAS_SHARE_UPLOAD_CHARACTERS) {
    throw new CanvasShareProtocolError(
      "source-too-large",
      "Compressed Canvas snapshot exceeds the upload limit."
    );
  }
  throwIfAborted(signal);

  // Resolve outside the failure-tolerant region below: a misconfigured API
  // URL is a build/deployment defect and must fail loudly with its own error
  // instead of being laundered into the retryable "service unavailable" path.
  const target = resolveApiUrl(apiUrl);

  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = globalThis.setTimeout(
    () => controller.abort(new Error("Canvas short-link upload timed out.")),
    CANVAS_SHARE_UPLOAD_TIMEOUT_MS
  );

  try {
    const response = await fetch(target, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({ payload: encoded }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Canvas share API returned ${response.status}.`);
    }
    const value: unknown = await response.json();
    if (!isShortCanvasShareResponse(value)) {
      throw new Error("Canvas share API returned an invalid response.");
    }
    return value;
  } catch (error) {
    throwIfAborted(signal);
    throw new CanvasShareProtocolError(
      "short-link-unavailable",
      error instanceof Error
        ? error.message
        : "Canvas short-link service is unavailable."
    );
  } finally {
    globalThis.clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromCaller);
  }
}

/**
 * Builds an immutable public Canvas link. It prefers the compact hosted form;
 * if the upload boundary is unavailable, it falls back to the original
 * self-contained fragment without making sharing dependent on cloud uptime.
 */
export async function buildCanvasShareLink(
  payload: CanvasInlinePayload,
  viewerUrl?: string,
  signal?: AbortSignal,
  apiUrl?: string
): Promise<CanvasShareLinkResult> {
  const encoded = await encodeCanvasSharePayload(payload, signal);
  try {
    const uploaded = await uploadCanvasSharePayload(encoded, apiUrl, signal);
    return {
      link: buildViewerLink(
        `${CANVAS_SHARE_SHORT_HASH_PREFIX}${uploaded.id}`,
        viewerUrl
      ),
      kind: "short",
      expiresAt: uploaded.expiresAt,
    };
  } catch (error) {
    throwIfAborted(signal);
    if (
      error instanceof CanvasShareProtocolError &&
      error.code !== "short-link-unavailable"
    ) {
      throw error;
    }
    try {
      return {
        link: buildSelfContainedCanvasShareLink(encoded, viewerUrl),
        kind: "self-contained",
      };
    } catch (fallbackError) {
      if (
        fallbackError instanceof CanvasShareProtocolError &&
        fallbackError.code === "link-too-large"
      ) {
        // The snapshot fits the hosted upload but not a self-contained link.
        // Reporting "too large" here would mask a transient service outage,
        // so surface a retryable outage-specific error instead.
        throw new CanvasShareProtocolError(
          "short-link-unavailable-too-large",
          "The Canvas short-link service is unavailable and this snapshot does not fit in a self-contained link."
        );
      }
      throw fallbackError;
    }
  }
}

export async function parseCanvasShareHash(
  hash: string
): Promise<CanvasShareEnvelopeV1> {
  if (!hash.startsWith(CANVAS_SHARE_HASH_PREFIX)) {
    throw new CanvasShareProtocolError(
      "invalid-payload",
      "Canvas share link has an unknown format."
    );
  }
  const encoded = hash.slice(CANVAS_SHARE_HASH_PREFIX.length);
  try {
    const json = new TextDecoder().decode(
      await gunzip(base64UrlToBytes(encoded))
    );
    const value: unknown = JSON.parse(json);
    if (isNewerVersionEnvelope(value)) {
      throw new CanvasShareProtocolError(
        "unsupported-version",
        "This Canvas share link was created by a newer version and cannot be opened here."
      );
    }
    if (!isCanvasShareEnvelope(value)) throw new Error("Invalid envelope");
    return value;
  } catch (error) {
    if (error instanceof CanvasShareProtocolError) throw error;
    throw new CanvasShareProtocolError(
      "invalid-payload",
      "Canvas share link is incomplete or invalid."
    );
  }
}

/**
 * A structurally sound envelope stamped with a version above the supported
 * one is not corruption — it was created by a newer producer. Detecting it
 * lets the decoder report "created by a newer version" instead of the generic
 * "incomplete or invalid" error.
 */
function isNewerVersionEnvelope(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const envelope = value as Record<string, unknown>;
  return (
    typeof envelope.version === "number" &&
    Number.isInteger(envelope.version) &&
    envelope.version > CANVAS_SHARE_PROTOCOL_VERSION
  );
}

export function isCanvasShareEnvelope(
  value: unknown
): value is CanvasShareEnvelopeV1 {
  if (!value || typeof value !== "object") return false;
  const envelope = value as Record<string, unknown>;
  if (envelope.version !== CANVAS_SHARE_PROTOCOL_VERSION) return false;
  if (!envelope.canvas || typeof envelope.canvas !== "object") return false;
  const canvas = envelope.canvas as Record<string, unknown>;
  if (typeof canvas.mode !== "string" || !CANVAS_SHARE_MODES.has(canvas.mode)) {
    return false;
  }
  if (canvas.title !== undefined && typeof canvas.title !== "string") {
    return false;
  }
  if (
    typeof canvas.title === "string" &&
    canvas.title.length > MAX_CANVAS_SHARE_TITLE_CHARACTERS
  ) {
    return false;
  }
  if (canvas.mode === "url") {
    return (
      typeof canvas.url === "string" &&
      canvas.url.length <= MAX_CANVAS_SHARE_URL_CHARACTERS &&
      isPublicWebUrl(canvas.url)
    );
  }
  return (
    typeof canvas.content === "string" &&
    canvas.content.length > 0 &&
    !exceedsUtf8ByteLimit(canvas.content, MAX_CANVAS_SHARE_SOURCE_BYTES)
  );
}
