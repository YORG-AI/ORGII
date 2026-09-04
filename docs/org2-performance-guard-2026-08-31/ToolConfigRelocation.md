# Tool configuration relocation

Moved webpack, Vitest, PostCSS, Tailwind, and commitlint configuration into
`config/`, consolidated ESLint, Prettier, and unimported settings in
`package.json`, moved the environment template to `config/env.example`, and removed
the unused `.babelrc.js` and the requested `.cursorignore`. ESLint rule
explanations are preserved in `docs/development/linting.md`. Package scripts, the dev wrapper, Tauri build wrappers,
the commit hook, Prettier, CI selectors, and contributing instructions now use
the new paths. Dependencies, the lockfile, and the actual root `.env` were not
changed.

## Architecture coverage

Reviewed architecture-audit layers 1 (compilation), 2 (unused Babel config),
3 (configuration names), 5 (config lookup defaults), 7 (contributor discovery),
9 (build/test entry-point parity), and 10 (root and alias resolution). Layers
4, 6, and 8 were skipped because domain semantics, cross-domain ownership, and
wire formats are unchanged. No UI implementation or Rust code was changed.

## Running-server regression

The existing dev server had loaded webpack's old configuration at startup.
Removing the root PostCSS file left that process using automatic discovery with
no configuration to find. Its served `main.js` contained unexpanded
`@tailwind base`, `@tailwind components`, and `@tailwind utilities`, explaining
the missing styles. The authoritative failing artifact was generated CSS in
the webpack bundle; no persisted application data was involved.

The relocated webpack configuration explicitly selects PostCSS, and PostCSS
explicitly selects Tailwind. After the user restarted the server, an HTTP read
of `http://localhost:1998/main.js` found zero raw `@tailwind base` directives,
the Tailwind generated-CSS banner, and the custom `--color-pane-raised` token.
No cache deletion or application-data cleanup was performed. Contributing
instructions now explain that relocating build configuration requires a dev
server restart.

## Performance review

| Area               | Verdict | Evidence                                                                                                      | Change or reason kept                                                 | Verification                                                                                                       |
| ------------------ | ------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Background work    | keep    | Webpack owns the compiler and watchers; no new polling or timers in repository code                           | Existing HMR, static-watch, and reconnect settings retained           | Seven-mode config parity; source edit produced one rebuild; watcher and compiler closed                            |
| Memory             | keep    | Filesystem cache strategy, compression, and chunk settings are unchanged                                      | Preserve existing resource behavior; make no memory-improvement claim | Normalized before/after configuration comparison                                                                   |
| Scope/isolation    | keep    | Output, aliases, managed paths, static assets, and cache mode namespaces still resolve to the repository root | Explicit root context and relocated config paths                      | Development and both production pipelines compiled isolated fixtures; output/cache stayed in a temporary directory |
| Rendering/hot path | keep    | No runtime UI code changed; CSS generation is a build-time boundary                                           | Preserve Tailwind settings and generated styles                       | CSS and Prettier parity; real SCSS/Tailwind compilation; restarted live bundle inspected over HTTP                 |

Applicable lifecycle states were compiler start, source edit/rebuild, and
shutdown. PostCSS and Tailwind config files were present in the compilation's
file dependencies, preserving rebuild invalidation. App identity, network,
document visibility, cloud sync, and secondary-instance lifecycle were not
changed and are outside this relocation's scope.

## Verification

- `pnpm lint`: passed across the full source tree with zero warnings on the isolated PR branch.
- `pnpm typecheck`: passed on the isolated PR branch.
- `pnpm check:circular`: passed across 6,310 modules on the isolated PR branch.
- ESLint effective-configuration comparison: six discovery/ignore/override contexts and three lint fixtures matched before and after consolidation into `package.json`.
- `pnpm exec webpack configtest config/webpack.config.js`: passed.
- `node --test scripts/dev/webpack-config-light.test.cjs scripts/ci/*.test.cjs scripts/tauri/verify-webpack-runtime.test.cjs`: 33 passed.
- `pnpm test src/app/root/__tests__/startupGraph.test.ts`: 3 passed.
- `pnpm exec vitest list --config config/vitest.config.ts --filesOnly --json <temporary-output>`: the same 1,274 files as clean `develop`, compared as sorted repository-relative sets.
- `pnpm exec eslint src/app/root/__tests__/startupGraph.test.ts --max-warnings 0 --report-unused-disable-directives`: passed.
- `pnpm exec prettier --check config/postcss.config.js config/vitest.config.ts src/app/root/__tests__/startupGraph.test.ts`: passed.
- The commit-hook command accepted a valid scoped title and rejected an invalid title using temporary message files; no commit was created.
- Temporary before/after harness: webpack settings matched in ordinary, fast, light, eager, and E2E development plus ordinary and fast production; Vitest settings, representative Tailwind CSS, Prettier class ordering, and five commit-message verdicts matched.
- Temporary webpack integration harness: real TSX, SCSS/Tailwind, SVG component/URL, root alias, HTML, and config-dependency handling passed in development, production, and fast production. Watch mode completed two compilations (initial plus source edit) and closed successfully.
- Tailwind config, commitlint rules, and the environment template are byte-for-byte unchanged from their previous locations. Dependency sections and the lockfile are unchanged.
- JavaScript and shell syntax checks and scoped `git diff --check`: passed.

The full desktop release build, Rust compilation, full Vitest suite, and GUI
inspection were not run. The integration harness used small temporary entry
files and isolated output/cache directories, so it does not establish whole-app
performance or visual correctness. No CPU/RAM improvement is claimed.

Performance verdict: pass for the applicable configuration and build/watch
invariants above.
