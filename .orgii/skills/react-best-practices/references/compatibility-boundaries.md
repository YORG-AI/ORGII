# ORGII React Compatibility Boundaries

## Explicitly Inapplicable Upstream Rules

Do not apply the following to ORGII's frontend unless the architecture later adds the relevant runtime:

- Next.js API route or Server Action patterns
- React Server Components and RSC prop serialization
- `next/dynamic`, `next/server`, `after()`, `next/headers`, or `next/cache`
- Per-request server deduplication with `React.cache()`
- Cross-request LRU server caches
- SSR hydration mismatch or no-flicker inline-script patterns
- Server component composition for parallel server fetching
- Next.js resource, route, image, font, or script behavior

React `Suspense` remains usable for client-side lazy boundaries, but upstream streaming/RSC claims do not transfer to Tauri.
