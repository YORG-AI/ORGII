use super::FileEntry;
use std::collections::HashMap;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Hash, PartialEq, Eq)]
struct FileIndexKey {
    root_path: String,
    exclude_dirs: Vec<String>,
}

impl FileIndexKey {
    fn new(root_path: &str, exclude_dirs: &[String]) -> Self {
        let mut exclude_dirs = exclude_dirs.to_vec();
        exclude_dirs.sort_unstable();
        exclude_dirs.dedup();
        Self {
            root_path: root_path.to_string(),
            exclude_dirs,
        }
    }
}

struct CachedIndex {
    entries: Arc<[FileEntry]>,
    indexed_at: Instant,
    last_accessed_at: Instant,
    estimated_bytes: usize,
}

#[derive(Default)]
struct BuildFlight {
    result: Mutex<Option<Result<Option<Arc<[FileEntry]>>, String>>>,
    completed: Condvar,
}

impl BuildFlight {
    fn wait(&self) -> Result<Option<Arc<[FileEntry]>>, String> {
        let mut result = self.result.lock().unwrap();
        while result.is_none() {
            result = self.completed.wait(result).unwrap();
        }
        result.clone().unwrap()
    }

    fn finish(&self, result: Result<Option<Arc<[FileEntry]>>, String>) {
        *self.result.lock().unwrap() = Some(result);
        self.completed.notify_all();
    }
}

struct CacheSlot {
    generation: u64,
    cached: Option<CachedIndex>,
    in_flight: Option<Arc<BuildFlight>>,
    last_accessed_at: Instant,
}

impl CacheSlot {
    fn new() -> Self {
        Self {
            generation: 0,
            cached: None,
            in_flight: None,
            last_accessed_at: Instant::now(),
        }
    }
}

#[derive(Default)]
struct CacheState {
    slots: HashMap<FileIndexKey, CacheSlot>,
}

enum CacheAction {
    Return(Arc<[FileEntry]>),
    Wait(Arc<BuildFlight>),
    Build {
        flight: Arc<BuildFlight>,
        generation: u64,
    },
}

/// Coordinates file-path indexes for every open workspace.
///
/// A slot is keyed by both workspace root and exclusion policy. Equivalent
/// callers share one build. Invalidating a root bumps its generation so a
/// build that started before a file change can never repopulate the cache.
pub(super) struct FilePathIndexCache {
    state: Mutex<CacheState>,
    safety_ttl: Duration,
    max_cached_indexes: usize,
    max_single_index_bytes: usize,
    max_total_bytes: usize,
}

impl FilePathIndexCache {
    pub(super) fn new(
        safety_ttl: Duration,
        max_cached_indexes: usize,
        max_single_index_bytes: usize,
        max_total_bytes: usize,
    ) -> Self {
        Self {
            state: Mutex::new(CacheState::default()),
            safety_ttl,
            max_cached_indexes,
            max_single_index_bytes,
            max_total_bytes,
        }
    }

