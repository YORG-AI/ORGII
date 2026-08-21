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
// The checker was introduced on this feature branch. While it was in review,
// develop accumulated call sites that still rely on defaultValue/fallback
// text. Keep that pre-existing debt scoped to the exact owning files so a new
// missing key anywhere else still fails CI. Entries can be deleted as the
// corresponding English resources are repaired.
const DEVELOP_BASELINE_MISSING_CALLS = new Set([
  "common:actions.clearSearch:src/scaffold/GlobalSpotlight/components/SpotlightSearchBar.tsx",
  "common:actions.clearSearch:src/scaffold/GlobalSpotlight/shared/SpotlightInput.tsx",
  "common:actions.clearSelection:src/modules/WorkStation/shared/StatusBar/BrowserStatusBar.tsx",
  "common:actions.comingSoon:src/router/routes/ComingSoonRoutePage.tsx",
  "common:actions.dismiss:src/engines/BrowserCore/index.tsx",
  "common:actions.moreActions:src/modules/MainApp/WorkManagement/GitHubWorkItemsView.tsx",
  "common:actions.noResults:src/scaffold/WizardSystem/shared/externalImport/InlineExternalImport.tsx",
  "common:actions.saved:src/modules/MainApp/Integrations/RulesMemoryEvolution/Memory/MemoryContentViewer.tsx",
  "common:cancel:src/features/SessionCreator/components/WorktreeSourceModal.tsx",
  "common:close:src/scaffold/GlobalSpotlight/forms/shared/SpotlightModalHeader.tsx",
  "common:common.copied:src/modules/MainApp/AgentOrgs/components/CliRawConfigFileEditor.tsx",
  "common:common.copied:src/modules/MainApp/AgentOrgs/config/shared/PersonalitySection.tsx",
  "common:common.noResultsWithFilters:src/modules/MainApp/Integrations/DevTools/LanguageServersPage/Table/LanguageServersTable.tsx",
  "common:common.noResultsWithFilters:src/modules/MainApp/Integrations/DevTools/LintToolsPage/Table/LintToolsTable.tsx",
  "common:errors.error:src/scaffold/WizardSystem/variants/Mcp/McpAddWizard.tsx",
  "common:errors.messages.forbidden:src/modules/MainApp/WorkManagement/GitHubWorkItemsSurface.tsx",
  "common:errors.messages.forbidden:src/modules/MainApp/WorkManagement/GitHubWorkItemsView.tsx",
  "common:errors.messages.forbidden:src/modules/ProjectManager/ProjectManagerLayout/components/ProjectWorkItemsTabContent.tsx",
  "common:errors.noLocalPath:src/modules/shared/launchpad/components/RepoActionButtons.tsx",
  "common:labels.filter:src/components/SettingsTable/index.tsx",
  "common:labels.filter:src/modules/shared/layouts/blocks/SearchSortBar.tsx",
  "common:labels.selectDate:src/components/DatePicker/index.tsx",
  "common:placeholders.noData:src/modules/WorkStation/CodeEditor/Panels/EditorMainPane/content/FilePreviewContent/DbPreviewView/index.tsx",
  "common:pullRequests.status.draft:src/modules/MainApp/WorkManagement/GitHubWorkItemsView.tsx",
  "common:pullRequests.status.merged:src/modules/MainApp/WorkManagement/GitHubWorkItemsView.tsx",
  "common:selectors.branch.labels.mainWorktree:src/modules/WorkStation/shared/StatusBar/EditorStatusBar.tsx",
  "common:selectors.branch.labels.mainWorktree:src/scaffold/GlobalSpotlight/palettes/BranchPalette/index.tsx",
  "common:tabs.files:src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/tabs/SearchTab.tsx",
  "common:tabs.files:src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/tabs/TestingTab.tsx",
  "common:tabs.history:src/modules/WorkStation/Browser/Panels/BrowserPrimarySidebar/index.tsx",
  "common:teamInbox.actions.openPullRequest:src/modules/MainApp/TeamInbox/TeamInboxView.tsx",
  "integrations:channels.quickActions.testConnection:src/modules/MainApp/Integrations/Connections/Channels/ChannelPreviewPanel.tsx",
  "integrations:common.cancel:src/modules/WorkStation/TabContent/renderers/agentConfig.tsx",
  "integrations:common.delete:src/modules/WorkStation/TabContent/renderers/agentConfig.tsx",
  "integrations:keyVault.revalidate:src/scaffold/WizardSystem/variants/KeyVault/components/DeploymentModelInput.tsx",
  "projects:linearProjects.loading:src/modules/ProjectManager/LinearProjects/index.tsx",
  "projects:workItems.untitled:src/modules/MainApp/WorkManagement/WorkManagementProjectsSurface.tsx",
  "projects:workItems.untitled:src/modules/ProjectManager/WorkItems/index.tsx",
  "sessions:failedToCopyContent:src/components/MarkDown/LinkHoverCard.tsx",
  "sessions:titleBar.hideDevTools:src/modules/WorkStation/Browser/Panels/BrowserMainPane/components/WebUrlBar/index.tsx",
  "sessions:titleBar.showBottomPanel:src/modules/WorkStation/shared/TabBarTrailingControls.tsx",
  "sessions:titleBar.showDevTools:src/modules/WorkStation/Browser/Panels/BrowserMainPane/components/WebUrlBar/index.tsx",
  "sessions:titleBar.showDevTools:src/modules/WorkStation/Browser/Panels/BrowserSecondaryPanel/components/WebInspector/index.tsx",
  "sessions:titleBar.showDevTools:src/modules/WorkStation/shared/TabBarTrailingControls.tsx",
  "sessions:tooltips.hidePanel:src/features/SessionCreator/variants/Kanban/index.tsx",
  "sessions:workStation.chat.messages.bubble.senderTitle.thought:src/modules/WorkStation/AppShell/AgentStationTopHeader.tsx",
  "translation:creator.worktreeSource.baseBranch:src/features/SessionCreator/components/WorktreeBranchTab.tsx",
  "translation:creator.worktreeSource.branchEmpty:src/features/SessionCreator/components/WorktreeBranchTab.tsx",
  "translation:creator.worktreeSource.branchError:src/features/SessionCreator/components/WorktreeBranchTab.tsx",
  "translation:creator.worktreeSource.branchNoMatches:src/features/SessionCreator/components/WorktreeBranchTab.tsx",
  "translation:creator.worktreeSource.branchSearch:src/features/SessionCreator/components/WorktreeBranchTab.tsx",
  "translation:creator.worktreeSource.branchSearchAria:src/features/SessionCreator/components/WorktreeBranchTab.tsx",
  "translation:creator.worktreeSource.refreshBranches:src/features/SessionCreator/components/WorktreeBranchTab.tsx",
]);
const missing = [];
const baselineMissing = [];
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
            const entry = {
              filePath,
              line,
              namespace,
              key,
              call: node.getText(sourceFile).replace(/\s+/g, " "),
            };
            const signature = `${namespace}:${key}:${relative(
              REPO_ROOT,
              filePath
            )}`;
            if (DEVELOP_BASELINE_MISSING_CALLS.has(signature)) {
              baselineMissing.push(entry);
            } else {
              missing.push(entry);
            }
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
if (baselineMissing.length > 0) {
  console.log(
    `Allowed ${baselineMissing.length} missing call(s) recorded from the develop baseline.`
  );
}

if (uniqueMissing.size > 0) {
  console.error(
    `Found ${uniqueMissing.size} English source key(s) missing across ${missing.length} call site(s):`
  );
  for (const [id, entry] of [...uniqueMissing].sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    console.error(`- ${id} (${entry.occurrences})`);
    console.error(`    call: ${entry.call}`);
    for (const location of entry.locations) console.error(`    ${location}`);
  }
  process.exit(1);
}

console.log(
  "All statically analyzable i18n calls resolve to English source keys."
);
