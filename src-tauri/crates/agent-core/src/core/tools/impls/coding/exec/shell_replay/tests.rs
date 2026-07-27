//! Unit tests for the shell replay writer, recovery, range reader, and
//! session cleanup pipeline.

use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{Seek, SeekFrom, Write};

use core_types::session_event::ShellReplayStatus;
use rusqlite::params;

use super::active::active_registry_retained_bytes;
use super::range::{load_row, parse_status, read_range};
use super::recovery::recover_incomplete_replays_at;
use super::writer::{retry_exact_event_publish, BoundedTerminalText};
use super::*;

fn with_test_home<T>(test: impl FnOnce(&Path) -> T) -> T {
    let sandbox = test_helpers::test_env::sandbox();
    let conn = database::db::get_connection().unwrap();
    database::init_shell_replay_tables(&conn).unwrap();
    test(sandbox.path())
}

fn append_payload(writer: &mut ShellReplayWriter, total: usize, chunk_size: usize) {
    let chunk = vec![b'r'; chunk_size];
    let mut remaining = total;
    while remaining > 0 {
        let count = remaining.min(chunk.len());
        writer
            .append(ShellReplayStream::Stdout, &chunk[..count])
            .unwrap();
        remaining -= count;
    }
}

#[cfg(unix)]
fn peak_rss_bytes() -> usize {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::zeroed();
    let rc = unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) };
    assert_eq!(rc, 0, "getrusage failed");
    let rss = unsafe { usage.assume_init() }.ru_maxrss as usize;
    #[cfg(target_os = "macos")]
    {
        rss
    }
    #[cfg(not(target_os = "macos"))]
    {
        rss.saturating_mul(1024)
    }
}

#[test]
#[serial_test::serial]
fn writer_preserves_complete_bytes_and_bounds_preview_and_summary() {
    with_test_home(|home| {
        let root = home.join("replays");
        let target = ShellReplayTarget::new("session-a", "call-a");
        let mut writer =
            ShellReplayWriter::create(&root, target.clone(), "emit", home, None).unwrap();
        let chunk = vec![b'x'; 1024];
        for _ in 0..1024 {
            writer.append(ShellReplayStream::Stdout, &chunk).unwrap();
        }
        writer.flush_running_state().unwrap();
        assert!(writer.preview.len() <= SHELL_REPLAY_PREVIEW_BYTES);
        assert!(writer.summary().len() <= 32 * 1024);
        let summary = writer.finalize(ShellReplayStatus::Complete, None).unwrap();
        assert!(summary.contains("bytes omitted"));

        let range = read_range(
            &root,
            "session-a",
            "call-a",
            u64::MAX,
            u64::MAX,
            0,
            SHELL_REPLAY_RANGE_MAX_BYTES as u64,
        )
        .unwrap();
        assert_eq!(range.next_offset_bytes, SHELL_REPLAY_RANGE_MAX_BYTES as u64);
        assert!(!range.eof);
        assert_eq!(
            range
                .frames
                .iter()
                .map(|frame| frame.text.len())
                .sum::<usize>(),
            SHELL_REPLAY_RANGE_MAX_BYTES
        );
    });
}

#[test]
#[serial_test::serial]
fn range_clamps_future_sequence_and_bytes() {
    with_test_home(|home| {
        let root = home.join("replays");
        let target = ShellReplayTarget::new("session-b", "call-b");
        let mut writer = ShellReplayWriter::create(&root, target, "emit", home, None).unwrap();
        writer
            .append(ShellReplayStream::Stdout, b"EARLY\n")
            .unwrap();
        let early_bytes = writer.total_bytes;
        writer
            .append(ShellReplayStream::Stdout, b"FUTURE\n")
            .unwrap();
        writer.finalize(ShellReplayStatus::Complete, None).unwrap();

        let range = read_range(&root, "session-b", "call-b", 1, early_bytes, 0, 1024).unwrap();
        let text: String = range.frames.into_iter().map(|frame| frame.text).collect();
        assert_eq!(text, "EARLY\n");
        assert!(!text.contains("FUTURE"));
    });
}