    pub(super) fn get_or_build<F>(
        &self,
        root_path: &str,
        exclude_dirs: &[String],
        build: F,
    ) -> Result<Arc<[FileEntry]>, String>
    where
        F: Fn() -> Vec<FileEntry>,
    {
        let key = FileIndexKey::new(root_path, exclude_dirs);

        loop {
            let action = {
                let mut state = self.state.lock().unwrap();
                self.prune_locked(&mut state);

                let slot = state
                    .slots
                    .entry(key.clone())
                    .or_insert_with(CacheSlot::new);
                slot.last_accessed_at = Instant::now();

                if let Some(cached) = slot.cached.as_mut() {
                    if cached.indexed_at.elapsed() < self.safety_ttl {
                        cached.last_accessed_at = Instant::now();
                        CacheAction::Return(Arc::clone(&cached.entries))
                    } else if let Some(flight) = slot.in_flight.as_ref() {
                        CacheAction::Wait(Arc::clone(flight))
                    } else {
                        slot.cached = None;
                        let flight = Arc::new(BuildFlight::default());
                        slot.in_flight = Some(Arc::clone(&flight));
                        CacheAction::Build {
                            flight,
                            generation: slot.generation,
                        }
                    }
                } else if let Some(flight) = slot.in_flight.as_ref() {
                    CacheAction::Wait(Arc::clone(flight))
                } else {
                    let flight = Arc::new(BuildFlight::default());
                    slot.in_flight = Some(Arc::clone(&flight));
                    CacheAction::Build {
                        flight,
                        generation: slot.generation,
                    }
                }
            };

            match action {
                CacheAction::Return(entries) => return Ok(entries),
                CacheAction::Wait(flight) => {
                    if let Some(entries) = flight.wait()? {
                        return Ok(entries);
                    }
                }
                CacheAction::Build { flight, generation } => {
                    let build_result = catch_unwind(AssertUnwindSafe(&build));
                    let entries = match build_result {
                        Ok(entries) => Arc::<[FileEntry]>::from(entries),
                        Err(_) => {
                            let error = format!("File index build panicked for {root_path}");
                            self.finish_failed_build(&key, &flight, error.clone());
                            return Err(error);
                        }
                    };

                    let accepted =
                        {
                            let mut state = self.state.lock().unwrap();
                            let Some(slot) = state.slots.get_mut(&key) else {
                                flight.finish(Ok(None));
                                continue;
                            };

                            let owns_flight = slot
                                .in_flight
                                .as_ref()
                                .is_some_and(|current| Arc::ptr_eq(current, &flight));
                            if owns_flight {
                                slot.in_flight = None;
                            }

                            if owns_flight && slot.generation == generation {
                                let now = Instant::now();
                                let estimated_bytes = estimate_file_index_bytes(&entries);
                                slot.cached = (estimated_bytes <= self.max_single_index_bytes)
                                    .then(|| CachedIndex {
                                        entries: Arc::clone(&entries),
                                        indexed_at: now,
                                        last_accessed_at: now,
                                        estimated_bytes,
                                    });
                                slot.last_accessed_at = now;
                                self.prune_locked(&mut state);
                                true
                            } else {
                                false
                            }
                        };

                    flight.finish(Ok(accepted.then(|| Arc::clone(&entries))));
                    if accepted {
                        return Ok(entries);
                    }
                    // A file change or explicit clear superseded this build.
                    // Loop so the caller receives a generation-current index.
                }
            }
        }
    }

    pub(super) fn invalidate_root(&self, root_path: &str) {
        let mut state = self.state.lock().unwrap();
        for (key, slot) in &mut state.slots {
            if key.root_path == root_path {
                slot.generation = slot.generation.wrapping_add(1);
                slot.cached = None;
                slot.last_accessed_at = Instant::now();
            }
        }
        state
            .slots
            .retain(|_, slot| slot.cached.is_some() || slot.in_flight.is_some());
    }

    pub(super) fn clear(&self) {
        let mut state = self.state.lock().unwrap();
        for slot in state.slots.values_mut() {
            slot.generation = slot.generation.wrapping_add(1);
            slot.cached = None;
        }
        state.slots.retain(|_, slot| slot.in_flight.is_some());
    }

    fn finish_failed_build(&self, key: &FileIndexKey, flight: &Arc<BuildFlight>, error: String) {
        let mut state = self.state.lock().unwrap();
        if let Some(slot) = state.slots.get_mut(key) {
            if slot
                .in_flight
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(current, flight))
            {
                slot.in_flight = None;
            }
        }
        state
            .slots
            .retain(|_, slot| slot.cached.is_some() || slot.in_flight.is_some());
        drop(state);
        flight.finish(Err(error));
    }

    fn prune_locked(&self, state: &mut CacheState) {
        state.slots.retain(|_, slot| {
            slot.in_flight.is_some()
                || slot
                    .cached
                    .as_ref()
                    .is_some_and(|cached| cached.indexed_at.elapsed() < self.safety_ttl)
        });

        let mut total_bytes = state
            .slots
            .values()
            .filter_map(|slot| slot.cached.as_ref())
            .map(|cached| cached.estimated_bytes)
            .sum::<usize>();
        while state
            .slots
            .values()
            .filter(|slot| slot.cached.is_some())
            .count()
            > self.max_cached_indexes
            || total_bytes > self.max_total_bytes
        {
            let Some(oldest_key) = state
                .slots
                .iter()
                .filter(|(_, slot)| slot.in_flight.is_none() && slot.cached.is_some())
                .min_by_key(|(_, slot)| slot.last_accessed_at)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            if let Some(removed) = state.slots.remove(&oldest_key) {
                total_bytes = total_bytes.saturating_sub(
                    removed
                        .cached
                        .map(|cached| cached.estimated_bytes)
                        .unwrap_or_default(),
                );
            }
        }
    }
}

