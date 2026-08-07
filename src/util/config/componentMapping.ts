/**
 * Utility to infer React component names and source files from DOM elements.
 * Uses smart pattern matching, class name inference, and DOM attributes
 * to suggest possible component names and their source file locations.
 */

// Component type suffixes that indicate a component
const COMPONENT_SUFFIXES = [
  "Page",
  "Panel",
  "Modal",
  "Card",
  "Button",
  "Input",
  "Form",
  "List",
  "Item",
  "Header",
  "Footer",
  "Sidebar",
  "Nav",
  "Menu",
  "Tab",
  "Table",
  "Row",
  "Cell",
  "Grid",
  "Container",
  "Wrapper",
  "Section",
  "View",
  "Layout",
  "Content",
  "Area",
  "Box",
  "Dropdown",
  "Select",
  "Checkbox",
  "Radio",
  "Switch",
  "Toggle",
  "Slider",
  "Progress",
  "Loading",
  "Badge",
  "Tag",
  "Chip",
  "Avatar",
  "Icon",
  "Image",
  "Text",
  "Label",
  "Title",
  "Heading",
  "Link",
  "Breadcrumb",
  "Tooltip",
  "Dialog",
  "Alert",
  "Toast",
  "Notification",
  "Banner",
  "Step",
  "Wizard",
  "Accordion",
  "Collapse",
  "Divider",
  "Separator",
  "Empty",
  "Placeholder",
  "Skeleton",
  "Tree",
  "Editor",
  "Preview",
  "Viewer",
  "Player",
  "Chart",
  "Graph",
  "Map",
  "Timeline",
  "Calendar",
  "Picker",
  "Upload",
  "Download",
  "Filter",
  "Search",
  "Sort",
];