#[test]
fn summary_is_exact_before_truncation_and_utf8_prefix_carries_split_codepoint() {
    let mut summary = BoundedTerminalText::default();
    let exact = "中🙂".repeat(3_000);
    summary.append(ShellReplayStream::Stdout, exact.as_bytes());
    assert_eq!(summary.render(), exact);
    assert!(!summary.render().contains("bytes omitted"));

    let emoji = "🙂".as_bytes();
    let mut first_read = vec![b'x'; 16 * 1024 - 2];
    first_read.extend_from_slice(&emoji[..2]);
    assert_eq!(first_read.len(), 16 * 1024);
    assert_eq!(complete_utf8_prefix_len(&first_read), 16 * 1024 - 2);
    let mut carry = first_read.split_off(16 * 1024 - 2);
    carry.extend_from_slice(&emoji[2..]);
    assert_eq!(complete_utf8_prefix_len(&carry), emoji.len());
    assert_eq!(std::str::from_utf8(&carry).unwrap(), "🙂");
}

#[test]
fn exact_event_publish_retries_writer_before_event_insertion_race() {
    let target = ShellReplayTarget::new("session-race", "call-race");
    let mut attempts = 0;
    retry_exact_event_publish(&target, || {
        attempts += 1;
        Ok((attempts >= 3).then(|| "tool-call-call-race".to_string()))
    })
    .unwrap();
    assert_eq!(attempts, 3);
}

#[test]
fn unknown_manifest_status_is_not_treated_as_running() {
    assert_eq!(parse_status("running").unwrap(), ShellReplayStatus::Running);
    assert!(parse_status("future-corrupt-value").is_err());
}

#[test]
#[serial_test::serial]
fn ansi_csi_split_is_carried_into_the_next_frame() {
    with_test_home(|home| {
        let root = home.join("replays");
        let mut writer = ShellReplayWriter::create(
            &root,
            ShellReplayTarget::new("session-ansi", "call-ansi"),
            "emit ansi",
            home,
            None,
        )
        .unwrap();

        let mut first_read = vec![b'x'; SHELL_REPLAY_FRAME_MAX_BYTES - 2];
        first_read.extend_from_slice(b"\x1b[");
        let first_prefix = complete_terminal_prefix_len(&first_read);
        assert_eq!(first_prefix, SHELL_REPLAY_FRAME_MAX_BYTES - 2);
        writer
            .append(ShellReplayStream::Stdout, &first_read[..first_prefix])
            .unwrap();

        let mut next_frame = first_read[first_prefix..].to_vec();
        next_frame.extend_from_slice(b"31mRED");
        assert_eq!(complete_terminal_prefix_len(&next_frame), next_frame.len());
        writer
            .append(ShellReplayStream::Stdout, &next_frame)
            .unwrap();
        let bookmark = writer
            .state(ShellReplayStatus::Complete, None, None)
            .bookmark;
        writer.finalize(ShellReplayStatus::Complete, None).unwrap();

        let range = read_range(
            &root,
            "session-ansi",
            "call-ansi",
            bookmark.visible_through_sequence,
            bookmark.visible_bytes,
            first_prefix as u64,
            64,
        )
        .unwrap();
        assert_eq!(range.frames.len(), 1);
        assert_eq!(range.frames[0].text, "\x1b[31mRED");
        assert!(!range.frames[0].text.starts_with("[31m"));
    });
}

