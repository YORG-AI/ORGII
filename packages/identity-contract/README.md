# `@orgii/identity-contract`

Shared, versioned, non-secret identity DTOs for ORGII Desktop, ORGII Web, and
the ORG2 Cloud BFF.

## What this package owns

- strict runtime schemas for the public identity snapshot;
- TypeScript types inferred from those schemas;
- the package-level contract revision.

It deliberately does **not** own login UI, provider configuration, HTTP
clients, cookies, secure-store access, OAuth state, or credentials.

```ts
import {
  type IdentitySnapshot,
  IdentitySnapshotSchema,
} from "@orgii/identity-contract";

const snapshot: IdentitySnapshot = IdentitySnapshotSchema.parse(payload);
```

Unknown fields fail validation. Credential-bearing values must never be added
to this public contract; platform-specific brokers and BFFs retain those values
behind their own trust boundaries.

## Compatibility

Additive optional metadata may ship in a minor version. Removing or renaming a
field, changing a required field, or changing enum semantics requires a major
version and a coordinated Desktop/Web/Cloud rollout.