// Convert kebab-case or snake_case to PascalCase
const toPascalCase = (str: string): string => {
  return str
    .split(/[-_]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join("");
};

// Extract potential component name from a class name
const extractComponentFromClass = (
  className: string
): { name: string; confidence: "high" | "medium" | "low" } | null => {
  // Skip utility classes (Tailwind patterns)
  if (
    /^(flex|grid|block|inline|hidden|absolute|relative|fixed|sticky|overflow|w-|h-|m-|p-|gap-|text-|bg-|border-|rounded-|shadow-|z-|opacity-|cursor-|pointer-|font-|items-|justify-|self-|col-|row-|min-|max-|top-|right-|bottom-|left-|inset-|translate-|scale-|rotate-|skew-|origin-|transition-|duration-|ease-|delay-|animate-)/i.test(
      className
    )
  ) {
    return null;
  }

  // Skip short utility-like classes
  if (className.length < 4) return null;

  // High confidence: class name contains a known component suffix
  const pascalName = toPascalCase(className);
  for (const suffix of COMPONENT_SUFFIXES) {
    if (
      pascalName.includes(suffix) ||
      className.toLowerCase().includes(suffix.toLowerCase())
    ) {
      return { name: pascalName, confidence: "high" };
    }
  }

  // Medium confidence: kebab-case class that looks like a component name (2+ words)
  if (/^[a-z]+-[a-z]+(-[a-z]+)*$/i.test(className) && className.length >= 8) {
    return { name: pascalName, confidence: "medium" };
  }

  return null;
};

// URL path to component/page mapping
// Note: This is used for component inspection/debugging, so hardcoded paths are acceptable here
const URL_PAGE_MAP: Record<string, { name: string; filePath: string }> = {
  "/orgii/app/settings": {
    name: "Settings",
    filePath: "src/modules/MainApp/Settings/index.tsx",
  },
  "/orgii/app/start-page": {
    name: "SuggestionsPage",
    filePath: "src/page/Orgii/StartPage/index.tsx",
  },

  "/orgii/workstation/code": {
    name: "CodeEditor",
    filePath: "src/modules/WorkStation/CodeEditor/index.tsx",
  },
  "/orgii/workstation/browser": {
    name: "Browser",
    filePath: "src/modules/WorkStation/Browser/index.tsx",
  },
  "/orgii/app/git/status": {
    name: "GitDiff",
    filePath: "src/page/Orgii/GitDiff/index.tsx",
  },
  "/orgii/app/usage/consumer/wallet": {
    name: "Wallet",
    filePath: "src/page/Orgii/Usage/Consumer/Wallet/index.tsx",
  },
  "/orgii/app/usage/consumer/code-accounts": {
    name: "KeyVault",
    filePath: "src/page/Orgii/Usage/Consumer/KeyVault/index.tsx",
  },
};

export interface ComponentSuggestion {
  name: string;
  confidence: "high" | "medium" | "low";
  filePath: string;
  matchReason: string;
}

/**
 * Infer file path from component name based on common patterns
 */
const inferFilePath = (componentName: string, url: string): string => {
  const pathname = new URL(url).pathname;

  // Check if we can infer from URL
  for (const [urlPattern, page] of Object.entries(URL_PAGE_MAP)) {
    if (pathname.includes(urlPattern)) {
      // Likely in this page's directory
      const baseDir = page.filePath.replace("/index.tsx", "");
      return `${baseDir}/components/${componentName}.tsx`;
    }
  }

  // Generic inference
  if (componentName.endsWith("Modal")) {
    return `src/features/ModalSystem/variants/${componentName}/index.tsx`;
  }
  if (componentName.endsWith("Panel")) {
    return `src/features/*/${componentName}/index.tsx or src/components/${componentName}/index.tsx`;
  }
  if (componentName.endsWith("Page")) {
    return `src/page/Orgii/**/${componentName}/index.tsx`;
  }

  return `Search for: ${componentName}`;
};

/**
 * Infer component suggestions from an element's attributes and hierarchy
 */
export const inferComponentSuggestions = (
  element: Element,
  url: string
): ComponentSuggestion[] => {
  const suggestions: ComponentSuggestion[] = [];
  const classArray = Array.from(element.classList);
  const id = element.id;
  const tagName = element.tagName.toLowerCase();

  // 1. HIGHEST CONFIDENCE: data-component attribute
  const dataComponent = element.getAttribute("data-component");
  if (dataComponent) {
    suggestions.push({
      name: dataComponent,
      confidence: "high",
      filePath: inferFilePath(dataComponent, url),
      matchReason: "data-component attribute",
    });
  }

  // 2. HIGH CONFIDENCE: data-testid attribute (often contains component/feature names)
  const testId = element.getAttribute("data-testid");
  if (testId) {
    const componentName = toPascalCase(testId);
    suggestions.push({
      name: componentName,
      confidence: "high",
      filePath: inferFilePath(componentName, url),
      matchReason: `data-testid="${testId}"`,
    });
  }

  // 3. HIGH CONFIDENCE: aria-label that looks like a component
  const ariaLabel = element.getAttribute("aria-label");
  if (ariaLabel && /^[A-Z][a-zA-Z]+$/.test(ariaLabel)) {
    suggestions.push({
      name: ariaLabel,
      confidence: "high",
      filePath: inferFilePath(ariaLabel, url),
      matchReason: `aria-label="${ariaLabel}"`,
    });
  }

  // 4. HIGH/MEDIUM CONFIDENCE: Class names that look like component names
  for (const className of classArray) {
    const extracted = extractComponentFromClass(className);
    if (extracted) {
      suggestions.push({
        name: extracted.name,
        confidence: extracted.confidence,
        filePath: inferFilePath(extracted.name, url),
        matchReason: `class="${className}"`,
      });
    }
  }

  // 5. MEDIUM CONFIDENCE: ID that looks like a component
  if (id) {
    const idComponent = extractComponentFromClass(id);
    if (idComponent) {
      suggestions.push({
        name: idComponent.name,
        confidence: "medium",
        filePath: inferFilePath(idComponent.name, url),
        matchReason: `id="${id}"`,
      });
    }
  }

  // 6. MEDIUM CONFIDENCE: Current page context
  const pathname = new URL(url).pathname;
  for (const [urlPattern, page] of Object.entries(URL_PAGE_MAP)) {
    if (pathname.includes(urlPattern)) {
      suggestions.push({
        name: `${page.name} (Page)`,
        confidence: "medium",
        filePath: page.filePath,
        matchReason: `Current page: ${urlPattern}`,
      });
      break;
    }
  }

  // 7. Walk up parent hierarchy to find component context
  let parent: Element | null = element.parentElement;
  let depth = 0;
  const foundParentComponents = new Set<string>();

  while (parent && depth < 8) {
    // Check data-component on parents
    const parentDataComponent = parent.getAttribute("data-component");
    if (
      parentDataComponent &&
      !foundParentComponents.has(parentDataComponent)
    ) {
      foundParentComponents.add(parentDataComponent);
      suggestions.push({
        name: `${parentDataComponent} (parent)`,
        confidence: depth < 3 ? "high" : "medium",
        filePath: inferFilePath(parentDataComponent, url),
        matchReason: `Parent data-component (${depth + 1} levels up)`,
      });
    }

    // Check parent classes for component patterns
    for (const className of Array.from(parent.classList)) {
      const extracted = extractComponentFromClass(className);
      if (extracted && !foundParentComponents.has(extracted.name)) {
        foundParentComponents.add(extracted.name);
        suggestions.push({
          name: `${extracted.name} (parent)`,
          confidence: depth < 2 ? "medium" : "low",
          filePath: inferFilePath(extracted.name, url),
          matchReason: `Parent class "${className}" (${depth + 1} levels up)`,
        });
      }
    }

    parent = parent.parentElement;
    depth++;

    // Stop at body
    if (parent === document.body) break;
  }

  // 8. LOW CONFIDENCE: Semantic HTML inference
  if (tagName === "button") {
    suggestions.push({
      name: "Button",
      confidence: "low",
      filePath: "src/components/Button/index.tsx",
      matchReason: "HTML <button> element",
    });
  } else if (tagName === "input") {
    const inputType = element.getAttribute("type") || "text";
    const inputComponent =
      inputType === "checkbox"
        ? "Checkbox"
        : inputType === "radio"
          ? "Radio"
          : "Input";
    suggestions.push({
      name: inputComponent,
      confidence: "low",
      filePath: `src/components/${inputComponent}/index.tsx`,
      matchReason: `HTML <input type="${inputType}">`,
    });
  } else if (tagName === "a") {
    suggestions.push({
      name: "Link",
      confidence: "low",
      filePath: "src/components/Link/index.tsx or native <a>",
      matchReason: "HTML <a> element",
    });
  } else if (
    tagName === "table" ||
    tagName === "thead" ||
    tagName === "tbody"
  ) {
    suggestions.push({
      name: "Table",
      confidence: "low",
      filePath: "src/components/Table/index.tsx",
      matchReason: `HTML <${tagName}> element`,
    });
  } else if (tagName === "select") {
    suggestions.push({
      name: "Select",
      confidence: "low",
      filePath: "src/components/Select/index.tsx",
      matchReason: "HTML <select> element",
    });
  } else if (tagName === "textarea") {
    suggestions.push({
      name: "Textarea",
      confidence: "low",
      filePath: "src/components/Textarea/index.tsx",
      matchReason: "HTML <textarea> element",
    });
  }

  // 9. LOW CONFIDENCE: Role-based inference
  const role = element.getAttribute("role");
  if (role) {
    const roleComponentMap: Record<string, string> = {
      dialog: "Modal",
      alert: "Alert",
      alertdialog: "AlertDialog",
      menu: "Menu",
      menuitem: "MenuItem",
      tab: "Tab",
      tabpanel: "TabPanel",
      tablist: "Tabs",
      tooltip: "Tooltip",
      listbox: "Select",
      option: "Option",
      checkbox: "Checkbox",
      radio: "Radio",
      switch: "Switch",
      progressbar: "Progress",
      slider: "Slider",
      tree: "Tree",
      treeitem: "TreeItem",
      grid: "Grid",
      row: "Row",
      cell: "Cell",
      navigation: "Navigation",
      banner: "Banner",
      main: "Main",
      complementary: "Sidebar",
      form: "Form",
      search: "SearchInput",
    };

    const roleComponent = roleComponentMap[role];
    if (roleComponent) {
      suggestions.push({
        name: roleComponent,
        confidence: "low",
        filePath: inferFilePath(roleComponent, url),
        matchReason: `role="${role}"`,
      });
    }
  }

  // Deduplicate by normalized component name
  const seen = new Set<string>();
  const dedupedSuggestions = suggestions.filter((suggestion) => {
    // Normalize: remove " (parent)" and " (Page)" for deduplication
    const normalizedName = suggestion.name
      .replace(/ \(parent\)$/, "")
      .replace(/ \(Page\)$/, "");
    const key = normalizedName.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Sort by confidence (high → medium → low)
  const confidenceOrder = { high: 0, medium: 1, low: 2 };
  dedupedSuggestions.sort(
    (a, b) => confidenceOrder[a.confidence] - confidenceOrder[b.confidence]
  );

  // Return top 10 suggestions
  return dedupedSuggestions.slice(0, 10);
};

/**
 * Get a simple display label for confidence
 */
export const getConfidenceLabel = (
  confidence: "high" | "medium" | "low"
): string => {
  switch (confidence) {
    case "high":
      return "🟢";
    case "medium":
      return "🟡";
    case "low":
      return "🔴";
  }
};
