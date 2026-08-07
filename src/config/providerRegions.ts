/**
 * Provider Region Availability
 *
 * Maps AI providers and CLI agents to the countries/territories where
 * their API services are officially supported. Uses ISO 3166-1 alpha-2
 * country codes (same format returned by ipinfo.io).
 *
 * Sources:
 *   OpenAI:    https://developers.openai.com/api/docs/supported-countries/
 *   Anthropic: https://www.anthropic.com/supported-countries
 *   Google:    https://ai.google.dev/gemini-api/docs/available-regions
 *
 * Providers without documented region restrictions (gateways, self-hosted,
 * Chinese domestic providers) are not mapped — callers treat null as
 * "no restriction data available".
 *
 * Last verified: 2026-03-14
 */
import { CLI_AGENT, type ModelType } from "@src/api/types/keys";

// ── Region Sets ──────────────────────────────────────────────

// prettier-ignore
const OPENAI_COUNTRIES: readonly string[] = [
  "AD", "AE", "AF", "AG", "AL", "AM", "AO", "AR", "AT", "AU", "AZ",
  "BA", "BB", "BD", "BE", "BF", "BG", "BH", "BI", "BJ", "BN", "BO",
  "BR", "BS", "BT", "BW", "BZ",
  "CA", "CD", "CF", "CG", "CH", "CI", "CL", "CM", "CO", "CR", "CV", "CY", "CZ",
  "DE", "DJ", "DK", "DM", "DO", "DZ",
  "EC", "EE", "EG", "ER", "ES", "ET",
  "FI", "FJ", "FM", "FR",
  "GA", "GB", "GD", "GE", "GH", "GM", "GN", "GQ", "GR", "GT", "GW", "GY",
  "HN", "HR", "HT", "HU",
  "ID", "IE", "IL", "IN", "IQ", "IS", "IT",
  "JM", "JO", "JP",
  "KE", "KG", "KH", "KI", "KM", "KN", "KR", "KW", "KZ",
  "LA", "LB", "LC", "LI", "LK", "LR", "LS", "LT", "LU", "LV", "LY",
  "MA", "MC", "MD", "ME", "MG", "MH", "MK", "ML", "MM", "MN", "MR",
  "MT", "MU", "MV", "MW", "MX", "MY", "MZ",
  "NA", "NE", "NG", "NI", "NL", "NO", "NP", "NR", "NZ",
  "OM",
  "PA", "PE", "PG", "PH", "PK", "PL", "PS", "PT", "PW", "PY",
  "QA",
  "RO", "RS", "RW",
  "SA", "SB", "SC", "SD", "SE", "SG", "SI", "SK", "SL", "SM", "SN",
  "SO", "SR", "SS", "ST", "SV", "SZ",
  "TD", "TG", "TH", "TJ", "TL", "TM", "TN", "TO", "TR", "TT", "TV", "TW", "TZ",
  "UA", "UG", "US", "UY", "UZ",
  "VA", "VC", "VN", "VU",
  "WS",
  "YE",
  "ZA", "ZM", "ZW",
];

