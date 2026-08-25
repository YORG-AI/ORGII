use std::borrow::Cow;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::Path;

use chrono::{DateTime, NaiveDate, NaiveDateTime, TimeZone, Utc};

use super::{
    types::{
        CursorUsageDataQuality, CursorUsageEvent, CursorUsageEventQuality,
        CursorUsageMetricQuality, CursorUsageRecordSource, CursorUsageTotals,
    },
    MAX_CURSOR_CSV_RECORD_BYTES, MAX_CURSOR_EXPORT_BYTES, MAX_CURSOR_USAGE_PAGE_SCAN_BYTES,
    MAX_CURSOR_USAGE_PAGE_SCAN_ROWS, MAX_CURSOR_USAGE_PAGE_SIZE,
};

#[derive(Debug)]
pub(super) struct ParsedCursorUsageFile {
    pub(super) data_start_offset: u64,
    pub(super) raw_bytes: u64,
    pub(super) data_quality: CursorUsageDataQuality,
    pub(super) totals: CursorUsageTotals,
}

pub(super) struct ParsedCursorUsagePage {
    pub(super) events: Vec<CursorUsageEvent>,
    pub(super) next_cursor: Option<u64>,
    pub(super) has_more: bool,
}

/// Validate and aggregate the raw export without retaining event rows.
pub(super) fn summarize_cursor_usage_file(path: &Path) -> Result<ParsedCursorUsageFile, String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("Failed to inspect Cursor usage CSV: {error}"))?;
    if !metadata.file_type().is_file() || metadata.len() > MAX_CURSOR_EXPORT_BYTES as u64 {
        return Err("Cursor usage CSV is not a bounded regular file".to_string());
    }
    let file = std::fs::File::open(path)
        .map_err(|error| format!("Failed to open Cursor usage CSV: {error}"))?;
    let mut reader = BufReader::new(file);
    let mut line = Vec::with_capacity(4096);
    if !read_bounded_csv_line(&mut reader, &mut line)? {
        return Err("Cursor usage CSV is empty".to_string());
    }
    let headers = parse_single_csv_record(&line, "header")?;
    let columns = CursorUsageColumns::from_headers(&headers)?;
    let data_start_offset = reader
        .stream_position()
        .map_err(|error| format!("Failed to locate Cursor usage CSV data: {error}"))?;
    let mut data_quality = CursorUsageDataQuality::default();
    let mut totals = CursorUsageTotals::default();

    while read_bounded_csv_line(&mut reader, &mut line)? {
        data_quality.total_rows += 1;
        let record = parse_single_csv_record(&line, "row")?;
        let Some(event) = parse_cursor_usage_record(&record, &columns) else {
            data_quality.skipped_rows += 1;
            continue;
        };
        update_data_quality(&mut data_quality, &event.quality);
        accumulate_totals(&mut totals, &event)?;
        data_quality.emitted_rows += 1;
    }

    if data_quality.total_rows > 0 && data_quality.emitted_rows == 0 {
        return Err("Cursor usage CSV contained rows but no valid billing events".to_string());
    }
    Ok(ParsedCursorUsageFile {
        data_start_offset,
        raw_bytes: metadata.len(),
        data_quality,
        totals,
    })
}