fn estimate_file_index_bytes(entries: &[FileEntry]) -> usize {
    std::mem::size_of_val(entries)
        + entries
            .iter()
            .map(|entry| entry.path.len() + entry.filename.len())
            .sum::<usize>()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Barrier;
    use std::thread;

    fn entry(name: &str) -> FileEntry {
        FileEntry {
            path: format!("/repo/{name}"),
            filename: name.to_string(),
            is_dir: false,
        }
    }

    #[test]
    fn equivalent_concurrent_requests_share_one_build() {
        let cache = Arc::new(FilePathIndexCache::new(
            Duration::from_secs(60),
            4,
            usize::MAX,
            usize::MAX,
        ));
        let build_count = Arc::new(AtomicUsize::new(0));
        let start = Arc::new(Barrier::new(8));

        let threads: Vec<_> = (0..8)
            .map(|_| {
                let cache = Arc::clone(&cache);
                let build_count = Arc::clone(&build_count);
                let start = Arc::clone(&start);
                thread::spawn(move || {
                    start.wait();
                    cache
                        .get_or_build("/repo", &["target".to_string()], || {
                            build_count.fetch_add(1, Ordering::SeqCst);
                            thread::sleep(Duration::from_millis(40));
                            vec![entry("main.rs")]
                        })
                        .unwrap()
                })
            })
            .collect();

        for handle in threads {
            assert_eq!(handle.join().unwrap().len(), 1);
        }
        assert_eq!(build_count.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn invalidation_discards_an_in_flight_generation() {
        let cache = Arc::new(FilePathIndexCache::new(
            Duration::from_secs(60),
            4,
            usize::MAX,
            usize::MAX,
        ));
        let build_count = Arc::new(AtomicUsize::new(0));
        let first_started = Arc::new(Barrier::new(2));
        let resume_first = Arc::new(Barrier::new(2));

        let worker = {
            let cache = Arc::clone(&cache);
            let build_count = Arc::clone(&build_count);
            let first_started = Arc::clone(&first_started);
            let resume_first = Arc::clone(&resume_first);
            thread::spawn(move || {
                cache
                    .get_or_build("/repo", &[], || {
                        let build_number = build_count.fetch_add(1, Ordering::SeqCst);
                        if build_number == 0 {
                            first_started.wait();
                            resume_first.wait();
                        }
                        vec![entry("main.rs")]
                    })
                    .unwrap()
            })
        };

        first_started.wait();
        cache.invalidate_root("/repo");
        resume_first.wait();

        assert_eq!(worker.join().unwrap().len(), 1);
        assert_eq!(build_count.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn exclusion_policy_is_part_of_the_cache_key() {
        let cache = FilePathIndexCache::new(Duration::from_secs(60), 4, usize::MAX, usize::MAX);
        let build_count = AtomicUsize::new(0);

        cache
            .get_or_build("/repo", &["target".to_string()], || {
                build_count.fetch_add(1, Ordering::SeqCst);
                vec![entry("first")]
            })
            .unwrap();
        cache
            .get_or_build("/repo", &["node_modules".to_string()], || {
                build_count.fetch_add(1, Ordering::SeqCst);
                vec![entry("second")]
            })
            .unwrap();

        assert_eq!(build_count.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn failed_owner_releases_waiters_and_allows_recovery() {
        let cache = FilePathIndexCache::new(Duration::from_secs(60), 4, usize::MAX, usize::MAX);
        let failed = cache.get_or_build("/repo", &[], || panic!("boom"));
        assert!(failed.is_err());

        let recovered = cache
            .get_or_build("/repo", &[], || vec![entry("recovered")])
            .unwrap();
        assert_eq!(recovered[0].filename, "recovered");
    }

    #[test]
    fn oversized_index_is_shared_with_waiters_but_not_retained() {
        let cache = Arc::new(FilePathIndexCache::new(Duration::from_secs(60), 4, 1, 1));
        let build_count = Arc::new(AtomicUsize::new(0));
        let start = Arc::new(Barrier::new(2));

        let threads: Vec<_> = (0..2)
            .map(|_| {
                let cache = Arc::clone(&cache);
                let build_count = Arc::clone(&build_count);
                let start = Arc::clone(&start);
                thread::spawn(move || {
                    start.wait();
                    cache
                        .get_or_build("/repo", &[], || {
                            build_count.fetch_add(1, Ordering::SeqCst);
                            thread::sleep(Duration::from_millis(40));
                            vec![entry("large")]
                        })
                        .unwrap()
                })
            })
            .collect();

        for handle in threads {
            assert_eq!(handle.join().unwrap().len(), 1);
        }
        assert_eq!(build_count.load(Ordering::SeqCst), 1);

        cache
            .get_or_build("/repo", &[], || {
                build_count.fetch_add(1, Ordering::SeqCst);
                vec![entry("large")]
            })
            .unwrap();
        assert_eq!(build_count.load(Ordering::SeqCst), 2);
    }
}