// prettier-ignore
const ANTHROPIC_COUNTRIES: readonly string[] = [
  "AD", "AE", "AG", "AL", "AM", "AO", "AR", "AT", "AU", "AZ",
  "BA", "BB", "BD", "BE", "BF", "BG", "BH", "BI", "BJ", "BN", "BO",
  "BR", "BS", "BT", "BW", "BZ",
  "CA", "CG", "CH", "CI", "CL", "CM", "CO", "CR", "CV", "CY", "CZ",
  "DE", "DJ", "DK", "DM", "DO", "DZ",
  "EC", "EE", "EG", "ES",
  "FI", "FJ", "FM", "FR",
  "GA", "GB", "GD", "GE", "GH", "GM", "GN", "GQ", "GR", "GT", "GW", "GY",
  "HN", "HR", "HT", "HU",
  "ID", "IE", "IL", "IN", "IQ", "IS", "IT",
  "JM", "JO", "JP",
  "KE", "KG", "KH", "KI", "KM", "KN", "KR", "KW", "KZ",
  "LA", "LB", "LC", "LI", "LK", "LR", "LS", "LT", "LU", "LV",
  "MA", "MC", "MD", "ME", "MG", "MH", "MK", "MN", "MR",
  "MT", "MU", "MV", "MW", "MX", "MY", "MZ",
  "NA", "NE", "NG", "NL", "NO", "NP", "NR", "NZ",
  "OM",
  "PA", "PE", "PG", "PH", "PK", "PL", "PS", "PT", "PW", "PY",
  "QA",
  "RO", "RS", "RW",
  "SA", "SB", "SC", "SE", "SG", "SI", "SK", "SL", "SM", "SN", "SR",
  "ST", "SV", "SZ",
  "TD", "TG", "TH", "TJ", "TL", "TM", "TN", "TO", "TR", "TT", "TV", "TW", "TZ",
  "UA", "UG", "US", "UY", "UZ",
  "VA", "VC", "VN", "VU",
  "WS",
  "ZA", "ZM", "ZW",
];

// prettier-ignore
const GOOGLE_COUNTRIES: readonly string[] = [
  "AD", "AE", "AG", "AI", "AL", "AM", "AO", "AQ", "AR", "AS", "AT", "AU",
  "AW", "AX", "AZ",
  "BA", "BB", "BD", "BE", "BF", "BG", "BH", "BI", "BJ", "BL", "BM", "BN",
  "BO", "BQ", "BR", "BS", "BT", "BW", "BZ",
  "CA", "CC", "CD", "CF", "CG", "CH", "CI", "CK", "CL", "CM", "CO", "CR",
  "CV", "CW", "CX", "CY", "CZ",
  "DE", "DJ", "DK", "DM", "DO", "DZ",
  "EC", "EE", "EG", "EH", "ER", "ES", "ET",
  "FI", "FJ", "FK", "FM", "FO", "FR",
  "GA", "GB", "GD", "GE", "GF", "GG", "GH", "GI", "GL", "GM", "GN", "GQ",
  "GR", "GS", "GT", "GU", "GW", "GY",
  "HM", "HN", "HR", "HT", "HU",
  "ID", "IE", "IL", "IM", "IN", "IO", "IQ", "IS", "IT",
  "JE", "JM", "JO", "JP",
  "KE", "KG", "KH", "KI", "KM", "KN", "KR", "KW", "KY", "KZ",
  "LA", "LB", "LC", "LI", "LK", "LR", "LS", "LT", "LU", "LV", "LY",
  "MA", "MC", "MD", "ME", "MG", "MH", "MK", "ML", "MN", "MP", "MR", "MS",
  "MT", "MU", "MV", "MW", "MX", "MY", "MZ",
  "NA", "NC", "NE", "NF", "NG", "NI", "NL", "NO", "NP", "NR", "NU", "NZ",
  "OM",
  "PA", "PE", "PG", "PH", "PK", "PL", "PM", "PN", "PR", "PS", "PT", "PW", "PY",
  "QA",
  "RE", "RO", "RS", "RW",
  "SA", "SB", "SC", "SD", "SE", "SG", "SH", "SI", "SK", "SL", "SM", "SN",
  "SO", "SR", "SS", "ST", "SV", "SZ",
  "TC", "TD", "TG", "TH", "TJ", "TK", "TL", "TM", "TN", "TO", "TR", "TT",
  "TV", "TW", "TZ",
  "UA", "UG", "UM", "US", "UY", "UZ",
  "VA", "VC", "VE", "VG", "VI", "VN", "VU",
  "WF", "WS",
  "XK",
  "YE",
  "ZA", "ZM", "ZW",
];

const OPENAI_REGIONS: ReadonlySet<string> = new Set(OPENAI_COUNTRIES);
const ANTHROPIC_REGIONS: ReadonlySet<string> = new Set(ANTHROPIC_COUNTRIES);
const GOOGLE_REGIONS: ReadonlySet<string> = new Set(GOOGLE_COUNTRIES);