pub(super) fn read_cursor_usage_page(
    path: &Path,
    cursor: u64,
    limit: usize,
    expected_bytes: u64,
    expected_data_start: u64,
) -> Result<ParsedCursorUsagePage, String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("Failed to inspect Cursor usage cache: {error}"))?;
    if !metadata.file_type().is_file()
        || metadata.len() != expected_bytes
        || metadata.len() > MAX_CURSOR_EXPORT_BYTES as u64
    {
        return Err("Cursor usage raw cache changed or is invalid".to_string());
    }
    let file = std::fs::File::open(path)
        .map_err(|error| format!("Failed to open Cursor usage cache: {error}"))?;
    let mut reader = BufReader::new(file);
    let mut line = Vec::with_capacity(4096);
    if !read_bounded_csv_line(&mut reader, &mut line)? {
        return Err("Cursor usage CSV is empty".to_string());
    }
    let headers = parse_single_csv_record(&line, "header")?;
    let columns = CursorUsageColumns::from_headers(&headers)?;
    let actual_data_start = reader
        .stream_position()
        .map_err(|error| format!("Failed to locate Cursor usage CSV data: {error}"))?;
    if actual_data_start != expected_data_start
        || cursor < expected_data_start
        || cursor > expected_bytes
    {
        return Err("Cursor usage page cursor is outside the current raw cache".to_string());
    }
    if cursor > expected_data_start {
        reader
            .seek(SeekFrom::Start(cursor - 1))
            .map_err(|error| format!("Failed to validate Cursor usage page cursor: {error}"))?;
        let mut previous = [0_u8; 1];
        reader
            .read_exact(&mut previous)
            .map_err(|error| format!("Failed to validate Cursor usage page cursor: {error}"))?;
        if previous[0] != b'\n' {
            return Err("Cursor usage page cursor is not at a record boundary".to_string());
        }
    }
    reader
        .seek(SeekFrom::Start(cursor))
        .map_err(|error| format!("Failed to seek Cursor usage page: {error}"))?;

    let bounded_limit = limit.clamp(1, MAX_CURSOR_USAGE_PAGE_SIZE);
    let mut events = Vec::with_capacity(bounded_limit);
    let mut scanned_rows = 0_usize;
    let mut scanned_bytes = 0_usize;
    while events.len() < bounded_limit
        && scanned_rows < MAX_CURSOR_USAGE_PAGE_SCAN_ROWS
        && scanned_bytes < MAX_CURSOR_USAGE_PAGE_SCAN_BYTES
        && read_bounded_csv_line(&mut reader, &mut line)?
    {
        scanned_rows += 1;
        scanned_bytes = scanned_bytes.saturating_add(line.len());
        let record = parse_single_csv_record(&line, "page row")?;
        if let Some(event) = parse_cursor_usage_record(&record, &columns) {
            events.push(event);
        }
    }
    let next_offset = reader
        .stream_position()
        .map_err(|error| format!("Failed to locate next Cursor usage page: {error}"))?;
    let has_more = next_offset < expected_bytes;
    Ok(ParsedCursorUsagePage {
        events,
        next_cursor: has_more.then_some(next_offset),
        has_more,
    })
}

fn read_bounded_csv_line(
    reader: &mut BufReader<std::fs::File>,
    line: &mut Vec<u8>,
) -> Result<bool, String> {
    line.clear();
    loop {
        let available = reader
            .fill_buf()
            .map_err(|error| format!("Failed to read Cursor usage CSV: {error}"))?;
        if available.is_empty() {
            return Ok(!line.is_empty());
        }
        let (take, complete) = match available.iter().position(|byte| *byte == b'\n') {
            Some(position) => (position + 1, true),
            None => (available.len(), false),
        };
        if line.len().saturating_add(take) > MAX_CURSOR_CSV_RECORD_BYTES {
            return Err(format!(
                "Cursor usage CSV record exceeds the {} KiB safety limit",
                MAX_CURSOR_CSV_RECORD_BYTES / 1024
            ));
        }
        line.extend_from_slice(&available[..take]);
        reader.consume(take);
        if complete {
            return Ok(true);
        }
    }
}

fn parse_single_csv_record(bytes: &[u8], label: &str) -> Result<csv::StringRecord, String> {
    let mut reader = csv::ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .from_reader(bytes);
    let mut records = reader.records();
    let record = records
        .next()
        .ok_or_else(|| format!("Cursor usage CSV {label} is empty"))?
        .map_err(|error| format!("Invalid Cursor usage CSV {label}: {error}"))?;
    if records
        .next()
        .transpose()
        .map_err(|error| format!("Invalid Cursor usage CSV {label}: {error}"))?
        .is_some()
    {
        return Err(format!(
            "Cursor usage CSV {label} contains multiple records"
        ));
    }
    Ok(record)
}