#[test]
#[serial_test::serial]
fn range_aligns_to_complete_sequence_and_never_splits_emoji() {
    with_test_home(|home| {
        let root = home.join("replays");
        let target = ShellReplayTarget::new("session-utf8", "call-utf8");
        let mut writer =
            ShellReplayWriter::create(&root, target, "emit utf8", home, None).unwrap();
        let text = format!("{}🙂END", "x".repeat(1_000));
        let append = writer
            .append(ShellReplayStream::Stdout, text.as_bytes())
            .unwrap();
        writer.finalize(ShellReplayStatus::Complete, None).unwrap();

        // Both the requested offset and limit land inside this frame. The
        // response aligns back and returns the one complete sequence.
        let range = read_range(
            &root,
            "session-utf8",
            "call-utf8",
            append.sequence,
            append.persisted_bytes,
            1_002,
            1,
        )
        .unwrap();
        assert_eq!(range.frames.len(), 1);
        assert_eq!(range.frames[0].sequence, append.sequence);
        assert_eq!(range.frames[0].byte_start, 0);
        assert_eq!(range.frames[0].text, text);
        assert!(!range.frames[0].text.contains('\u{fffd}'));
    });
}

#[test]
#[serial_test::serial]
fn bounded_preview_and_summary_trim_only_utf8_edges() {
    with_test_home(|home| {
        let root = home.join("replays");
        let mut writer = ShellReplayWriter::create(
            &root,
            ShellReplayTarget::new("session-preview-utf8", "call-preview-utf8"),
            "emit utf8",
            home,
            None,
        )
        .unwrap();
        for _ in 0..10_000 {
            writer
                .append(ShellReplayStream::Stdout, "汉🙂".as_bytes())
                .unwrap();
        }
        let active = active_state("session-preview-utf8", "call-preview-utf8").unwrap();
        assert!(active.terminal_preview.len() <= SHELL_REPLAY_PREVIEW_BYTES);
        assert!(!active.terminal_preview.contains('\u{fffd}'));
        assert!(!writer.summary().contains('\u{fffd}'));
        writer.finalize(ShellReplayStatus::Complete, None).unwrap();
        let row = load_row("session-preview-utf8", "call-preview-utf8")
            .unwrap()
            .unwrap();
        assert!(row.meta.terminal_preview.len() <= SHELL_REPLAY_PREVIEW_BYTES);
        assert!(!row.meta.terminal_preview.contains('\u{fffd}'));
    });
}

#[test]
#[serial_test::serial]
fn invalid_utf8_cannot_expand_serialized_preview_summary_or_range_budget() {
    with_test_home(|home| {
        let root = home.join("replays");
        let mut writer = ShellReplayWriter::create(
            &root,
            ShellReplayTarget::new("session-invalid-utf8", "call-invalid-utf8"),
            "emit bytes",
            home,
            None,
        )
        .unwrap();
        for _ in 0..8 {
            writer
                .append(
                    ShellReplayStream::Stdout,
                    &vec![0xff; SHELL_REPLAY_FRAME_MAX_BYTES],
                )
                .unwrap();
        }
        let active = active_state("session-invalid-utf8", "call-invalid-utf8").unwrap();
        assert!(active.terminal_preview.len() <= SHELL_REPLAY_PREVIEW_BYTES);
        assert!(writer.summary().len() <= SHELL_REPLAY_SUMMARY_MAX_BYTES);
        writer.finalize(ShellReplayStatus::Complete, None).unwrap();
        let row = load_row("session-invalid-utf8", "call-invalid-utf8")
            .unwrap()
            .unwrap();
        assert!(row.meta.terminal_preview.len() <= SHELL_REPLAY_PREVIEW_BYTES);
        let range = read_range(
            &root,
            "session-invalid-utf8",
            "call-invalid-utf8",
            row.meta.last_sequence,
            row.meta.total_bytes,
            0,
            SHELL_REPLAY_RANGE_MAX_BYTES as u64,
        )
        .unwrap();
        assert!(
            range
                .frames
                .iter()
                .map(|frame| frame.text.len())
                .sum::<usize>()
                <= SHELL_REPLAY_RANGE_MAX_BYTES
        );
        assert!(!range.eof);
        assert!(range.next_offset_bytes > 0);
        assert!(range.next_offset_bytes < row.meta.total_bytes);
    });
}

