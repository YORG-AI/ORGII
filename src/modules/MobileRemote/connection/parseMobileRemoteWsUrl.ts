import type { MobileConnectionConfig } from "./types";

export type ParseMobileRemoteWsUrlErrorKey =
  | "pairing.errors.empty"
  | "pairing.errors.invalid"
  | "pairing.errors.unsupportedVersion";

export type ParseMobileRemoteWsUrlResult =
  | {
      ok: true;
      config: MobileConnectionConfig;
      /** Phase 1 relay flow — show SAS confirm before connect. */
      requiresSas: boolean;
      sasPhrase?: string;
    }
  | {
      ok: false;
      errorKey: ParseMobileRemoteWsUrlErrorKey;
    };

const DEFAULT_LAN_PORT = 13847;

interface Phase1QrPayload {
  v?: number;
  relayUrl?: string;
  pairingCode?: string;
  host?: string;
  port?: number;
  token?: string;
  deviceToken?: string;
  desktopId?: string;
  sasPhrase?: string;
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding =
    normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return atob(normalized + padding);
}

function parsePhase1Payload(
  raw: Phase1QrPayload
): ParseMobileRemoteWsUrlResult {
  if (raw.v != null && raw.v !== 1) {
    return { ok: false, errorKey: "pairing.errors.unsupportedVersion" };
  }

  if (raw.relayUrl?.trim()) {
    if (!raw.deviceToken?.trim()) {
      return { ok: false, errorKey: "pairing.errors.invalid" };
    }
    return {
      ok: true,
      config: {
        wsUrl: raw.relayUrl.trim(),
        deviceToken: raw.deviceToken.trim(),
        pairingCode: raw.pairingCode?.trim() || undefined,
        desktopId: raw.desktopId?.trim() || undefined,
      },
      requiresSas: Boolean(raw.pairingCode?.trim()),
      sasPhrase: raw.sasPhrase?.trim() || undefined,
    };
  }

  if (raw.host?.trim()) {
    return {
      ok: true,
      config: {
        host: raw.host.trim(),
        port: raw.port ?? DEFAULT_LAN_PORT,
        token: raw.token?.trim(),
      },
      requiresSas: Boolean(raw.pairingCode?.trim()),
      sasPhrase: raw.sasPhrase?.trim() || undefined,
    };
  }

  return { ok: false, errorKey: "pairing.errors.invalid" };
}

function parseWsUrl(raw: string): ParseMobileRemoteWsUrlResult {
  try {
    const url = new URL(raw);
    if (url.protocol !== "ws:" && url.protocol !== "wss:") {
      return { ok: false, errorKey: "pairing.errors.invalid" };
    }

    const token = url.searchParams.get("token") ?? undefined;
    const host = url.hostname;
    const port = url.port
      ? Number.parseInt(url.port, 10)
      : url.protocol === "wss:"
        ? 443
        : DEFAULT_LAN_PORT;

    if (!host) {
      return { ok: false, errorKey: "pairing.errors.invalid" };
    }

    return {
      ok: true,
      config: {
        wsUrl: raw.trim(),
        host,
        port: Number.isFinite(port) ? port : DEFAULT_LAN_PORT,
        token,
      },
      requiresSas: false,
    };
  } catch {
    return { ok: false, errorKey: "pairing.errors.invalid" };
  }
}

function parsePairingLink(raw: string): ParseMobileRemoteWsUrlResult | null {
  if (
    !raw.startsWith("orgii://") &&
    !raw.startsWith("https://") &&
    !raw.startsWith("http://")
  ) {
    return null;
  }
  try {
    const url = new URL(raw);
    const isDeepLink =
      url.protocol === "orgii:" &&
      url.hostname === "mobile" &&
      url.pathname === "/pair";
    const isWebLink =
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.pathname.endsWith("/orgii/mobile");
    if (!isDeepLink && !isWebLink) return null;
    const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
    const payload =
      url.searchParams.get("payload") ?? fragment.get("pair") ?? undefined;
    if (!payload?.trim()) {
      return { ok: false, errorKey: "pairing.errors.invalid" };
    }
    const decoded = decodeBase64Url(payload.trim());
    const json = JSON.parse(decoded) as Phase1QrPayload;
    return parsePhase1Payload(json);
  } catch {
    return { ok: false, errorKey: "pairing.errors.invalid" };
  }
}

/** Parse QR text, deep link, JSON payload, or manual ws/wss URL entry. */
export function parseMobileRemoteWsUrl(
  input: string
): ParseMobileRemoteWsUrlResult {
  const raw = input.trim();
  if (!raw) {
    return { ok: false, errorKey: "pairing.errors.empty" };
  }

  const deepLink = parsePairingLink(raw);
  if (deepLink) {
    return deepLink;
  }

  if (raw.startsWith("{")) {
    try {
      const json = JSON.parse(raw) as Phase1QrPayload;
      return parsePhase1Payload(json);
    } catch {
      return { ok: false, errorKey: "pairing.errors.invalid" };
    }
  }

  if (raw.startsWith("ws://") || raw.startsWith("wss://")) {
    return parseWsUrl(raw);
  }

  return { ok: false, errorKey: "pairing.errors.invalid" };
}
