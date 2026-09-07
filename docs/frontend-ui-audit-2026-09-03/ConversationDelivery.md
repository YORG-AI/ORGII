# Conversation delivery frontend UI audit

Scope: Work Item and Team Session composer delivery states, audience routing, and retry/edit behavior added by PR #844.

| Element                                          | Verdict          | Reason                                                                                                                                            | Suggested change |
| ------------------------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `useConversationComposer.ts` submit ownership    | keep with reason | Reuses the existing composer submit path and maps only the retained-delivery result; it does not introduce a second queue or scroll-follow owner. | None.            |
| `org2CloudSessionCommentsAtom.ts` optimistic row | keep with reason | A single local message identity advances from pending to sent or failed, so failure remains visible and does not repopulate the composer.         | None.            |
| `UserChatItem.tsx` failed delivery actions       | keep with reason | Retry and edit-then-retry are attached to the failed message and preserve body, attachments, and mentions.                                        | None.            |
| `messageAudienceRouting.ts` policy               | keep with reason | Agent, direct-human, and team audiences share one explicit routing policy instead of relying on UI labels.                                        | None.            |
| roster refresh notifications                     | keep with reason | Server mutation remains the source of truth; post-commit notification failures cannot turn a successful mutation into a false UI error.           | None.            |
| Work Item status projection                      | keep with reason | Status data has one project-scoped cache owner and uses narrow invalidation, avoiding duplicated Zustand and component caches.                    | None.            |
| composer size and layout                         | keep with reason | No new composer shell, minimum height, or conditional base class is introduced by this change.                                                    | None.            |
| streaming follow behavior                        | keep with reason | No second auto-follow effect is introduced; the existing user-scroll pause owner remains authoritative.                                           | None.            |

## Verdict counts

- Fix: 0
- Keep with reason: 8
- Abstract: 0

No multi-file design-system sweep candidate was found.
