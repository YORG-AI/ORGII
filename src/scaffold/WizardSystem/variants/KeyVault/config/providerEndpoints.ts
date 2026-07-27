/**
 * Endpoint + protocol → base URL resolution.
 *
 * Endpoints and their URLs are owned by the Rust provider registry
 * (`src-tauri/.../provider_config.rs`) and reach the wizard through
 * `useProviderConfig`. Nothing here hardcodes a provider's URL.
 */
import type {
  ProviderEndpoint,
  ProviderProtocol,
} from "@src/api/tauri/rpc/schemas/validation";

/** A provider offers a choice only when it declares more than one endpoint. */
export function hasEndpointChoice(
  endpoints: readonly ProviderEndpoint[]
): boolean {
  return endpoints.length > 1;
}

/**
 * The endpoint serving `baseUrl` on either protocol, or `undefined` when the
 * URL belongs to none of them — a custom proxy, say.
 */
export function findEndpointByBaseUrl(
  endpoints: readonly ProviderEndpoint[],
  baseUrl?: string | null
): ProviderEndpoint | undefined {
  if (!baseUrl) return undefined;
  return endpoints.find(
    (endpoint) =>
      endpoint.base_url === baseUrl || endpoint.anthropic_base_url === baseUrl
  );
}

/**
 * The endpoint that `baseUrl` belongs to.
 *
 * Falls back to the provider's default (first) endpoint when the URL is unset
 * or points at a custom proxy, so the picker always shows a selection.
 * Returns `undefined` only for providers with no endpoint table at all.
 */
export function resolveSelectedEndpoint(
  endpoints: readonly ProviderEndpoint[],
  baseUrl?: string | null,
  preferredEndpointId?: string | null
): ProviderEndpoint | undefined {
  if (endpoints.length === 0) return undefined;

  // Prefer the explicit wizard selection when the current URL still belongs
  // to it. This matters when sibling endpoints share a protocol URL (Zhipu's
  // API and Subscription routes use the same Anthropic host).
  const preferredEndpoint = preferredEndpointId
    ? endpoints.find((endpoint) => endpoint.id === preferredEndpointId)
    : undefined;
  if (
    preferredEndpoint &&
    (!baseUrl ||
      preferredEndpoint.base_url === baseUrl ||
      preferredEndpoint.anthropic_base_url === baseUrl)
  ) {
    return preferredEndpoint;
  }

  return findEndpointByBaseUrl(endpoints, baseUrl) ?? endpoints[0];
}

/**
 * Official base URL for `protocol` at `endpoint`.
 *
 * An endpoint with no dedicated Anthropic host serves both protocols from its
 * `base_url`. Providers with no endpoint table fall back to the single
 * `defaultBaseUrl` the registry hands out.
 */
export function getOfficialBaseUrl(
  endpoint: ProviderEndpoint | undefined,
  protocol: ProviderProtocol,
  defaultBaseUrl?: string | null
): string | undefined {
  if (!endpoint) return defaultBaseUrl ?? undefined;
  if (protocol === "anthropic") {
    return endpoint.anthropic_base_url ?? endpoint.base_url;
  }
  return endpoint.base_url;
}