fn parse_cursor_usage_record(
    record: &csv::StringRecord,
    column: &CursorUsageColumns,
) -> Option<CursorUsageEvent> {
    let occurred_at = field(record, column.date).trim();
    let model = field(record, column.model).trim();
    let occurred_at_ms = parse_cursor_timestamp(occurred_at)?;
    if model.is_empty() {
        return None;
    }

    let (input_tokens, input_quality) =
        parse_nonnegative_integer(field(record, column.input_without_cache_write));
    let (input_with_cache_write, input_with_cache_write_quality) =
        parse_nonnegative_integer(field(record, column.input_with_cache_write));
    let (cache_read_tokens, cache_read_quality) =
        parse_nonnegative_integer(field(record, column.cache_read));
    let (output_tokens, output_quality) = parse_nonnegative_integer(field(record, column.output));
    let (cache_write_tokens, cache_write_quality) = match (input_with_cache_write, input_tokens) {
        (Some(with_cache_write), Some(without_cache_write)) => (
            Some(with_cache_write.saturating_sub(without_cache_write)),
            CursorUsageMetricQuality::Derived,
        ),
        _ => (
            None,
            combine_unavailable_quality(input_with_cache_write_quality, input_quality),
        ),
    };
    let kind = column.kind.map(|index| field(record, index));
    let (cost_usd, cost_quality) = parse_cursor_cost(field(record, column.cost), kind);
    Some(CursorUsageEvent {
        occurred_at: occurred_at.to_string(),
        occurred_at_ms,
        model: model.to_string(),
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_write_tokens,
        cost_usd,
        source: CursorUsageRecordSource::CursorBillingExport,
        quality: CursorUsageEventQuality {
            input_tokens: input_quality,
            output_tokens: output_quality,
            cache_read_tokens: cache_read_quality,
            cache_write_tokens: cache_write_quality,
            cost_usd: cost_quality,
        },
    })
}

fn accumulate_totals(
    totals: &mut CursorUsageTotals,
    event: &CursorUsageEvent,
) -> Result<(), String> {
    add_token_total(&mut totals.input_tokens, event.input_tokens)?;
    add_token_total(&mut totals.output_tokens, event.output_tokens)?;
    add_token_total(&mut totals.cache_read_tokens, event.cache_read_tokens)?;
    add_token_total(&mut totals.cache_write_tokens, event.cache_write_tokens)?;
    if let Some(cost_usd) = event.cost_usd {
        let sum = totals.cost_usd + cost_usd;
        if !sum.is_finite() {
            return Err("Cursor usage cost total overflowed".to_string());
        }
        totals.cost_usd = sum;
        totals.exact_cost_rows += 1;
    }
    Ok(())
}

fn add_token_total(total: &mut u64, value: Option<u64>) -> Result<(), String> {
    if let Some(value) = value {
        *total = total
            .checked_add(value)
            .ok_or_else(|| "Cursor usage token total overflowed".to_string())?;
    }
    Ok(())
}

struct CursorUsageColumns {
    date: usize,
    kind: Option<usize>,
    model: usize,
    input_with_cache_write: usize,
    input_without_cache_write: usize,
    cache_read: usize,
    output: usize,
    cost: usize,
}

impl CursorUsageColumns {
    fn from_headers(headers: &csv::StringRecord) -> Result<Self, String> {
        Ok(Self {
            date: required_column(headers, &["Date"])?,
            kind: optional_column(headers, &["Kind"]),
            model: required_column(headers, &["Model"])?,
            input_with_cache_write: required_column(headers, &["Input (w/ Cache Write)"])?,
            input_without_cache_write: required_column(headers, &["Input (w/o Cache Write)"])?,
            cache_read: required_column(headers, &["Cache Read"])?,
            output: required_column(headers, &["Output Tokens"])?,
            cost: required_column(headers, &["Cost", "Cost to you"])?,
        })
    }
}

