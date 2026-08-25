use rusqlite::Connection;

/// Re-entrant canonical DDL for the local conversation execution state.
///
/// There are deliberately no foreign keys or cascading actions. Every
/// cross-row transition is checked and applied by the typed store in one
/// `BEGIN IMMEDIATE` transaction.
pub(crate) fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS conversation_executions (
            executor_scope TEXT NOT NULL,
            conversation_root_key TEXT NOT NULL,
            active_episode_id TEXT,
            candidate_episode_id TEXT,
            revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
            updated_at TEXT NOT NULL,
            PRIMARY KEY (executor_scope, conversation_root_key),
            CHECK (executor_scope <> ''),
            CHECK (conversation_root_key <> ''),
            CHECK (active_episode_id IS NULL OR active_episode_id <> ''),
            CHECK (candidate_episode_id IS NULL OR candidate_episode_id <> ''),
            CHECK (updated_at <> ''),
            CHECK (
                active_episode_id IS NULL OR candidate_episode_id IS NULL
                OR active_episode_id <> candidate_episode_id
            )
        );

        CREATE TABLE IF NOT EXISTS conversation_execution_episodes (
            executor_scope TEXT NOT NULL,
            conversation_root_key TEXT NOT NULL,
            episode_id TEXT NOT NULL,
            runner_session_id TEXT NOT NULL,
            native_session_id TEXT NOT NULL,
            state TEXT NOT NULL CHECK (
                state IN ('prepared', 'materializing', 'active', 'retired', 'failed')
            ),
            source_checkpoint_id TEXT,
            source_checkpoint_sha256 TEXT,
            source_event_count INTEGER NOT NULL CHECK (source_event_count >= 0),
            source_tip_event_id TEXT,
            runtime_category TEXT NOT NULL,
            runtime_id TEXT NOT NULL,
            agent_id TEXT,
            account_id TEXT,
            model_id TEXT,
            workspace_locator TEXT,
            workspace_fingerprint TEXT,
            execution_profile_fingerprint TEXT NOT NULL,
            bootstrap_intent_id TEXT NOT NULL,
            verified_materialization_sha256 TEXT,
            activation_receipt_id TEXT,
            supersedes_episode_id TEXT,
            roll_reason TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (executor_scope, conversation_root_key, episode_id),
            CHECK (executor_scope <> ''),
            CHECK (conversation_root_key <> ''),
            CHECK (episode_id <> ''),
            CHECK (runner_session_id <> ''),
            CHECK (native_session_id <> ''),
            CHECK (runtime_category <> ''),
            CHECK (runtime_id <> ''),
            CHECK (execution_profile_fingerprint <> ''),
            CHECK (bootstrap_intent_id <> ''),
            CHECK (source_tip_event_id IS NULL OR source_tip_event_id <> ''),
            CHECK (agent_id IS NULL OR agent_id <> ''),
            CHECK (account_id IS NULL OR account_id <> ''),
            CHECK (model_id IS NULL OR model_id <> ''),
            CHECK (workspace_locator IS NULL OR workspace_locator <> ''),
            CHECK (
                workspace_fingerprint IS NULL OR workspace_fingerprint <> ''
            ),
            CHECK (
                supersedes_episode_id IS NULL OR (
                    supersedes_episode_id <> ''
                    AND supersedes_episode_id <> episode_id
                )
            ),
            CHECK (roll_reason IS NULL OR roll_reason <> ''),
            CHECK (created_at <> ''),
            CHECK (updated_at <> ''),
            CHECK (
                (source_checkpoint_id IS NULL AND source_checkpoint_sha256 IS NULL)
                OR (
                    source_checkpoint_id IS NOT NULL
                    AND source_checkpoint_id <> ''
                    AND source_checkpoint_sha256 IS NOT NULL
                    AND length(source_checkpoint_sha256) = 64
                    AND source_checkpoint_sha256 NOT GLOB '*[^0-9a-f]*'
                )
            ),
            CHECK (
                source_event_count = 0 OR source_checkpoint_id IS NOT NULL
            ),
            CHECK (
                source_event_count > 0 OR source_tip_event_id IS NULL
            ),
            CHECK (
                verified_materialization_sha256 IS NULL
                OR (
                    length(verified_materialization_sha256) = 64
                    AND verified_materialization_sha256 NOT GLOB '*[^0-9a-f]*'
                )
            ),
            CHECK (
                (verified_materialization_sha256 IS NULL
                    AND activation_receipt_id IS NULL)
                OR (
                    verified_materialization_sha256 IS NOT NULL
                    AND activation_receipt_id IS NOT NULL
                    AND activation_receipt_id <> ''
                )
            ),
            CHECK (
                state <> 'active' OR verified_materialization_sha256 IS NOT NULL
            ),
            CHECK (
                state NOT IN ('prepared', 'materializing') OR (
                    verified_materialization_sha256 IS NULL
                    AND roll_reason IS NULL
                )
            ),
            CHECK (
                state <> 'active' OR roll_reason IS NULL
            ),
            CHECK (
                state NOT IN ('retired', 'failed') OR roll_reason IS NOT NULL
            )
        );

        CREATE INDEX IF NOT EXISTS idx_conversation_execution_episodes_recent
            ON conversation_execution_episodes (
                executor_scope,
                conversation_root_key,
                updated_at DESC,
                episode_id DESC
            );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_execution_episodes_runner
            ON conversation_execution_episodes (runner_session_id);

        CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_execution_episodes_native_target
            ON conversation_execution_episodes (
                runtime_category,
                runtime_id,
                execution_profile_fingerprint,
                native_session_id
            );

        CREATE TABLE IF NOT EXISTS conversation_runner_registry (
            runner_session_id TEXT NOT NULL PRIMARY KEY,
            executor_scope TEXT NOT NULL,
            conversation_root_key TEXT NOT NULL,
            episode_id TEXT NOT NULL,
            terminal INTEGER NOT NULL DEFAULT 0 CHECK (terminal IN (0, 1)),
            registered_at TEXT NOT NULL,
            terminal_at TEXT,
            updated_at TEXT NOT NULL,
            CHECK (runner_session_id <> ''),
            CHECK (executor_scope <> ''),
            CHECK (conversation_root_key <> ''),
            CHECK (episode_id <> ''),
            CHECK (registered_at <> ''),
            CHECK (updated_at <> ''),
            CHECK (
                (terminal = 0 AND terminal_at IS NULL)
                OR (
                    terminal = 1
                    AND terminal_at IS NOT NULL
                    AND terminal_at <> ''
                )
            )
        );

        CREATE INDEX IF NOT EXISTS idx_conversation_runner_registry_execution
            ON conversation_runner_registry (
                executor_scope,
                conversation_root_key,
                episode_id
            );

        CREATE INDEX IF NOT EXISTS idx_conversation_runner_registry_cleanup
            ON conversation_runner_registry (
                terminal,
                terminal_at,
                runner_session_id
            );",
    )
}
