/**
 * Validate translation values that already exist in locale resources.
 *
 * Key parity is intentionally handled by check-missing-i18n-keys.mjs. This
 * check stays green while the historical parity backlog is reduced, but it
 * prevents present keys from becoming blank, changing leaf type, or dropping
 * interpolation variables that callers provide.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

const LOCALES_ROOT = resolve(import.meta.dirname, "../../src/i18n/locales");
const SOURCE_LOCALE = "en";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
}

function flattenLeaves(value, prefix = "", result = new Map()) {
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === "object" && !Array.isArray(child)) {
      flattenLeaves(child, path, result);
    } else {
      result.set(path, child);
    }
  }
  return result;
}

function leafType(value) {
  return Array.isArray(value) ? "array" : typeof value;
}

function interpolationVariables(value) {
  if (typeof value !== "string") return [];
  return [
    ...new Set(
      [...value.matchAll(/{{\s*([^},\s]+)[^}]*}}/g)].map((match) => match[1])
    ),
  ].sort();
}

const locales = readdirSync(LOCALES_ROOT)
  .filter((locale) => statSync(join(LOCALES_ROOT, locale)).isDirectory())
  .sort();
const namespaceFiles = readdirSync(join(LOCALES_ROOT, SOURCE_LOCALE))
  .filter((fileName) => fileName.endsWith(".json"))
  .sort();

// This checker was introduced on the feature branch. develop added these
// exact blank values while it was under review; keep that debt explicit so
// any new blank translation still fails the contract.
const DEVELOP_BASELINE_INVALID_VALUES = new Set([
  "ja/sessions:creator.planLaunchpadQuestion",
  "ko/sessions:creator.planLaunchpadQuestion",
  "tr/sessions:creator.planLaunchpadQuestion",
]);

const failures = [];
let baselineFailureCount = 0;
let comparedValueCount = 0;

for (const namespaceFile of namespaceFiles) {
  const namespace = namespaceFile.slice(0, -".json".length);
  const sourceLeaves = flattenLeaves(
    readJson(join(LOCALES_ROOT, SOURCE_LOCALE, namespaceFile))
  );

  for (const locale of locales) {
    const localeNamespacePath = join(LOCALES_ROOT, locale, namespaceFile);
    // Namespace parity is intentionally outside this check. Some namespaces
    // are rolled out to locales incrementally, so validate only resources
    // that actually exist instead of turning an absent file into a crash.
    if (!existsSync(localeNamespacePath)) continue;
    const localeLeaves = flattenLeaves(readJson(localeNamespacePath));

    for (const [key, translatedValue] of localeLeaves) {
      if (!sourceLeaves.has(key)) continue;
      comparedValueCount += 1;
      const sourceValue = sourceLeaves.get(key);
      const id = `${locale}/${namespace}:${key}`;

      if (leafType(translatedValue) !== leafType(sourceValue)) {
        failures.push(
          `${id} changes leaf type from ${leafType(sourceValue)} to ${leafType(translatedValue)}`
        );
        continue;
      }

      if (
        typeof sourceValue === "string" &&
        sourceValue.trim().length > 0 &&
        translatedValue.trim().length === 0
      ) {
        if (DEVELOP_BASELINE_INVALID_VALUES.has(id)) {
          baselineFailureCount += 1;
        } else {
          failures.push(`${id} is blank while the English source is non-empty`);
        }
      }

      const sourceVariables = interpolationVariables(sourceValue);
      const translatedVariables = interpolationVariables(translatedValue);
      if (
        sourceVariables.join("\u0000") !== translatedVariables.join("\u0000")
      ) {
        failures.push(
          `${id} interpolation variables differ: ` +
            `source=[${sourceVariables.join(", ")}], ` +
            `translation=[${translatedVariables.join(", ")}]`
        );
      }
    }
  }
}

console.log(
  `Checked ${comparedValueCount} existing translation values across ${locales.length} locales.`
);
if (baselineFailureCount > 0) {
  console.log(
    `Allowed ${baselineFailureCount} invalid value(s) recorded from the develop baseline.`
  );
}

if (failures.length > 0) {
  console.error(`Found ${failures.length} translation quality failure(s):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  "All existing translations preserve value shape and interpolation contracts."
);
