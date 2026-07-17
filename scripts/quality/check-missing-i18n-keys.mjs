/**
 * Missing i18n Keys Detector
 *
 * Compares English (source-of-truth) locale keys against all other locales
 * and reports missing keys plus interpolation-placeholder mismatches.
 *
 * Usage:
 *   node scripts/quality/check-missing-i18n-keys.mjs [--namespace market] [--fix]
 *
 * Options:
 *   --namespace <ns>  Check only a specific namespace (e.g., "market", "common")
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
const shouldFix = args.includes("--fix");
const verbose = args.includes("--verbose");

function findDuplicateJsonKeys(text) {
  const duplicates = [];
  let index = text.charCodeAt(0) === 0xfeff ? 1 : 0;

  const skipWhitespace = () => {
    while (/\s/.test(text[index] ?? "")) index++;
  };

  const parseString = () => {
    const start = index++;
    while (index < text.length) {
      if (text[index] === "\\") {
        index += 2;
      } else if (text[index++] === '"') {
        return JSON.parse(text.slice(start, index));
      }
    }
    throw new Error("Unterminated JSON string");
  };

  const parseValue = (path) => {
    skipWhitespace();
    if (text[index] === "{") return parseObject(path);
    if (text[index] === "[") return parseArray(path);
    if (text[index] === '"') return void parseString();
    while (index < text.length && !/[\]},]/.test(text[index])) index++;
  };

  const parseObject = (path) => {
    index++;
    skipWhitespace();
    const seen = new Set();
    while (index < text.length && text[index] !== "}") {
      const key = parseString();
      const keyPath = path ? `${path}.${key}` : key;
      if (seen.has(key)) duplicates.push(keyPath);
      seen.add(key);
      skipWhitespace();
      if (text[index++] !== ":") throw new Error(`Expected ':' at ${keyPath}`);
      parseValue(keyPath);
      skipWhitespace();
      if (text[index] === ",") {
        index++;
        skipWhitespace();
      } else if (text[index] !== "}") {
        throw new Error(`Expected ',' or '}' at ${keyPath}`);
      }
    }
    index++;
  };

  const parseArray = (path) => {
    index++;
    skipWhitespace();
    let itemIndex = 0;
    while (index < text.length && text[index] !== "]") {
      parseValue(`${path}[${itemIndex++}]`);
      skipWhitespace();
      if (text[index] === ",") {
        index++;
        skipWhitespace();
      } else if (text[index] !== "]") {
        throw new Error(`Expected ',' or ']' at ${path}`);
      }
    }
    index++;
  };

  parseValue("");
  return duplicates;
}

// Locale files may carry a UTF-8 BOM; strip it so JSON.parse doesn't choke.
function readJson(filePath) {
  const text = readFileSync(filePath, "utf-8");
  return {
    data: JSON.parse(text.replace(/^﻿/, "")),
    duplicateKeys: findDuplicateJsonKeys(text),
  };
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

function getPlaceholders(value) {
  if (typeof value !== "string") return [];
  return [
    ...new Set(
      [...value.matchAll(/\{\{\s*([^},\s]+)[^}]*\}\}/g)].map(
        (match) => match[1]
      )
    ),
  ].sort();
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
let totalPlaceholderMismatches = 0;
let totalDuplicateKeys = 0;
let totalInvalidFiles = 0;
let totalFixed = 0;

for (const ns of namespaceFiles) {
  if (nsFilter && ns !== nsFilter) continue;

  const enPath = join(sourceDir, `${ns}.json`);
  const { data: enData, duplicateKeys: enDuplicateKeys } = readJson(enPath);
  if (enDuplicateKeys.length > 0) {
    console.log(
      `\n  en/${ns}.json — ${enDuplicateKeys.length} duplicate key(s):`
    );
    for (const key of enDuplicateKeys) console.log(`    - ${key}`);
    totalDuplicateKeys += enDuplicateKeys.length;
  }
  const enKeys = flattenKeys(enData);

  let nsMissing = 0;

  for (const lang of languages) {
    const langPath = join(LOCALES_DIR, lang, `${ns}.json`);
    let langData;
    let duplicateKeys;
    try {
      ({ data: langData, duplicateKeys } = readJson(langPath));
    } catch {
      console.error(`  ✗ ${lang}/${ns}.json — file missing or invalid`);
      totalInvalidFiles++;
      continue;
    }

    if (duplicateKeys.length > 0) {
      console.log(
        `\n  ${lang}/${ns}.json — ${duplicateKeys.length} duplicate key(s):`
      );
      for (const key of duplicateKeys) console.log(`    - ${key}`);
      totalDuplicateKeys += duplicateKeys.length;
    }

    const langKeys = new Set(flattenKeys(langData));
    const missing = enKeys.filter((key) => !langKeys.has(key));
    const placeholderMismatches = enKeys
      .filter((key) => langKeys.has(key))
      .map((key) => {
        const expected = getPlaceholders(getNestedValue(enData, key));
        const actual = getPlaceholders(getNestedValue(langData, key));
        return { key, expected, actual };
      })
      .filter(
        ({ expected, actual }) => expected.join("|") !== actual.join("|")
      );

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

    if (placeholderMismatches.length > 0) {
      console.log(
        `\n  ${lang}/${ns}.json — ${placeholderMismatches.length} placeholder mismatch(es):`
      );
      for (const { key, expected, actual } of placeholderMismatches) {
        console.log(
          `    - ${key}: expected [${expected.join(", ")}], found [${actual.join(", ")}]`
        );
      }
      totalPlaceholderMismatches += placeholderMismatches.length;
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
console.log(`Placeholder mismatches: ${totalPlaceholderMismatches}`);
console.log(`Duplicate keys: ${totalDuplicateKeys}`);
console.log(`Invalid files: ${totalInvalidFiles}`);
if (shouldFix) {
  console.log(`Total fixed: ${totalFixed} (copied English value)`);
}
if (totalMissing > 0 && !shouldFix) {
  console.log(`Run with --fix to copy English values into missing slots.`);
}
if (
  totalMissing > 0 ||
  totalPlaceholderMismatches > 0 ||
  totalDuplicateKeys > 0 ||
  totalInvalidFiles > 0
) {
  process.exit(1);
}