// ── Agent → Region Mapping ───────────────────────────────────
//
// Only providers with *documented* region policies are mapped.
// Unmapped providers (gateways like OpenRouter, self-hosted
// like vLLM, Chinese domestic APIs) return null from lookup functions.

const AGENT_REGION_MAP: Partial<Record<ModelType, ReadonlySet<string>>> = {
  openai_api: OPENAI_REGIONS,
  anthropic_api: ANTHROPIC_REGIONS,
  gemini_api: GOOGLE_REGIONS,
  [CLI_AGENT.CURSOR]: OPENAI_REGIONS,
  [CLI_AGENT.CODEX]: OPENAI_REGIONS,
  [CLI_AGENT.CLAUDE_CODE]: ANTHROPIC_REGIONS,
};

// ── Utilities ────────────────────────────────────────────────

export type RegionSupportStatus = "supported" | "unsupported" | "unknown";

/**
 * Check if a country is in the provider's supported regions list.
 * Returns "unknown" when the provider has no documented restrictions.
 */
export function checkRegionSupport(
  agentType: ModelType | "",
  countryCode: string
): RegionSupportStatus {
  if (!agentType) return "unknown";
  const regions = AGENT_REGION_MAP[agentType as ModelType];
  if (!regions) return "unknown";
  return regions.has(countryCode.toUpperCase()) ? "supported" : "unsupported";
}

/**
 * Get the supported region set for a provider (null if no documented restrictions).
 */
export function getProviderSupportedRegions(
  agentType: ModelType
): ReadonlySet<string> | null {
  return AGENT_REGION_MAP[agentType] ?? null;
}

/**
 * Whether a provider has documented region restrictions we can check against.
 */
export function hasRegionRestrictions(agentType: ModelType | ""): boolean {
  if (!agentType) return false;
  return (agentType as ModelType) in AGENT_REGION_MAP;
}

// ── Cross-provider check (for generic CLIs) ──────────────────

const MAJOR_PROVIDER_REGIONS: { name: string; regions: ReadonlySet<string> }[] =
  [
    { name: "OpenAI", regions: OPENAI_REGIONS },
    { name: "Anthropic", regions: ANTHROPIC_REGIONS },
    { name: "Google", regions: GOOGLE_REGIONS },
  ];

/**
 * For CLIs without a single provider (aider, cline, goose, etc.),
 * returns the names of major model providers that do NOT support the country.
 * Empty array = all major providers support this region.
 */
export function getRestrictedProviders(countryCode: string): string[] {
  const upper = countryCode.toUpperCase();
  return MAJOR_PROVIDER_REGIONS.filter(
    (provider) => !provider.regions.has(upper)
  ).map((provider) => provider.name);
}

// ── Service-level sanctions / trade restrictions ─────────────
//
// Countries where platforms like GitHub, npm, Docker Hub, and most
// US/EU-based cloud services are blocked or severely restricted due
// to trade sanctions or government policy.
//
// This is an exclusion list (countries where services are NOT available),
// unlike the AI provider lists above which are inclusion lists.

// prettier-ignore
const SANCTIONED_COUNTRIES: readonly string[] = [
  "IR",   // Iran
  "SY",   // Syria
  "KP",   // North Korea
  "CU",   // Cuba
  "RU",   // Russia
  "CN",   // China Mainland
  "TM",   // Turkmenistan
];

const SANCTIONED_SET: ReadonlySet<string> = new Set(SANCTIONED_COUNTRIES);

const RESTRICTED_SERVICES = ["GitHub", "npm", "Docker Hub"] as const;

/**
 * Check if a country is in the sanctioned/restricted list.
 */
export function isRegionSanctioned(countryCode: string): boolean {
  return SANCTIONED_SET.has(countryCode.toUpperCase());
}

/**
 * Returns platform services that may be unavailable in the given country
 * due to trade sanctions. Empty array = no known restrictions.
 */
export function getRestrictedServices(countryCode: string): string[] {
  if (!isRegionSanctioned(countryCode)) return [];
  return [...RESTRICTED_SERVICES];
}
