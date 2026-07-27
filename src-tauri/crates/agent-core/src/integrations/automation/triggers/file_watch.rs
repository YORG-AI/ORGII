//! File watching automation trigger listener.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::mpsc;
use tracing::{debug, error, info, warn};

use super::common::{TriggerEvent, TriggerHandle};

pub(super) fn spawn_file_watch(
    rule_id: String,
    paths: Vec<String>,
    debounce_ms: u64,
    event_tx: mpsc::Sender<TriggerEvent>,
) -> Option<TriggerHandle> {
    use notify::Watcher;

    if paths.is_empty() {
        warn!(
            "[automation] FileWatch rule '{}' has no paths to watch",
            rule_id
        );
        return None;
    }

    let running = Arc::new(AtomicBool::new(true));
    let running_clone = running.clone();
    let rid = rule_id.clone();
    let watch_paths: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();

    let handle = tokio::spawn(async move {
        info!(
            "[automation] FileWatch trigger starting for rule '{}' (debounce: {}ms, paths: {})",
            rid,
            debounce_ms,
            watch_paths.len()
        );

        // Capacity one is intentional: filesystem storms carry only
        // invalidation semantics, so duplicate notifications coalesce instead
        // of building an unbounded queue behind the debounce window.
        let (notify_tx, mut notify_rx) = mpsc::channel::<()>(1);
        let rid_for_callback = rid.clone();
        let mut watcher = match notify::recommended_watcher(
            move |result: Result<notify::Event, notify::Error>| match result {
                Ok(_event) => match notify_tx.try_send(()) {
                    Ok(()) | Err(mpsc::error::TrySendError::Full(())) => {}
                    Err(mpsc::error::TrySendError::Closed(())) => {
                        debug!(
                            "[automation] FileWatch debounce channel for rule '{}' was closed",
                            rid_for_callback
                        );
                    }
                },
                Err(err) => {
                    error!(
                        "[automation] FileWatch error for rule '{}': {}",
                        rid_for_callback, err
                    );
                }
            },
        ) {
            Ok(watcher) => watcher,
            Err(err) => {
                error!(
                    "[automation] Failed to create file watcher for rule '{}': {}",
                    rid, err
                );
                return;
            }
        };

        for path in &watch_paths {
            if let Err(err) = watcher.watch(path, notify::RecursiveMode::Recursive) {
                warn!(
                    "[automation] FileWatch could not watch path '{}' for rule '{}': {}",
                    path.display(),
                    rid,
                    err
                );
            }
        }

        info!("[automation] FileWatch trigger started for rule '{}'", rid);
        let debounce_duration = tokio::time::Duration::from_millis(debounce_ms.max(100));

        'watch_loop: while running_clone.load(Ordering::Relaxed) {
            if notify_rx.recv().await.is_none() {
                warn!(
                    "[automation] FileWatch notify channel disconnected for rule '{}'",
                    rid
                );
                break;
            }

            // Wait for a full quiet window. Each coalesced signal resets the
            // deadline without allocating another queued event.
            loop {
                match tokio::time::timeout(debounce_duration, notify_rx.recv()).await {
                    Ok(Some(())) => continue,
                    Ok(None) => break 'watch_loop,
                    Err(_) => {
                        if !running_clone.load(Ordering::Relaxed) {
                            break;
                        }
                        if let Err(err) = event_tx
                            .send(TriggerEvent {
                                rule_id: rid.clone(),
                            })
                            .await
                        {
                            error!(
                                "[automation] Failed to send file watch trigger event for rule '{}': {}",
                                rid, err
                            );
                            break 'watch_loop;
                        }
                        break;
                    }
                }
            }
        }

        drop(watcher);
        info!("[automation] FileWatch trigger stopped for rule '{}'", rid);
    });

    Some(TriggerHandle {
        rule_id,
        running,
        handle: Some(handle),
    })
}
