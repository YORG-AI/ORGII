use crate::process_metrics::*;

#[test]
fn test_get_process_metrics() {
    let metrics = get_process_metrics();

    // Should have valid PID
    assert!(metrics.pid > 0);

    // Memory should be positive
    assert!(metrics.memory_rss_mb > 0.0);

    // Name should not be empty
    assert!(!metrics.name.is_empty());
}

#[test]
fn test_get_memory_usage() {
    let metrics = get_memory_usage();
    assert!(metrics.rss_mb > 0.0);
}

#[test]
fn test_get_system_memory() {
    let metrics = get_system_memory();
    assert!(metrics.total_mb >= 0.0);
    assert!(metrics.available_mb >= 0.0);
    assert!(metrics.used_mb >= 0.0);
}

#[test]
fn test_get_memory_breakdown() {
    let breakdown = get_memory_breakdown();
    assert!(breakdown.backend_rss_mb > 0.0);
    assert!(breakdown.tracked_backend_mb >= 0.0);
    assert!(breakdown.file_cache_mb >= 0.0);
}