#[test]
#[serial_test::serial]
fn tail_range_alignment_still_reaches_bookmark_and_tail_sentinel() {
    with_test_home(|home| {
        let root = home.join("replays");
        let mut writer = ShellReplayWriter::create(
            &root,
            ShellReplayTarget::new("session-tail", "call-tail"),
            "emit tail",
            home,
            None,
        )
        .unwrap();
        for _ in 0..20 {
            writer
                .append(ShellReplayStream::Stdout, &vec![b'x'; 16 * 1024])
                .unwrap();
        }
        writer
            .append(ShellReplayStream::Stdout, b"TAIL_SENTINEL")
            .unwrap();
        let visible_bytes = writer.total_bytes;
        let visible_sequence = writer.last_sequence;
        writer.finalize(ShellReplayStatus::Complete, None).unwrap();

        let offset = visible_bytes
            .saturating_sub(SHELL_REPLAY_RANGE_MAX_BYTES as u64)
            .saturating_add(1);
        let range = read_range(
            &root,
            "session-tail",
            "call-tail",
            visible_sequence,
            visible_bytes,
            offset,
            SHELL_REPLAY_RANGE_MAX_BYTES as u64,
        )
        .unwrap();
        assert!(range.eof);
        assert_eq!(range.next_offset_bytes, visible_bytes);
        assert!(range
            .frames
            .last()
            .is_some_and(|frame| frame.text == "TAIL_SENTINEL"));
        assert!(
            range
                .frames
                .iter()
                .map(|frame| frame.byte_end - frame.byte_start)
                .sum::<u64>()
                <= SHELL_REPLAY_RANGE_MAX_BYTES as u64
        );
    });
}

#[test]
#[serial_test::serial]
fn active_registry_is_exact_per_append_and_clears_only_on_finalize() {
    with_test_home(|home| {
        let root = home.join("replays");
        let target = ShellReplayTarget::new("session-active", "call-active");
        let mut writer =
            ShellReplayWriter::create(&root, target.clone(), "emit", home, None).unwrap();
        let initial = active_states_for_session("session-active");
        assert_eq!(initial["call-active"].bookmark.visible_bytes, 0);

        writer.append(ShellReplayStream::Stdout, b"first").unwrap();
        let after_first = active_state("session-active", "call-active").unwrap();
        assert_eq!(after_first.bookmark.visible_through_sequence, 1);
        assert_eq!(after_first.bookmark.visible_bytes, 5);
        assert_eq!(after_first.terminal_preview, "first");

        // Dropping consumer snapshots cannot own or erase writer state.
        drop(initial);
        drop(after_first);
        writer.append(ShellReplayStream::Stderr, b"second").unwrap();
        let latest = active_state("session-active", "call-active").unwrap();
        assert_eq!(latest.bookmark.visible_through_sequence, 2);
        assert_eq!(latest.bookmark.visible_bytes, 11);
        assert!(latest.terminal_preview.ends_with("[stderr] second"));

        writer.finalize(ShellReplayStatus::Complete, None).unwrap();
        assert!(active_state("session-active", "call-active").is_none());
    });
}