fn required_column(headers: &csv::StringRecord, names: &[&str]) -> Result<usize, String> {
    optional_column(headers, names).ok_or_else(|| {
        format!(
            "Cursor usage CSV is missing required column {}",
            names.join(" or ")
        )
    })
}

fn optional_column(headers: &csv::StringRecord, names: &[&str]) -> Option<usize> {
    headers.iter().position(|header| {
        let normalized = header.trim().trim_start_matches('\u{feff}');
        names.contains(&normalized)
    })
}

fn field(record: &csv::StringRecord, index: usize) -> &str {
    record.get(index).unwrap_or_default()
}

fn parse_nonnegative_integer(value: &str) -> (Option<u64>, CursorUsageMetricQuality) {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return (None, CursorUsageMetricQuality::Missing);
    }
    let normalized = remove_numeric_commas(trimmed);
    match normalized.parse::<u64>() {
        Ok(value) => (Some(value), CursorUsageMetricQuality::Exact),
        Err(_) => (None, CursorUsageMetricQuality::Invalid),
    }
}

fn parse_cursor_cost(value: &str, kind: Option<&str>) -> (Option<f64>, CursorUsageMetricQuality) {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return (None, CursorUsageMetricQuality::Missing);
    }
    if trimmed.eq_ignore_ascii_case("included") {
        return (None, CursorUsageMetricQuality::Included);
    }
    if trimmed == "-" || kind.is_some_and(|kind| kind.to_ascii_lowercase().contains("no charge")) {
        return (None, CursorUsageMetricQuality::NoCharge);
    }
    let without_currency = trimmed.strip_prefix('$').unwrap_or(trimmed);
    let normalized = remove_numeric_commas(without_currency);
    match normalized.parse::<f64>() {
        Ok(cost) if cost.is_finite() && cost >= 0.0 => {
            (Some(cost), CursorUsageMetricQuality::Exact)
        }
        _ => (None, CursorUsageMetricQuality::Invalid),
    }
}

fn remove_numeric_commas(value: &str) -> Cow<'_, str> {
    if value.contains(',') {
        Cow::Owned(value.replace(',', ""))
    } else {
        Cow::Borrowed(value)
    }
}

fn combine_unavailable_quality(
    left: CursorUsageMetricQuality,
    right: CursorUsageMetricQuality,
) -> CursorUsageMetricQuality {
    if matches!(left, CursorUsageMetricQuality::Invalid)
        || matches!(right, CursorUsageMetricQuality::Invalid)
    {
        CursorUsageMetricQuality::Invalid
    } else {
        CursorUsageMetricQuality::Missing
    }
}

fn update_data_quality(summary: &mut CursorUsageDataQuality, quality: &CursorUsageEventQuality) {
    let values = [
        quality.input_tokens,
        quality.output_tokens,
        quality.cache_read_tokens,
        quality.cache_write_tokens,
        quality.cost_usd,
    ];
    let missing = values
        .iter()
        .filter(|value| matches!(value, CursorUsageMetricQuality::Missing))
        .count();
    let invalid = values
        .iter()
        .filter(|value| matches!(value, CursorUsageMetricQuality::Invalid))
        .count();
    summary.missing_metric_values += missing;
    summary.invalid_metric_values += invalid;
    if missing == 0 && invalid == 0 && quality.cost_usd == CursorUsageMetricQuality::Exact {
        summary.complete_rows += 1;
    } else {
        summary.partial_rows += 1;
    }
}

fn parse_cursor_timestamp(value: &str) -> Option<i64> {
    if let Ok(timestamp) = DateTime::parse_from_rfc3339(value) {
        return Some(timestamp.timestamp_millis());
    }
    for format in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%dT%H:%M:%S"] {
        if let Ok(timestamp) = NaiveDateTime::parse_from_str(value, format) {
            return Some(Utc.from_utc_datetime(&timestamp).timestamp_millis());
        }
    }
    NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .ok()
        .and_then(|date| date.and_hms_opt(12, 0, 0))
        .map(|timestamp| Utc.from_utc_datetime(&timestamp).timestamp_millis())
}
