/**
 * secretScan
 *
 * Client-side detector for credentials (API keys, tokens, passwords) in
 * user-typed composer text. It runs at submit time so we can warn the user
 * before a secret is written into the chat transcript and sent to the model.
 *
 * Design goals:
 *   - Precision first. Tier 1 (structured provider tokens) and Tier 2
 *     (`key = value` assignments) fire only on shapes that are almost
 *     certainly secrets, so the warning stays trustworthy.
 *   - Opt-in recall. Tier 3 (high-entropy strings) catches unknown/rotated
 *     keys but is noisier, so it is gated behind a setting.
 *   - No ReDoS. Every built-in pattern is linear-time (fixed prefix + a single
 *     character class); input is length-capped before scanning so even a
 *     pathological user-supplied custom pattern can't pin the thread for long.
 *   - Never echoes the secret. Matches are masked (`sk-…AB12`) for display.
 *
 * This module is pure (no React / dialog / settings imports) so it can be unit
 * tested in isolation and reused from any submit path.
 */

interface SecretMatch {
  /** Stable identifier used to de-duplicate findings (e.g. "openai"). */
  type: string;
  /** Human-readable label shown in the warning (e.g. "OpenAI API key"). */
  label: string;
  /** Masked representation of the matched text — safe to display. */
  masked: string;
}

interface SecretScanOptions {
  /** Enable Tier 3 high-entropy detection (noisier). Default: false. */
  entropy?: boolean;
  /** User-supplied regex strings; each match is treated as a secret. */
  customPatterns?: string[];
  /** Scan at most this many characters (ReDoS / cost guard). Default 100k. */
  maxLength?: number;
}

// ── Tier 1: structured provider tokens ──────────────────────────────────────
// Fixed prefix + known charset/length. A hit here is almost always a real key.
interface StructuredPattern {
  type: string;
  label: string;
  re: RegExp;
}

const STRUCTURED: StructuredPattern[] = [
  // `(?!ant-)` so Anthropic keys fall through to their own (more specific) rule.
  {
    type: "openai",
    label: "OpenAI API key",
    re: /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{20,}\b/,
  },
  {
    type: "anthropic",
    label: "Anthropic API key",
    re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/,
  },
  {
    type: "aws_akid",
    label: "AWS access key ID",
    re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|AIPA|ANVA)[A-Z0-9]{16}\b/,
  },
  {
    type: "github",
    label: "GitHub token",
    re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/,
  },
  { type: "gitlab", label: "GitLab token", re: /\bglpat-[A-Za-z0-9_-]{20}\b/ },
  {
    type: "google_api",
    label: "Google API key",
    re: /\bAIza[0-9A-Za-z_-]{35}\b/,
  },
  {
    type: "slack",
    label: "Slack token",
    re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/,
  },
  {
    type: "slack_webhook",
    label: "Slack webhook URL",
    re: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/,
  },
  {
    type: "stripe",
    label: "Stripe secret key",
    re: /\b(?:sk|rk)_live_[0-9A-Za-z]{20,}\b/,
  },
  {
    type: "sendgrid",
    label: "SendGrid key",
    re: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/,
  },
  { type: "twilio", label: "Twilio API key", re: /\bSK[0-9a-fA-F]{32}\b/ },
  { type: "npm", label: "npm token", re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  {
    type: "huggingface",
    label: "Hugging Face token",
    re: /\bhf_[A-Za-z0-9]{34,}\b/,
  },
  {
    type: "jwt",
    label: "JSON Web Token",
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  },
  {
    type: "private_key",
    label: "Private key block",
    re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/,
  },
  {
    type: "url_credentials",
    label: "Password in URL",
    re: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s:@]+@/i,
  },
];

