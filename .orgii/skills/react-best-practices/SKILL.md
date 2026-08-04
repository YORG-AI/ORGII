---
name: react-best-practices
description: ORGII-specific React 19 performance review and implementation guidance adapted from Vercel Engineering. Use for React re-render, async waterfall, bundle/startup cost, heavy dependency, virtualization, high-frequency event, Context/provider, persistence, or store-subscription work. Do not trigger for styling, copy changes, or routine single-file UI bug fixes without a performance concern.
---

# ORGII React Best Practices

Apply React performance guidance for ORGII's React 19, Webpack, and Tauri client runtime. Next.js, React Server Components, SSR, and server-only advice do not apply.

See [UPSTREAM.md](UPSTREAM.md) only when provenance or comparison with the pinned upstream guidance is required.

## Applicability filter

- Require a concrete performance concern: render frequency, async sequencing, startup/bundle cost, high-frequency browser work, subscription scope, virtualization, or persistence overhead.
- Prefer measured evidence over generic optimization claims.
- Preserve ORGII's existing state ownership and data-access architecture.
- Do not introduce SWR, server-only APIs, or a new state architecture solely to follow upstream examples.
- Do not trade correctness, accessibility, or lifecycle cleanup for a smaller benchmark number.

## Priority

1. Eliminate serial async work and repeated I/O.
2. Narrow subscriptions and prevent broad re-render fan-out.
3. Remove heavy eager imports from startup paths.
4. Bound high-frequency work and large rendered collections.
5. Apply micro-optimizations only after the larger costs are measured.

## Workflow

1. Establish a baseline and identify the hot path or expensive lifecycle.
2. Read [implementation-guidance.md](references/implementation-guidance.md) for applicable async, render, browser, import, data-fetching, subscription, and persistence patterns.
3. Read [compatibility-boundaries.md](references/compatibility-boundaries.md) before applying upstream advice that assumes Next.js, RSC, SSR, server caching, or framework-specific loaders.
4. Read [high-risk-surfaces.md](references/high-risk-surfaces.md) when touching the named ORGII subsystems.
5. Follow [workflow-and-verification.md](references/workflow-and-verification.md) for measurement, implementation order, regression coverage, and delivery reporting.

## Delivery

State the measured concern, selected rule, ORGII-specific adaptation, verification evidence, and remaining performance risk. Typecheck-only evidence does not prove a runtime performance improvement.
