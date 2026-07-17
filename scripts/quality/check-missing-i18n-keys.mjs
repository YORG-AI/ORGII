/**
 * Missing i18n Keys Detector
 *
 * Compares English (source-of-truth) locale keys against all other locales
 * and reports keys that exist in English but are missing in other languages.
 *
 * Usage:
 *   node scripts/quality/check-missing-i18n-keys.mjs [--namespace market] [--prefix cloud] [--fix]
 *
 * Options:
 *   --namespace <ns>  Check only a specific namespace (e.g., "market", "common")
 *   --prefix <path>    Check only a key subtree (e.g., "cloud")
 *   --fix             Copy missing keys from English into other locale files
 *   --verbose         Show all keys, not just missing ones
 */
import { readFileSync, readdirSync, writeFileSync } from "fs";
import { basename, join } from "path";

const LOCALES_DIR = join(import.meta.dirname, "../../src/i18n/locales");

const SOURCE_LANG = "en";

const args = process.argv.slice(2);
const nsFilter = args.includes("--namespace")
  ? args[args.indexOf("--namespace") + 1]
  : null;
const prefixFilter = args.includes("--prefix")
  ? args[args.indexOf("--prefix") + 1]
  : null;
const shouldFix = args.includes("--fix");
const verbose = args.includes("--verbose");

// Locale files may carry a UTF-8 BOM; strip it so JSON.parse doesn't choke.
function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf-8").replace(/^﻿/, ""));
}

function flattenKeys(obj, prefix = "") {
  const keys = [];
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      keys.push(...flattenKeys(value, path));
    } else {
      keys.push(path);
    }
  }
  return keys;
}

function getNestedValue(obj, keyPath) {
  const parts = keyPath.split(".");
  let current = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = current[part];
  }
  return current;
}

function setNestedValue(obj, keyPath, value) {
  const parts = keyPath.split(".");
  let current = obj;
  for (let idx = 0; idx < parts.length - 1; idx++) {
    const part = parts[idx];
    if (!(part in current) || typeof current[part] !== "object") {
      current[part] = {};
    }
    current = current[part];
  }
  current[parts[parts.length - 1]] = value;
}

const languages = readdirSync(LOCALES_DIR).filter(
  (dirName) => dirName !== SOURCE_LANG && !dirName.startsWith(".")
);

const sourceDir = join(LOCALES_DIR, SOURCE_LANG);
const namespaceFiles = readdirSync(sourceDir)
  .filter((fileName) => fileName.endsWith(".json"))
  .map((fileName) => basename(fileName, ".json"));

let totalMissing = 0;
let totalFixed = 0;

for (const ns of namespaceFiles) {
  if (nsFilter && ns !== nsFilter) continue;

  const enPath = join(sourceDir, `${ns}.json`);
  const enData = readJson(enPath);
  const enKeys = flattenKeys(enData).filter(
    (key) =>
      !prefixFilter ||
      key === prefixFilter ||
      key.startsWith(`${prefixFilter}.`)
  );

  let nsMissing = 0;

  for (const lang of languages) {
    const langPath = join(LOCALES_DIR, lang, `${ns}.json`);
    let langData;
    try {
      langData = readJson(langPath);
    } catch {
      console.error(`  ✗ ${lang}/${ns}.json — file missing or invalid`);
      continue;
    }

    const langKeys = new Set(flattenKeys(langData));
    const missing = enKeys.filter((key) => !langKeys.has(key));

    if (missing.length > 0) {
      console.log(`\n  ${lang}/${ns}.json — ${missing.length} missing key(s):`);
      for (const key of missing) {
        const enValue = getNestedValue(enData, key);
        console.log(`    - ${key}: ${JSON.stringify(enValue)}`);

        if (shouldFix) {
          setNestedValue(langData, key, enValue);
          totalFixed++;
        }
      }
      nsMissing += missing.length;

      if (shouldFix && missing.length > 0) {
        writeFileSync(langPath, JSON.stringify(langData, null, 2) + "\n");
        console.log(
          `    → Fixed: wrote ${missing.length} key(s) to ${lang}/${ns}.json`
        );
      }
    } else if (verbose) {
      console.log(`  ✓ ${lang}/${ns}.json — all ${enKeys.length} keys present`);
    }

    const extraKeys = [...langKeys].filter((key) => !enKeys.includes(key));
    if (extraKeys.length > 0 && verbose) {
      console.log(
        `    ⚠ ${lang}/${ns}.json has ${extraKeys.length} extra key(s) not in English`
      );
    }
  }

  totalMissing += nsMissing;

  if (nsMissing === 0 && !verbose) {
    console.log(`✓ ${ns} — all languages complete`);
  } else if (nsMissing > 0) {
    console.log(`\n  ${ns}: ${nsMissing} total missing across all languages`);
  }
}

console.log(`\n${"═".repeat(50)}`);
console.log(`Total missing: ${totalMissing}`);
if (shouldFix) {
  console.log(`Total fixed: ${totalFixed} (copied English value)`);
}
if (totalMissing > 0 && !shouldFix) {
  console.log(`Run with --fix to copy English values into missing slots.`);
  process.exit(1);
}