// ── Tier 2: `key = value` credential assignments ────────────────────────────
// The precision comes from requiring a secret-y name on the left-hand side.
// Group 2 captures the value (what we mask).
const ASSIGNMENT =
  /\b(pass(?:word|wd)?|pwd|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|passphrase)\b\s*[:=]\s*['"]?([^\s'"]{6,})/i;

// ── Allowlist: kill obvious false positives before warning ──────────────────
const IGNORE: RegExp[] = [
  /^[0-9a-f]{40}$/i, // git SHA-1
  /^[0-9a-f]{64}$/i, // SHA-256 digest
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, // UUID
  /^AKIAIOSFODNN7EXAMPLE$/, // AWS's own documentation example
  /example|dummy|placeholder|redacted|sample|your[_-]?(?:api|key|token|secret|password)|xxx+|\.\.\.|<[^>]+>/i,
];

function isAllowlisted(value: string): boolean {
  return IGNORE.some((re) => re.test(value));
}

/** Mask a secret for display: keep a short prefix + suffix, hide the middle. */
export function maskSecret(value: string): string {
  if (value.length <= 8) return "•".repeat(Math.max(value.length, 3));
  return `${value.slice(0, 3)}…${value.slice(-4)}`;
}

/**
 * Return the first match of `re` in `input` that is not allowlisted, or null.
 * Uses a global-flagged clone so we can skip over allowlisted hits (e.g. a
 * placeholder) and still find a real one later in the text.
 */
function firstRealMatch(input: string, re: RegExp): string | null {
  const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
  const g = new RegExp(re.source, flags);
  let m: RegExpExecArray | null;
  let guard = 0;
  while ((m = g.exec(input)) !== null && guard < 2000) {
    guard += 1;
    const candidate = m[0];
    if (m.index === g.lastIndex) g.lastIndex += 1; // avoid zero-length loop
    if (!isAllowlisted(candidate)) return candidate;
  }
  return null;
}

/** Shannon entropy in bits/char — higher means more random-looking. */
export function shannonEntropy(value: string): number {
  if (!value) return 0;
  const freq: Record<string, number> = {};
  for (const ch of value) freq[ch] = (freq[ch] ?? 0) + 1;
  let h = 0;
  for (const count of Object.values(freq)) {
    const p = count / value.length;
    h -= p * Math.log2(p);
  }
  return h;
}

const ENTROPY_MIN_LENGTH = 20;
const ENTROPY_MAX_LENGTH = 200;
const ENTROPY_THRESHOLD = 4.0;
const ENTROPY_TOKEN_SPLIT = /[\s"'`,;(){}[\]<>]+/;

function looksLikeSecretToken(token: string): boolean {
  if (token.length < ENTROPY_MIN_LENGTH || token.length > ENTROPY_MAX_LENGTH) {
    return false;
  }
  if (isAllowlisted(token)) return false;
  // Require a mixed charset — pure words/numbers are almost never keys.
  const mixed = /[A-Za-z]/.test(token) && /[0-9]/.test(token);
  if (!mixed) return false;
  // Already covered by a structured rule — don't double-report.
  if (STRUCTURED.some((p) => p.re.test(token))) return false;
  return shannonEntropy(token) >= ENTROPY_THRESHOLD;
}

/** Validate a single custom pattern; returns an error message or null if ok. */
export function validateCustomPattern(pattern: string): string | null {
  const trimmed = pattern.trim();
  if (!trimmed) return null;
  try {
    new RegExp(trimmed);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : "Invalid regular expression";
  }
}

/** Return the custom patterns that fail to compile, with their error. */
export function validateCustomPatterns(
  patterns: string[]
): { pattern: string; error: string }[] {
  const invalid: { pattern: string; error: string }[] = [];
  for (const pattern of patterns) {
    const error = validateCustomPattern(pattern);
    if (error) invalid.push({ pattern, error });
  }
  return invalid;
}

function compileCustomPatterns(patterns: string[]): RegExp[] {
  const compiled: RegExp[] = [];
  for (const raw of patterns) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    try {
      compiled.push(new RegExp(trimmed));
    } catch {
      // Invalid regex — surfaced separately in the settings UI, ignored here.
    }
  }
  return compiled;
}

const DEFAULT_MAX_LENGTH = 100_000;

/**
 * Scan `text` for likely secrets. Returns one entry per distinct finding
 * (de-duplicated by type), each with a masked preview. An empty array means
 * nothing suspicious was found.
 */
export function scanForSecrets(
  text: string,
  options: SecretScanOptions = {}
): SecretMatch[] {
  const {
    entropy = false,
    customPatterns = [],
    maxLength = DEFAULT_MAX_LENGTH,
  } = options;

  if (!text) return [];
  const input = text.length > maxLength ? text.slice(0, maxLength) : text;

  const found = new Map<string, SecretMatch>();

  // Tier 1 — structured provider tokens.
  for (const { type, label, re } of STRUCTURED) {
    if (found.has(type)) continue;
    const match = firstRealMatch(input, re);
    if (match) found.set(type, { type, label, masked: maskSecret(match) });
  }

  // Tier 2 — credential assignments (skip if the value is already a known key).
  const assignment = ASSIGNMENT.exec(input);
  if (assignment) {
    const value = assignment[2];
    const alreadyStructured = STRUCTURED.some((p) => p.re.test(value));
    if (value && !isAllowlisted(value) && !alreadyStructured) {
      found.set("assignment", {
        type: "assignment",
        label: "Credential assignment",
        masked: maskSecret(value),
      });
    }
  }

  // Custom user patterns.
  const customRes = compileCustomPatterns(customPatterns);
  for (let i = 0; i < customRes.length; i += 1) {
    const match = firstRealMatch(input, customRes[i]);
    if (match) {
      const type = `custom:${i}`;
      found.set(type, {
        type,
        label: "Custom pattern",
        masked: maskSecret(match),
      });
    }
  }

  // Tier 3 — high-entropy fallback (opt-in). Report at most one to avoid spam.
  if (entropy) {
    for (const token of input.split(ENTROPY_TOKEN_SPLIT)) {
      if (looksLikeSecretToken(token)) {
        found.set("entropy", {
          type: "entropy",
          label: "High-entropy string",
          masked: maskSecret(token),
        });
        break;
      }
    }
  }

  return [...found.values()];
}