#[test]
#[serial_test::serial]
fn startup_recovery_truncates_torn_frame_rebuilds_pages_and_marks_incomplete() {
    with_test_home(|home| {
        let root = home.join("replays");
        let target = ShellReplayTarget::new("session-recover", "call-recover");
        let path = {
            let mut writer =
                ShellReplayWriter::create(&root, target.clone(), "emit", home, None).unwrap();
            writer
                .append(ShellReplayStream::Stdout, b"line-one\n")
                .unwrap();
            writer.flush_running_state().unwrap();
            writer.path().to_path_buf()
        };
        let valid_len = fs::metadata(&path).unwrap().len();
        OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(&[7u8; 9])
            .unwrap();

        assert_eq!(recover_incomplete_replays_at(&root).unwrap(), 1);
        assert_eq!(fs::metadata(&path).unwrap().len(), valid_len);
        let row = load_row("session-recover", "call-recover")
            .unwrap()
            .unwrap();
        assert_eq!(row.meta.status, ShellReplayStatus::Incomplete);
        assert_eq!(row.meta.total_bytes, 9);
        assert_eq!(row.meta.last_sequence, 1);
        assert!(row.meta.error.unwrap().contains("truncated"));
        assert!(active_state("session-recover", "call-recover").is_none());

        let conn = database::db::get_connection().unwrap();
        let page: (u64, u64) = conn
            .query_row(
                "SELECT last_sequence, line_count FROM shell_replay_pages
                 WHERE session_id = ?1 AND call_id = ?2 AND page_index = 0",
                params!["session-recover", "call-recover"],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(page, (1, 1));
    });
}

#[test]
#[serial_test::serial]
fn oversized_frame_is_rejected_and_corrupt_length_is_never_allocated() {
    with_test_home(|home| {
        let root = home.join("replays");
        let target = ShellReplayTarget::new("session-corrupt-length", "call-corrupt-length");
        let path = {
            let mut writer =
                ShellReplayWriter::create(&root, target, "emit", home, None).unwrap();
            let oversized = vec![b'x'; SHELL_REPLAY_FRAME_MAX_BYTES + 1];
            assert!(writer
                .append(ShellReplayStream::Stdout, &oversized)
                .unwrap_err()
                .contains("frame limit"));
            assert_eq!(writer.last_sequence, 0);
            assert_eq!(writer.total_bytes, 0);

            writer.append(ShellReplayStream::Stdout, b"valid").unwrap();
            writer.flush_running_state().unwrap();
            writer.path().to_path_buf()
        };
        let valid_len = fs::metadata(&path).unwrap().len();
        let mut corrupt = OpenOptions::new().append(true).open(&path).unwrap();
        corrupt.write_all(&2u64.to_le_bytes()).unwrap();
        corrupt.write_all(&0i64.to_le_bytes()).unwrap();
        corrupt
            .write_all(&[ShellReplayStream::Stdout.as_byte()])
            .unwrap();
        corrupt.write_all(&u32::MAX.to_le_bytes()).unwrap();
        corrupt.flush().unwrap();

        assert_eq!(recover_incomplete_replays_at(&root).unwrap(), 1);
        assert_eq!(fs::metadata(&path).unwrap().len(), valid_len);
        let row = load_row("session-corrupt-length", "call-corrupt-length")
            .unwrap()
            .unwrap();
        assert_eq!(row.meta.status, ShellReplayStatus::Incomplete);
        assert_eq!(row.meta.total_bytes, 5);
        assert!(row.meta.error.unwrap().contains("frame length"));
    });
}

#[test]
#[serial_test::serial]
fn range_rejects_corrupt_length_before_payload_allocation() {
    with_test_home(|home| {
        let root = home.join("replays");
        let mut writer = ShellReplayWriter::create(
            &root,
            ShellReplayTarget::new("session-range-corrupt", "call-range-corrupt"),
            "emit",
            home,
            None,
        )
        .unwrap();
        writer.append(ShellReplayStream::Stdout, b"valid").unwrap();
        let path = writer.path().to_path_buf();
        writer.finalize(ShellReplayStatus::Complete, None).unwrap();

        let mut file = OpenOptions::new().write(true).open(&path).unwrap();
        file.seek(SeekFrom::Start((FILE_MAGIC.len() + 17) as u64))
            .unwrap();
        file.write_all(&u32::MAX.to_le_bytes()).unwrap();
        file.sync_all().unwrap();

        let error = read_range(
            &root,
            "session-range-corrupt",
            "call-range-corrupt",
            u64::MAX,
            u64::MAX,
            0,
            64,
        )
        .unwrap_err();
        assert!(error.contains("invalid shell replay frame length"));
    });
}

#[test]
#[serial_test::serial]
fn range_rejects_zero_length_and_non_consecutive_sequences() {
    with_test_home(|home| {
        let root = home.join("replays");
        let mut writer = ShellReplayWriter::create(
            &root,
            ShellReplayTarget::new("session-range-structure", "call-range-structure"),
            "emit",
            home,
            None,
        )
        .unwrap();
        writer.append(ShellReplayStream::Stdout, b"a").unwrap();
        writer.append(ShellReplayStream::Stdout, b"b").unwrap();
        let path = writer.path().to_path_buf();
        writer.finalize(ShellReplayStatus::Complete, None).unwrap();

        let mut file = OpenOptions::new().write(true).open(&path).unwrap();
        file.seek(SeekFrom::Start((FILE_MAGIC.len() + 17) as u64))
            .unwrap();
        file.write_all(&0u32.to_le_bytes()).unwrap();
        file.sync_all().unwrap();
        let zero_error = read_range(
            &root,
            "session-range-structure",
            "call-range-structure",
            u64::MAX,
            u64::MAX,
            0,
            64,
        )
        .unwrap_err();
        assert!(zero_error.contains("frame length 0"));

        file.seek(SeekFrom::Start((FILE_MAGIC.len() + 17) as u64))
            .unwrap();
        file.write_all(&1u32.to_le_bytes()).unwrap();
        let second_sequence_offset = FILE_MAGIC.len() + FRAME_HEADER_BYTES + 1;
        file.seek(SeekFrom::Start(second_sequence_offset as u64))
            .unwrap();
        file.write_all(&1u64.to_le_bytes()).unwrap();
        file.sync_all().unwrap();
        let sequence_error = read_range(
            &root,
            "session-range-structure",
            "call-range-structure",
            u64::MAX,
            u64::MAX,
            0,
            64,
        )
        .unwrap_err();
        assert!(sequence_error.contains("strictly consecutive"));
    });
}

#[test]
#[serial_test::serial]
fn repeated_ten_megabyte_runs_have_constant_retained_allocator_budget() {
    with_test_home(|home| {
        const TEN_MIB: usize = 10 * 1024 * 1024;
        const MAX_ALLOWED_RETAINED_DELTA: usize = 64 * 1024 * 1024;
        const {
            assert!(super::super::subprocess::ESTIMATED_RETAINED_OUTPUT_BYTES <= 512 * 1024);
        }

        let active_before = active_registry_retained_bytes();
        let mut observed_writer_capacity = HashMap::new();
        for (run, chunk_size) in [100usize, 1_024, 100, 1_024].into_iter().enumerate() {
            let root = home.join("replays");
            let call_id = format!("call-memory-{run}");
            let target = ShellReplayTarget::new("session-memory", &call_id);
            let mut writer =
                ShellReplayWriter::create(&root, target, "emit 10MiB", home, None).unwrap();
            let chunk = vec![b'm'; chunk_size];
            let mut remaining = TEN_MIB;
            while remaining > 0 {
                let count = remaining.min(chunk.len());
                writer
                    .append(ShellReplayStream::Stdout, &chunk[..count])
                    .unwrap();
                remaining -= count;
            }
            assert_eq!(writer.total_bytes, TEN_MIB as u64);
            assert!(writer.preview.len() <= SHELL_REPLAY_PREVIEW_BYTES);
            let retained = writer.retained_capacity_bytes();
            match observed_writer_capacity.insert(chunk_size, retained) {
                Some(previous) => assert_eq!(
                    retained, previous,
                    "retained capacity grew across repeated {chunk_size}-byte runs"
                ),
                None => assert!(retained <= 160 * 1024),
            }
            writer.finalize(ShellReplayStatus::Complete, None).unwrap();
            assert!(active_state("session-memory", &call_id).is_none());
            let row = load_row("session-memory", &call_id).unwrap().unwrap();
            assert_eq!(row.meta.total_bytes, TEN_MIB as u64);
            assert_eq!(row.meta.terminal_preview.len(), SHELL_REPLAY_PREVIEW_BYTES);
        }
        let active_after = active_registry_retained_bytes();
        let isolated_allocator_delta = active_after.saturating_sub(active_before);
        assert!(
            isolated_allocator_delta <= MAX_ALLOWED_RETAINED_DELTA,
            "retained allocator delta was {isolated_allocator_delta} bytes"
        );
        assert_eq!(isolated_allocator_delta, 0);
    });
}

#[cfg(unix)]
#[test]
#[serial_test::serial]
#[ignore = "serial OS RSS stress; run explicitly for #425 memory acceptance"]
fn shell_replay_rss_plateau_after_ten_megabyte_warmup() {
    with_test_home(|home| {
        const TEN_MIB: usize = 10 * 1024 * 1024;
        let root = home.join("replays");

        let mut warmup = ShellReplayWriter::create(
            &root,
            ShellReplayTarget::new("session-rss", "call-rss-warmup"),
            "warm up allocator",
            home,
            None,
        )
        .unwrap();
        append_payload(&mut warmup, TEN_MIB, 1_024);
        warmup.finalize(ShellReplayStatus::Complete, None).unwrap();
        let warm_peak = peak_rss_bytes();

        for (run, chunk_size) in [100usize, 1_024, 100, 1_024].into_iter().enumerate() {
            let mut writer = ShellReplayWriter::create(
                &root,
                ShellReplayTarget::new("session-rss", format!("call-rss-{run}")),
                "stress allocator",
                home,
                None,
            )
            .unwrap();
            append_payload(&mut writer, TEN_MIB, chunk_size);
            writer.finalize(ShellReplayStatus::Complete, None).unwrap();
        }
        let final_peak = peak_rss_bytes();
        let delta = final_peak.saturating_sub(warm_peak);
        eprintln!(
            "shell replay RSS: warm_peak={warm_peak} final_peak={final_peak} delta={delta}"
        );
        assert!(
            delta <= 64 * 1024 * 1024,
            "RSS grew by {delta} bytes after warmup"
        );
    });
}

#[test]
#[serial_test::serial]
fn concurrent_replays_keep_independent_bounded_state() {
    with_test_home(|home| {
        let root = home.join("replays");
        let mut writers = Vec::new();
        for index in 0..4 {
            let call_id = format!("call-concurrent-{index}");
            let mut writer = ShellReplayWriter::create(
                &root,
                ShellReplayTarget::new("session-concurrent", &call_id),
                "emit",
                home,
                None,
            )
            .unwrap();
            writer
                .append(ShellReplayStream::Stdout, &vec![b'c'; 1_024])
                .unwrap();
            writers.push(writer);
        }
        let active = active_states_for_session("session-concurrent");
        assert_eq!(active.len(), 4);
        assert!(active.values().all(|state| {
            state.bookmark.visible_through_sequence == 1
                && state.bookmark.visible_bytes == 1_024
                && state.terminal_preview.len() == 1_024
        }));
        assert!(
            writers
                .iter()
                .map(ShellReplayWriter::retained_capacity_bytes)
                .sum::<usize>()
                + active_registry_retained_bytes()
                <= 4 * 160 * 1024
        );
        for writer in writers {
            writer.finalize(ShellReplayStatus::Complete, None).unwrap();
        }
        assert!(active_states_for_session("session-concurrent").is_empty());
    });
}

#[test]
#[serial_test::serial]
fn explicit_delete_removes_only_safe_session_directory_and_manifest() {
    with_test_home(|home| {
        let root = resolve_replay_root();
        let session_id = "../session-delete";
        let target = ShellReplayTarget::new(session_id, "call-delete");
        let mut writer = ShellReplayWriter::create(&root, target, "emit", home, None).unwrap();
        writer
            .append(ShellReplayStream::Stdout, b"delete me")
            .unwrap();
        let artifact = writer.path().to_path_buf();
        let session_dir = artifact.parent().unwrap().to_path_buf();
        writer.finalize(ShellReplayStatus::Complete, None).unwrap();
        assert!(artifact.exists());

        remove_session_replays(session_id).unwrap();
        assert!(!artifact.exists());
        assert!(!session_dir.exists());
        assert!(load_row(session_id, "call-delete").unwrap().is_none());
        assert!(root.exists());
    });
}

#[test]
#[serial_test::serial]
fn explicit_delete_refuses_active_writer_without_erasing_manifest() {
    with_test_home(|home| {
        let root = resolve_replay_root();
        let session_id = "session-delete-active";
        let mut writer = ShellReplayWriter::create(
            &root,
            ShellReplayTarget::new(session_id, "call-delete-active"),
            "emit",
            home,
            None,
        )
        .unwrap();
        writer.append(ShellReplayStream::Stdout, b"live").unwrap();
        let artifact = writer.path().to_path_buf();

        let error = remove_session_replays(session_id).unwrap_err();
        assert!(error.contains("calls are active"));
        assert!(artifact.exists());
        assert!(load_row(session_id, "call-delete-active")
            .unwrap()
            .is_some());

        writer.finalize(ShellReplayStatus::Complete, None).unwrap();
        remove_session_replays(session_id).unwrap();
    });
}

#[test]
#[serial_test::serial]
fn file_delete_failure_preserves_manifest_for_retry() {
    with_test_home(|home| {
        let root = resolve_replay_root();
        let session_id = "session-delete-failure";
        let mut writer = ShellReplayWriter::create(
            &root,
            ShellReplayTarget::new(session_id, "call-delete-failure"),
            "emit",
            home,
            None,
        )
        .unwrap();
        writer.append(ShellReplayStream::Stdout, b"data").unwrap();
        let artifact = writer.path().to_path_buf();
        writer.finalize(ShellReplayStatus::Complete, None).unwrap();

        fs::remove_file(&artifact).unwrap();
        fs::create_dir(&artifact).unwrap();
        let error = remove_session_replays(session_id).unwrap_err();
        assert!(error.contains("delete shell replay"));
        assert!(load_row(session_id, "call-delete-failure")
            .unwrap()
            .is_some());
        let conn = database::db::get_connection().unwrap();
        let queued: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM shell_replay_cleanup_jobs WHERE session_id = ?1",
                [session_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(queued, 1);

        fs::remove_dir(&artifact).unwrap();
        assert_eq!(retry_pending_replay_cleanups().unwrap(), (1, 0));
        assert!(load_row(session_id, "call-delete-failure")
            .unwrap()
            .is_none());
    });
}

#[test]
#[serial_test::serial]
fn startup_cleanup_waits_until_the_owning_session_row_is_gone() {
    with_test_home(|home| {
        let root = resolve_replay_root();
        let session_id = "session-delete-crash-window";
        let mut writer = ShellReplayWriter::create(
            &root,
            ShellReplayTarget::new(session_id, "call-delete-crash-window"),
            "emit",
            home,
            None,
        )
        .unwrap();
        writer
            .append(ShellReplayStream::Stdout, b"keep until delete")
            .unwrap();
        let artifact = writer.path().to_path_buf();
        writer.finalize(ShellReplayStatus::Complete, None).unwrap();

        let conn = database::db::get_connection().unwrap();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS agent_sessions (
                session_id TEXT PRIMARY KEY
             );",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO agent_sessions (session_id) VALUES (?1)",
            [session_id],
        )
        .unwrap();
        queue_session_replay_cleanup(session_id).unwrap();

        assert_eq!(retry_pending_replay_cleanups().unwrap(), (0, 0));
        assert!(artifact.exists());

        conn.execute(
            "DELETE FROM agent_sessions WHERE session_id = ?1",
            [session_id],
        )
        .unwrap();
        assert_eq!(retry_pending_replay_cleanups().unwrap(), (1, 0));
        assert!(!artifact.exists());
        assert!(load_row(session_id, "call-delete-crash-window")
            .unwrap()
            .is_none());
    });
}
