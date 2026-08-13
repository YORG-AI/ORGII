# 入口一致性矩阵（Layer 9 / 设计文档 §22.3）

每个入口必须经过同一 Context resolver 与同一 application command 层。空格 =
未落地；落地 phase 在括号内标注后打 ✓；任何长期空格需要书面理由。

| entry point       | context resolver | actor 解析 | auth/capability 交集 | idempotency                           | OCC (expected-revision) | audit event                                          | outbox | pm_change_seq bump |
| ----------------- | ---------------- | ---------- | -------------------- | ------------------------------------- | ----------------------- | ---------------------------------------------------- | ------ | ------------------ |
| CLI (`org2-pm`)   | (P3) ✓           | (P3) ✓     | (P3) ✓               | (P3) ✓ create/claim/transition/invoke | (P3) ✓ claim/transition | (P3) ✓                                               | (P3)   | (P3) ✓             |
| Tauri commands    | (P2a)            | (P2a)      | (P2a)                | (P2a)                                 | (P2a)                   | (P2a) ✓ create/patch/transition/delete/restore/write | (P2a)  | (P2a) ✓            |
| Routine scheduler | (P5)             | (P5)       | (P5)                 | (P5) ✓ plan-time invoke key           | (P5)                    | (P5) ✓ invoke/suppressed_fire                        | (P5)   | (P5) ✓             |
| Provider adapter  | (P6)             | (P6)       | (P6)                 | (P6)                                  | (P6)                    | (P6)                                                 | (P6)   | (P6)               |
| hooks             | (P5)             | (P5)       | (P5)                 | (P5)                                  | (P5)                    | (P5)                                                 | (P5)   | (P5)               |
| tests/E2E helpers | (P3) ✓           | (P3) ✓     | (P3) ✓               | (P3) ✓                                | (P3) ✓                  | (P3) ✓                                               | (P3)   | (P3) ✓             |

规则：

- Test/helper 不得走不同初始化或 debug-only mutation path（helpers 只能 seed
  或 inspect，不得成为被测行为的 side-effect 路径）；
- scheduler 的 manual fire 与 automatic fire 调用同一个 `routine.invoke`；
- Provider adapter 不得绕过 application service 直接写 WorkItem/relation。
