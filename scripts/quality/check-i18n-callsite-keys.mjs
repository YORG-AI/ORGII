/**
 * Verify that statically analyzable i18next call sites resolve to an English
 * source key. Locale fallback can only work when the source language owns the
 * key, so a missing English key is always a defect even when a defaultValue is
 * supplied at the call site.
 *
 * Supported call shapes:
 *   const { t } = useTranslation("sessions");
 *   const { t: tCommon } = useTranslation(["common", "sessions"]);
 *   const { t } = useTranslation("sessions", { keyPrefix: "chat" });
 *   t("common:actions.save");
 *   t("actions.save", { ns: "common" });
 *   i18n.t("common:actions.save");
 *
 * Dynamic keys are reported for visibility but are not rejected here. Their
 * finite domains need focused contract tests at the owning registry/config.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import process from "node:process";
import ts from "typescript";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const SOURCE_ROOT = join(REPO_ROOT, "src");
const ENGLISH_LOCALE_ROOT = join(SOURCE_ROOT, "i18n/locales/en");

const EXCLUDED_DIRECTORIES = new Set([
  "__tests__",
  "fixtures",
  "generated",
  "mocks",
  "node_modules",
]);
const EXCLUDED_FILE_PATTERN = /\.(?:spec|test|stories)\.[cm]?[jt]sx?$/;

function flattenLeafKeys(value, prefix = "", result = new Set()) {
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === "object" && !Array.isArray(child)) {
      flattenLeafKeys(child, path, result);
    } else {
      result.add(path);
    }
  }
  return result;
}

function loadEnglishKeys() {
  const keysByNamespace = new Map();
  for (const fileName of readdirSync(ENGLISH_LOCALE_ROOT)) {
    if (!fileName.endsWith(".json")) continue;
    const namespace = fileName.slice(0, -".json".length);
    const contents = readFileSync(join(ENGLISH_LOCALE_ROOT, fileName), "utf8");
    const resource = JSON.parse(contents.replace(/^\uFEFF/, ""));
    keysByNamespace.set(namespace, flattenLeafKeys(resource));
  }
  return keysByNamespace;
}

function collectSourceFiles(directory, result = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRECTORIES.has(entry.name))
        collectSourceFiles(path, result);
      continue;
    }
    if (!entry.isFile() || !/\.[cm]?[jt]sx?$/.test(entry.name)) continue;
    if (EXCLUDED_FILE_PATTERN.test(entry.name)) continue;
    result.push(path);
  }
  return result;
}

function staticString(node) {
  return node &&
    (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : undefined;
}

function propertyInitializer(node, propertyName) {
  if (!node || !ts.isObjectLiteralExpression(node)) return undefined;
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name =
      ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)
        ? property.name.text
        : undefined;
    if (name === propertyName) return property.initializer;
  }
  return undefined;
}

function hasProperty(node, propertyName) {
  if (!node || !ts.isObjectLiteralExpression(node)) return false;
  return node.properties.some((property) => {
    if (
      !ts.isPropertyAssignment(property) &&
      !ts.isShorthandPropertyAssignment(property)
    ) {
      return false;
    }
    return (
      (ts.isIdentifier(property.name) ||
        ts.isStringLiteralLike(property.name)) &&
      property.name.text === propertyName
    );
  });
}

function namespacesFromHookArgument(node) {
  const single = staticString(node);
  if (single) return [single];
  if (!node || !ts.isArrayLiteralExpression(node)) return [];
  return node.elements.map(staticString).filter(Boolean);
}

function callOptions(call) {
  return [call.arguments[1], call.arguments[2]]
    .filter(Boolean)
    .find(ts.isObjectLiteralExpression);
}

function hasPluralVariant(keys, key) {
  return ["zero", "one", "two", "few", "many", "other"].some((suffix) =>
    keys.has(`${key}_${suffix}`)
  );
}

const englishKeys = loadEnglishKeys();
const missing = [];
const dynamic = [];
let staticCallCount = 0;

for (const filePath of collectSourceFiles(SOURCE_ROOT)) {
  const contents = readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(
    filePath,
    contents,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const translators = new Map();

  function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === "useTranslation" &&
      ts.isObjectBindingPattern(node.name)
    ) {
      const namespaces = namespacesFromHookArgument(
        node.initializer.arguments[0]
      );
      const hookOptions = node.initializer.arguments[1];
      const keyPrefix = staticString(
        propertyInitializer(hookOptions, "keyPrefix")
      );
      for (const element of node.name.elements) {
        const propertyName =
          element.propertyName &&
          (ts.isIdentifier(element.propertyName) ||
            ts.isStringLiteralLike(element.propertyName))
            ? element.propertyName.text
            : ts.isIdentifier(element.name)
              ? element.name.text
              : undefined;
        if (propertyName === "t" && ts.isIdentifier(element.name)) {
          translators.set(element.name.text, {
            namespaces:
              namespaces.length > 0
                ? namespaces
                : node.initializer.arguments.length === 0
                  ? ["common"]
                  : [],
            keyPrefix,
          });
        }
      }
    }

    if (ts.isCallExpression(node) && node.arguments[0]) {
      let translator;
      if (ts.isIdentifier(node.expression)) {
        translator = translators.get(node.expression.text);
      } else if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "t" &&
        ts.isIdentifier(node.expression.expression) &&
        ["i18n", "i18next"].includes(node.expression.expression.text)
      ) {
        translator = { namespaces: ["common"], keyPrefix: undefined };
      }

      if (translator) {
        const line =
          sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
            .line + 1;
        const rawKey = staticString(node.arguments[0]);
        if (!rawKey) {
          dynamic.push({ filePath, line, call: node.getText(sourceFile) });
        } else {
          staticCallCount += 1;
          const options = callOptions(node);
          const optionNamespace = staticString(
            propertyInitializer(options, "ns")
          );
          let namespace = optionNamespace ?? translator.namespaces[0];
          let key = rawKey;
          let keyPrefix = optionNamespace ? undefined : translator.keyPrefix;

          const namespaceSeparator = key.indexOf(":");
          if (namespaceSeparator >= 0) {
            namespace = key.slice(0, namespaceSeparator);
            key = key.slice(namespaceSeparator + 1);
            keyPrefix = undefined;
          }
          if (keyPrefix) key = `${keyPrefix}.${key}`;

          if (!namespace) {
            dynamic.push({ filePath, line, call: node.getText(sourceFile) });
            ts.forEachChild(node, visit);
            return;
          }

          const keys = englishKeys.get(namespace);
          const hasCount = hasProperty(options, "count");
          const exists =
            keys?.has(key) || (hasCount && keys && hasPluralVariant(keys, key));
          if (!exists) {
            missing.push({
              filePath,
              line,
              namespace,
              key,
              call: node.getText(sourceFile).replace(/\s+/g, " "),
            });
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

const uniqueMissing = new Map();
for (const entry of missing) {
  const id = `${entry.namespace}:${entry.key}`;
  const current = uniqueMissing.get(id);
  if (current) {
    current.occurrences += 1;
    current.locations.push(
      `${relative(REPO_ROOT, entry.filePath)}:${entry.line}`
    );
  } else {
    uniqueMissing.set(id, {
      ...entry,
      occurrences: 1,
      locations: [`${relative(REPO_ROOT, entry.filePath)}:${entry.line}`],
    });
  }
}

console.log(
  `Checked ${staticCallCount} static i18n calls; ` +
    `${dynamic.length} dynamic calls require focused contracts.`
);

if (uniqueMissing.size > 0) {
  console.error(
    `Found ${uniqueMissing.size} English source key(s) missing across ${missing.length} call site(s):`
  );
  for (const [id, entry] of [...uniqueMissing].sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    console.error(`- ${id} (${entry.occurrences})`);
    for (const location of entry.locations) console.error(`    ${location}`);
  }
  process.exit(1);
}

console.log(
  "All statically analyzable i18n calls resolve to English source keys."
);
