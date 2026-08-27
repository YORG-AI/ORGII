/**
 * ESLint Configuration
 *
 * ESLint is a static code analysis tool that identifies and reports on patterns
 * in JavaScript/TypeScript code, helping maintain code quality and consistency.
 *
 * Usage:
 * - Runs automatically via IDE integration (VS Code, Cursor, etc.)
 * - Integrated with Prettier for code formatting
 * - Used with lint-staged for pre-commit hooks (see .husky/pre-commit)
 * - Only lints files in src/ directory (see ignorePatterns)
 *
 * Configuration Layers (extends, in order):
 * 1. eslint:recommended - ESLint's recommended rules for JavaScript
 * 2. plugin:@typescript-eslint/recommended - TypeScript-specific linting rules
 * 3. plugin:react/recommended - React-specific linting rules
 * 4. plugin:react-hooks/recommended - React Hooks linting rules (exhaustive-deps, etc.)
 * 5. plugin:prettier/recommended - Integrates Prettier with ESLint
 *    - Disables ESLint formatting rules that conflict with Prettier
 *    - Shows Prettier formatting issues as ESLint errors
 *
 * Parser:
 * - @typescript-eslint/parser: Parses TypeScript and TSX files
 *   Allows ESLint to understand TypeScript syntax and type information
 *
 * Parser Options:
 * - ecmaVersion: 2020 - Supports ES2020 features (optional chaining, nullish coalescing, etc.)
 * - sourceType: "module" - Code uses ES6 modules (import/export)
 * - ecmaFeatures.jsx: true - Enable JSX parsing
 *
 * Ignore Patterns:
 * - "/*" - Ignore everything in root directory
 * - "!/src" - BUT include src/ directory (exception to the ignore rule)
 * - "*.css" - Ignore all CSS files (handled by stylelint if configured)
 *
 * Related Files:
 * - .prettierrc - Prettier formatting configuration
 * - .husky/pre-commit - Git hook that runs lint-staged
 * - package.json lint-staged - Runs Prettier on staged files before commit
 */

module.exports = {
  // Mark this as the root config (don't look for parent configs)
  root: true,

  // TypeScript parser for understanding TS/TSX syntax
  parser: "@typescript-eslint/parser",

  // Extend multiple rule sets (later configs override earlier ones)
  extends: [
    "eslint:recommended", // Base JavaScript rules
    "plugin:@typescript-eslint/recommended", // TypeScript-specific rules
    "plugin:react/recommended", // React-specific rules
    "plugin:react-hooks/recommended", // React Hooks rules (exhaustive-deps, etc.)
    "plugin:prettier/recommended", // Prettier integration (must be last)
  ],

  // Plugins used by the extended configs
  plugins: [
    "@typescript-eslint",
    "react",
    "react-hooks",
    "prettier",
    "unused-imports",
  ],

  // Parser configuration
  parserOptions: {
    ecmaVersion: 2020, // Support ES2020 features
    sourceType: "module", // Use ES6 modules
    ecmaFeatures: {
      jsx: true, // Enable JSX parsing
    },
  },

  // React settings
  settings: {
    react: {
      version: "detect", // Automatically detect React version
    },
  },

  // Files/directories to ignore during linting
  ignorePatterns: [
    "/*", // Ignore root directory
    "!/src", // Except src/ directory
    "*.css", // Ignore CSS files
    "*.scss", // Ignore SCSS files (@tailwind directives cause false-positive parse errors)
  ],

  // Custom rules
  rules: {
    // React rules - disable some that conflict with TypeScript
    "react/react-in-jsx-scope": "off", // Not needed with new JSX transform
    "react/prop-types": "off", // TypeScript handles prop validation

    // Unused imports - auto-fixable
    "@typescript-eslint/no-unused-vars": "off", // Disable the base rule (not auto-fixable)
    "unused-imports/no-unused-imports": "error", // Auto-fixable: removes unused imports
    "unused-imports/no-unused-vars": [
      "warn",
      {
        vars: "all",
        varsIgnorePattern: "^_",
        args: "after-used",
        argsIgnorePattern: "^_",
      },
    ],

    // Discourage direct console usage — migrate to @src/hooks/logger
    "no-console": ["warn", { allow: ["warn", "error"] }],

    "no-restricted-syntax": [
      "error",
      {
        selector:
          "ImportDeclaration[source.value='lucide-react'] ImportNamespaceSpecifier",
        message:
          "Do not namespace-import lucide-react; use named imports or a finite typed icon registry so icons remain tree-shakeable.",
      },
    ],

    // Tripwire for dissolved global hook groups. src/hooks/ is for genuinely
    // cross-cutting hooks; module-owned hooks live next to their consumers.
    // Kept so in-flight branches get a pointer to the new homes on rebase.
    "no-restricted-imports": [
      "error",
      {
        patterns: [
          {
            group: ["@src/hooks/workStation", "@src/hooks/workStation/*"],
            message:
              "hooks/workStation was dissolved. Tab-host hooks: @src/hooks/tabHost/*; editor hooks: @src/modules/WorkStation/CodeEditor/hooks/*; browser hooks: @src/modules/WorkStation/Browser/hooks/*; session capture: @src/features/SessionSetup/hooks/*; context menu: @src/scaffold/ContextMenu/*.",
          },
          {
            group: ["@src/hooks/dependencies", "@src/hooks/dependencies/*"],
            message:
              "Moved to @src/modules/MainApp/Integrations/hooks/* (usePostPaintGitProbe -> @src/app/root/usePostPaintGitProbe).",
          },
          {
            group: [
              "@src/hooks/git/sourceControl",
              "@src/hooks/git/sourceControl/*",
            ],
            message:
              "Moved to @src/modules/WorkStation/CodeEditor/hooks/sourceControl/* (generateCommitMessage -> @src/api/tauri/git/commitMessage).",
          },
          {
            group: ["@src/hooks/testRunner", "@src/hooks/testRunner/*"],
            message:
              "Moved to @src/modules/WorkStation/CodeEditor/hooks/useTestRunner.",
          },
          {
            group: ["@src/hooks/benchmark", "@src/hooks/benchmark/*"],
            message: "Moved to @src/features/BenchmarkPanel/hooks/*.",
          },
        ],
      },
    ],
  },
  overrides: [
    {
      // A single `.only` silently skips every other test in its file while the
      // run still exits 0 — the same "green but not running" failure mode as a
      // mistargeted cargo filter. `.skip`/`.todo` are deliberately NOT banned:
      // they are visible in the reporter's skipped count, whereas `.only` is not.
      files: ["**/*.test.ts", "**/*.test.tsx"],
      rules: {
        "no-restricted-syntax": [
          "error",
          {
            selector:
              "MemberExpression[object.name=/^(describe|it|test|suite|bench)$/][property.name='only']",
            message:
              "Focused test committed: `.only` makes the rest of this file silently not run. Remove it before committing.",
          },
          {
            selector:
              "MemberExpression[object.object.name=/^(describe|it|test)$/][object.property.name='only']",
            message:
              "Focused test committed: `.only.each` makes the rest of this file silently not run. Remove it before committing.",
          },
        ],
      },
    },
  ],
};
