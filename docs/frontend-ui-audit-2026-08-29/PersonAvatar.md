# PersonAvatar UI audit

Scope: the new shared `PersonAvatar` primitive and every people-avatar site
migrated onto it — the conversation surface first, then a full-repo sweep —
plus the sidebar Inbox unread badge that moved from the row's trailing slot to
the label's trailing edge.

## D1 — Raw HTML vs Design System

| Line                                       | Element                      | Verdict          | Reason                                                                                                                                                | Suggested change                                                                  |
| ------------------------------------------ | ---------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `src/components/PersonAvatar/index.tsx:47` | `PersonAvatar`               | keep with reason | It is the DS primitive. Composes `Avatar`; adds no raw markup of its own.                                                                             | None.                                                                             |
| `GroupChatMessageBubble.tsx:102`           | Group-chat sender avatar     | fix (done)       | Was a raw `<div class="rounded-full …">` with a file-local six-colour palette; one teammate read as a different person here than in the message list. | Now `<PersonAvatar name={senderName} size={24} />`.                               |
| `session-discussion.tsx:36`                | Discussion comment avatar    | fix (done)       | Was a raw `size-6 rounded-full` div with `bg-fill-3`/`bg-primary-1` and an inline `initialOf` helper.                                                 | Now `PersonAvatar`, with `fallback="✦"` retained for agent reports.               |
| `SessionViewersIndicator.tsx:119`          | Live-viewer avatars          | fix (done)       | Was a raw `size-4` circle hardcoded to `bg-success-6`. Presence is already conveyed by the indicator rendering at all, plus its roster tooltip.       | Now `PersonAvatar size={16}`; the stacking `ring-1 ring-bg-1` moved to a wrapper. |
| `UserChatItem.tsx:636`                     | Shared-message sender avatar | fix (done)       | Used bare `Avatar` with an inline `background-color` and two-letter initials from `createCollabAvatarIdentity` — a third distinct treatment.          | Now `PersonAvatar`; the local `createCollabAvatarIdentity` call is gone.          |
| `SidebarAccountButton.tsx:43`              | Sidebar account avatar       | fix (done)       | The reference treatment. Kept identical output while adopting the shared primitive, so the two cannot drift apart.                                    | Now `PersonAvatar size={20}`.                                                     |
| `UserChatItem.tsx:626`                     | Parent-agent sender avatar   | keep with reason | Not a person — renders `SessionIdentityIcon` for the parent session. A name-seeded gradient would assert an identity it does not have.                | None.                                                                             |
| `workstationSidebarMenuItems.tsx:73`       | Inbox unread badge           | keep with reason | A count pill, not a DS component; no `Badge` primitive exists in `src/components/`.                                                                   | If a third badge appears, extract `components/CountBadge`.                        |

## D2 — Arbitrary Tailwind Value vs Token

| Line                                 | Element           | Verdict          | Reason                                                                                                                                                                                                      | Suggested change |
| ------------------------------------ | ----------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `workstationSidebarMenuItems.tsx:79` | `text-[9px]`      | keep with reason | Tailwind's scale bottoms out at `text-xs` (12px), which is the size being moved away from. Matches the existing `text-[9px]` in `SessionViewersIndicator` overflow chip and `ConversationParticipantsChip`. | None.            |
| `PersonAvatar/index.tsx:54`          | Pixel `size` prop | keep with reason | Inherited from `Avatar`, which drives `width`/`height`/`fontSize` from one number so the glyph scales with the circle. A class-based scale cannot express `fontSize: size * 0.5`.                           | None.            |

## D3 — Hardcoded Sizes / Colors

| Line                        | Element                     | Verdict          | Reason                                                                                                    | Suggested change |
| --------------------------- | --------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------- | ---------------- |
| `Avatar/index.tsx:35-42`    | `GRADIENT_FALLBACK_CLASSES` | keep with reason | Pre-existing. Tailwind palette classes, not literals, and identity colour must stay stable across themes. | None.            |
| `PersonAvatar/index.tsx:51` | `size = 24` default         | keep with reason | Three of the five call sites want 24px; the other two pass explicitly.                                    | None.            |

