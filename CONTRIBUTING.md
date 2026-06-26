# Contributing to ORGII

Thank you for helping improve ORGII. This project is a Tauri v2 desktop app built with React, TypeScript, webpack, and Rust.

## Quick path

1. Search existing issues and pull requests first.
2. For larger changes, open an issue or discussion before implementing.
3. Set up the app, make a small focused change, and run the checks that match your files.
4. Open a pull request with a clear summary, test plan, and passing CLA check.

Keep secrets, private data, generated artifacts, and unrelated formatting changes out of your PR. If you use AI assistance, a human must actively review the design and implementation before submission.

## Development setup

Install the required tools:

| Tool                                 | Version           | Notes                                                                                       |
| ------------------------------------ | ----------------- | ------------------------------------------------------------------------------------------- |
| [Node.js](https://nodejs.org/)       | 20 or current LTS | Use `nvm install --lts` or the Node.js installer.                                           |
| [pnpm](https://pnpm.io/installation) | 9.15              | Install with `npm install -g pnpm@9.15`.                                                    |
| [Rust toolchain](https://rustup.rs/) | 1.85.0 or later   | Use `rustup toolchain install stable`.                                                      |
| Tauri system dependencies            | Tauri v2          | Follow the [Tauri prerequisites guide](https://tauri.app/start/prerequisites/) for your OS. |
| [Python 3](https://www.python.org/)  | Any 3.x           | Only needed for optional asset download scripts.                                            |

From the repository root:

```bash
pnpm install
pnpm run tauri:dev
```

Tauri starts the webpack dev server through its `beforeDevCommand`, so use the Tauri scripts for normal desktop development.

Copy `.env.example` to `.env` only when you need local configuration. `.env` is gitignored; never commit real secrets.

For fast desktop iteration against a built app bundle:

```bash
pnpm run tauri:build:fast
```

## Run the right checks

Run the checks that match the files you changed. If you cannot run a relevant check locally, explain why in the PR and include any partial verification you performed.

| Change area                   | Recommended checks                                                                                         |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Frontend / TypeScript         | `pnpm run lint`, `pnpm run test`, `pnpm run check:circular`                                                |
| Rust / Tauri                  | `pnpm run cargo:check`, `pnpm run cargo:clippy`, `pnpm run cargo:test`                                     |
| Targeted Rust modules         | `pnpm run cargo:test:agent_core`, `pnpm run cargo:test:event_store`, or `pnpm run cargo:test:work_station` |
| Chat, session, or UI behavior | E2E tests in `tests/e2e`; see `tests/e2e/README.md`                                                        |

Core UI end-to-end tests use WebDriverIO with `tauri-webdriver-automation`:

```bash
cargo install tauri-webdriver-automation --locked
cd tests/e2e
pnpm install
pnpm test
```

## Project map

| Path         | Purpose                                                     |
| ------------ | ----------------------------------------------------------- |
| `src/`       | React, TypeScript, UI, stores, hooks, and frontend services |
| `src-tauri/` | Tauri shell and Rust backend                                |
| `docs/`      | Living architecture and feature documentation               |
| `scripts/`   | Development, setup, maintenance, and build scripts          |
| `tests/`     | Repository-level tests and test helpers                     |

Add or update docs when behavior, architecture, setup, or user-visible behavior changes in a way that is not obvious from the code.

## Coding expectations

Use the repository rules in `.cursor/rules/` as the source of truth. The most common expectations are:

- Keep changes focused and remove dead code immediately.
- Use existing shared components, hooks, stores, and design tokens.
- Prefer typed constants and enums over hardcoded domain strings.
- Let errors propagate instead of silently returning empty fallback data.
- Update all supported locales when changing user-facing UI text.
- Follow frontend/backend contract rules when a setting, command, or wire type crosses the TypeScript and Rust boundary.

For deeper guidance, read:

- `.cursor/rules/orgii-frontend.mdc`
- `.cursor/rules/frontend-backend-alignment.mdc`
- `.cursor/rules/rust-resource-lifecycle.mdc`
- `.cursor/rules/cargo-cleanup.mdc`

## Commits and pull requests

Commit messages and PR titles must use scoped Conventional Commits:

```text
feat(scope): short imperative summary
fix(scope): short imperative summary
```

Use lowercase kebab-case scopes such as `git`, `settings`, `workstation`, `slash-menu`, or `contributing`. Common types include `feat`, `fix`, `chore`, `docs`, `style`, `test`, `refactor`, `perf`, `build`, `ci`, and `revert`.

Every non-trivial commit needs a body that explains why the change exists, summarizes important behavior or architecture changes, and mentions notable verification or migration details.

A `commit-msg` hook runs commitlint, and the pre-commit hook appends a tamper-evidence trailer:

```text
Pre-commit hook ran. Total eslint: N, total circular: N
```

Do not remove this trailer, and do not bypass hooks with `--no-verify`, `HUSKY=0`, or similar unless a maintainer explicitly asks you to do so for emergency recovery. If a hook fails, fix the issue and rerun the command normally.

## Pull request checklist

Before requesting review, make sure the PR has:

- A clear title, description, and test plan.
- One focused issue, feature, or fix.
- Relevant checks passing, or a note explaining what could not be run.
- CLA Assistant passing, plus screenshots or docs when the change needs them.

Also confirm that no secrets, local configuration, generated build output, or unrelated files are included.

## Contributor License Agreement

ORGII requires contributors to sign the repository Contributor License Agreement before a pull request can be merged. The agreement text is in [`docs/contributing/CLA.md`](docs/contributing/CLA.md).

GitHub CLA Assistant will comment with a signing link on your first PR if your GitHub account has not signed the current agreement.

- Sign as an individual when the contribution is your own work and you are legally allowed to submit it.
- Sign as a company only if you are authorized to bind that organization to the CLA.

Maintainers will not merge PRs until the CLA check passes.

## Security

Do not report security vulnerabilities in public issues. Use the repository's private security advisory flow when available, or contact the maintainers privately.

Never commit API keys, signing keys, OAuth secrets, personal tokens, private logs, or user data. If you accidentally expose a secret, revoke it immediately and notify maintainers.

## Code of conduct and license

Be respectful, constructive, and specific. Keep issue and pull request discussions focused on the work.

By contributing, you agree that your contributions are licensed under AGPL-3.0-or-later and submitted under the Contributor License Agreement in `docs/contributing/CLA.md`. See `LICENSE` for the full license text.
