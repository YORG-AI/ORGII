# MobileChrome UI audit

Scope: plain, solid monochrome page backgrounds, plus iOS-inspired navigation and large action buttons. Liquid Glass is confined to controls; page content and the welcome icon use opaque surfaces. The user's narrowed scope excludes session details. Session rows, transcript rendering, the composer, connection logic, and settings content were not edited. The existing 393px viewport width is preserved.

| Line                                                           | Element                                     | Verdict          | Reason                                                                                                                                                                                                                                                       | Suggested change |
| -------------------------------------------------------------- | ------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| `src/modules/MobileRemote/components/MobileShell.tsx:15`       | Mobile shell                                | keep with reason | Keeps existing height, overflow, and safe-area ownership. The chrome stylesheet is imported by the shared mobile shell for browser and native entries, with mobile-specific selectors and variables.                                                         | None.            |
| `src/modules/MobileRemote/components/MobileTopBar.tsx:22`      | Large root titles and compact navigation    | keep with reason | Shared `IconButton` retains native button semantics and accessible labels. Navigation gets 44px circular targets and centered detail-page titles; session content is unchanged.                                                                              | None.            |
| `src/modules/MobileRemote/components/MobileTabBar.tsx:47`      | Floating tab dock                           | keep with reason | Reuses shared `Button`, existing translations, callbacks, and `aria-current`. A shared material surrounds the three tabs, and the dock reserves layout space and the bottom safe area.                                                                       | None.            |
| `src/modules/MobileRemote/components/MobileActionButton.tsx:6` | Shared large action presentation            | keep with reason | The same wrapper serves six actions across five screens. It reuses `Button` loading, disabled, icon, and event behavior while adapting desktop inline dimensions through mobile CSS variables. No additional abstraction is needed.                          | None.            |
| `src/modules/MobileRemote/mobileChrome.scss:3`                 | Chrome palette and material tokens          | keep with reason | Local black/white control colors and solid neutral backgrounds implement the user's requested monochrome appearance in light and dark modes. These values do not override app-wide semantic tokens or session styling.                                       | None.            |
| `src/modules/MobileRemote/mobileChrome.scss:214`               | Focus, touch, and accessibility preferences | keep with reason | Chrome controls have visible focus outlines, 44px-or-larger targets, and reduced-motion/transparency and increased-contrast treatments. Large action labels can wrap. Backdrop blur is restricted to controls, with an opaque unsupported-browser treatment. | None.            |
| `src/modules/MobileRemote/screens/SessionsScreen.tsx:24`       | Sessions page heading                       | keep with reason | Uses the existing translated tab name in the shared top bar. The list and all session data and presentation remain unchanged.                                                                                                                                | None.            |

Verdict totals: **0 fix**, **7 keep with reason**, **0 abstract**.

## Verification

Verified against the latest `origin/develop` in an isolated checkout containing only this change.

- `pnpm exec vitest run --config config/vitest.config.ts src/modules/MobileRemote --silent`: **40 files, 231 tests passed**, including session-row geometry, transcript, composer, authentication, and navigation coverage. The run emitted existing Vite/Sass deprecation notices.
- `pnpm run typecheck:fast`: **passed**.
- Changed-file ESLint with `--max-warnings 0` and Prettier: **passed** (exact commands below).
- `git diff --check`: **passed**.
- `pnpm run check:test-placement`: **passed**, 497 directories.
- `pnpm run check:circular`: **failed on an existing cycle**, `util/modelGrouping.ts -> util/modelVariants.ts -> util/modelGrouping.ts`. Both files match `origin/develop`; the reciprocal imports were confirmed in the base. No mobile module participates in the reported cycle.
- `node -e 'const sass=require("sass");const result=sass.compile("src/modules/MobileRemote/mobileChrome.scss");console.log("Compiled mobile chrome: "+result.css.length+" bytes");if(result.css.includes("gradient(")||result.css.includes("mobile-wallpaper"))process.exitCode=1;'`: **passed**, 6,440 compiled CSS bytes, no decorative background.
- Development-server HTTP readback of `/orgii/mobile` and `/mobile.js`: **200**. The served bundle contains the final plain monochrome chrome stylesheet and `MobileActionButton`, with no build-error marker.
- Computed monochrome primary-action and selected-tab text contrast: light **17.93:1**, light pressed **12.63:1**, dark **17.32:1**, dark pressed **12.74:1**. This covers solid control colors, not browser-rendered glass compositing.
- Browser screenshots, physical iPhone rendering, and runtime blur cost were not verified. The user's computer-control preference was respected. These CSS changes add no timers, subscriptions, or continuous animations; no runtime performance improvement is claimed.

Exact changed-file commands:

```sh
pnpm exec eslint src/modules/MobileRemote/auth/MobileAuthScreen.tsx src/modules/MobileRemote/components/MobileShell.tsx src/modules/MobileRemote/components/MobileTabBar.tsx src/modules/MobileRemote/components/MobileTopBar.tsx src/modules/MobileRemote/components/MobileActionButton.tsx src/modules/MobileRemote/screens/ConnectionErrorScreen.tsx src/modules/MobileRemote/screens/QRScanScreen.tsx src/modules/MobileRemote/screens/SASConfirmScreen.tsx src/modules/MobileRemote/screens/SessionsScreen.tsx src/modules/MobileRemote/screens/WelcomeScreen.tsx --max-warnings 0
pnpm exec prettier --check docs/frontend-ui-audit-2026-09-05/MobileChrome.md src/modules/MobileRemote/auth/MobileAuthScreen.tsx src/modules/MobileRemote/components/MobileShell.tsx src/modules/MobileRemote/components/MobileTabBar.tsx src/modules/MobileRemote/components/MobileTopBar.tsx src/modules/MobileRemote/components/MobileActionButton.tsx src/modules/MobileRemote/mobileChrome.scss src/modules/MobileRemote/screens/ConnectionErrorScreen.tsx src/modules/MobileRemote/screens/QRScanScreen.tsx src/modules/MobileRemote/screens/SASConfirmScreen.tsx src/modules/MobileRemote/screens/SessionsScreen.tsx src/modules/MobileRemote/screens/WelcomeScreen.tsx
```