Removed by this change: the file-local `AVATAR_COLORS` palette in
`GroupChatMessageBubble`, and `bg-success-6`/`text-[9px]` on the viewer chips.

## D4 — Accessibility Basics

| Line                                 | Element               | Verdict          | Reason                                                                                                                                                         | Suggested change |
| ------------------------------------ | --------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `PersonAvatar/index.tsx:54`          | Decorative avatar     | keep with reason | `Avatar` renders `<img alt="">`; the name is always adjacent in text or on the wrapper's `title`/`aria-label`. Naming it twice makes screen readers repeat it. | None.            |
| `workstationSidebarMenuItems.tsx:75` | Badge `aria-label`    | keep with reason | Translated "N unread" preserved verbatim through the move; covered by two existing tests.                                                                      | None.            |
| `NavigationMenuRow.tsx:182,417`      | Label + badge wrapper | keep with reason | Non-interactive `<span>` inside the row's existing `role="button"`.                                                                                            | None.            |

## D5 — Repeated Visual / Structural Patterns

| Line                              | Element                  | Verdict          | Reason                                                                                                                                                                                                                               | Suggested change                                                                                    |
| --------------------------------- | ------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| 50 sites / 32 files               | Person avatar            | abstract         | Was 4 mutually inconsistent treatments in the conversation alone, plus ~30 more sites calling `Avatar` directly with hand-derived initials and no identity seed, plus 4 hand-rolled `rounded-full` divs that never touched `Avatar`. | `src/components/PersonAvatar` — landed, and the sweep is complete.                                  |
| `AvatarChip/index.tsx:80`         | `AvatarChip` avatar      | fix (done)       | The chip rendered a bare `Avatar` with a caller-supplied `avatarFallback` node, so each caller derived its own initial.                                                                                                              | `avatarFallback` replaced by `avatarName`; the chip renders `PersonAvatar`. Both consumers updated. |
| `SidebarGuideButton.tsx:283`      | Setup-guide scope avatar | keep with reason | Not a person — `scopeLabel` is the active cloud org, or "Local workspace". A name-seeded identity gradient would assert a person who does not exist.                                                                                 | None.                                                                                               |
| `TeamInboxList.tsx:380`           | PR author avatar         | keep with reason | Uses `hideOnError`: the contract is "render the photo or render nothing", the exact inverse of `PersonAvatar`, which always shows an identity.                                                                                       | None.                                                                                               |
| `LaunchpadDashboardTiles.tsx:208` | Workspace tile initial   | keep with reason | Not a person — the initial is `repo.name`.                                                                                                                                                                                           | None.                                                                                               |

Verdict totals: **44 fix (all applied)**, **12 keep with reason**, **1 abstract**, **0 watch**.

## What the sweep decided, per site class

The sweep was not mechanical — three classes needed a call:

- **Domain identity colour (19 sites, Project Manager).** Members carry a
  persisted `color` that group headers and status dots already render.
  Dropping it for a name-seeded gradient would have made the avatar disagree
  with the rest of that surface, so `PersonAvatar` grew a `color` prop instead.
  It suppresses the gradient rather than sitting behind it: `bg-gradient-to-br`
  paints a `background-image`, which an inline `background-color` cannot
  override, so the two cannot coexist.
- **Entities that merely look like people (3 sites).** Held out — an identity
  gradient on an org, a repo, or an absent photo asserts something false.
- **Everything else (28 sites).** Straight migration; each dropped its local
  `charAt(0).toUpperCase()` / `slice(0, 1)` initial derivation.

## Prop uniformity

Every one of the 50 call sites passes the same shape: `name` always, plus
`size`, and `src` / `color` / `fallback` only where the data exists. No site
passes children, an inline `style`, or a pre-derived initial — those were the
knobs that let the treatments drift apart in the first place.
