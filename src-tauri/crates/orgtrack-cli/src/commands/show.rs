use super::*;

pub(crate) fn cmd_show(
    opts: &Options,
    plugins: &[LoaderPlugin],
    processors: &[ProcessorPlugin],
    formatters: &[FormatterPlugin],
) -> Result<(), String> {
    let Some(session_id) = opts.positionals.first().cloned() else {
        return Err("show needs a session id, e.g. `orgtrack show claude_code-<uuid>`".into());
    };
    let target = db_target(opts)?;
    if !opts.no_scan {
        scan_all(&target.path, opts, plugins);
    }
    let mut conn = open_conn(&target.path)?;

    // Canonical built-in prefixes always take the compact replay path. A
    // third-party plugin cannot shadow one and accidentally re-enable a full
    // provider transcript load.
    if let Some(source) = replay_router::source_for_session(&session_id) {
        if let Some(formatter) = formatter_for(opts, formatters) {
            eprintln!(
                "orgtrack: custom show formatters receive bounded compact pages; deferred payloads remain previews"
            );
            return stream_builtin_show_template(
                &mut conn,
                &session_id,
                source.as_str(),
                opts,
                processors,
                formatter,
            );
        }
        return stream_builtin_show(&mut conn, &session_id, source, opts, processors);
    }

    // Plugin loaders are an explicit third-party compatibility boundary. They
    // may return a Vec because their protocol is a single JSON response, but no
    // built-in source can reach this branch.
    let chunks = load_plugin_session_chunks(&conn, &session_id, plugins, opts.timeout())?
        .ok_or_else(|| {
            format!("'{session_id}' is not a known imported session id (nothing to show)")
        })?;
    let source = source_of_session(&session_id, plugins);
    let chunks = apply_chunk_processors(&session_id, &source, chunks, processors, opts.timeout());

    if let Some(formatter) = formatter_for(opts, formatters) {
        let context = serde_json::json!({
            "command": "show",
            "sessionId": session_id,
            "chunks": chunks,
        });
        return render_template(formatter, &context);
    }
    match opts.format()? {
        Format::Json => println!("{}", to_json(&chunks)?),
        Format::Md => print!("{}", render_show_md(&session_id, &chunks)),
        Format::Csv => print!("{}", render_show_csv(&chunks)),
        Format::Table => {
            println!("Session {session_id} — {} activity chunks\n", chunks.len());
            for chunk in &chunks {
                let label = if chunk.function.is_empty() {
                    chunk.action_type.clone()
                } else {
                    format!("{}:{}", chunk.action_type, chunk.function)
                };
                println!("[{}] {}", truncate(&chunk.created_at, 19), label);
                if let Some(text) = preview_of(&chunk.args).or_else(|| preview_of(&chunk.result)) {
                    println!("    {}", truncate(&text, 160));
                }
            }
        }
    }
    Ok(())
}

const SHOW_PAGE_EVENTS: usize = 64;
const SHOW_PAGE_IPC_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct StreamedShowSummary {
    chunks: usize,
    has_more: bool,
}

/// Visit compact replay pages without ever dropping payload descriptors or
/// accumulating pages into a session-sized vector.
fn for_each_builtin_indexed_show_page(
    conn: &mut Connection,
    session_id: &str,
    max_chunks: usize,
    mut visit: impl FnMut(
        &mut Connection,
        usize,
        &ReplayCursor,
        bool,
        &[ReplayIndexedChunk],
    ) -> Result<(), String>,
) -> Result<StreamedShowSummary, String> {
    let mut cursor: Option<ReplayCursor> = None;
    let mut page_index = 0usize;
    let mut consumed = 0usize;
    let mut has_more = false;

    while consumed < max_chunks {
        let previous_sequence = cursor.as_ref().map_or(-1, |cursor| cursor.through_sequence);
        let remaining = max_chunks.saturating_sub(consumed);
        let limits = ReplayLimits {
            max_turns: replay::HARD_MAX_TURNS,
            max_events: remaining.clamp(1, SHOW_PAGE_EVENTS),
            max_ipc_bytes: SHOW_PAGE_IPC_BYTES,
        };
        let scan = replay_router::scan_activity_chunks_for_session(
            conn,
            session_id,
            cursor.as_ref(),
            limits,
        )?
        .ok_or_else(|| format!("Unknown built-in imported session id: {session_id}"))?;
        if scan.chunks.is_empty()
            && scan.has_more
            && scan.cursor.through_sequence <= previous_sequence
        {
            return Err(format!(
                "Bounded replay scan made no progress for {session_id} after sequence {}",
                scan.cursor.through_sequence
            ));
        }

        let raw_count = scan.chunks.len();
        let scan_has_more = scan.has_more;
        let scan_cursor = scan.cursor;
        if raw_count > 0 || (!scan_has_more && page_index == 0) {
            visit(conn, page_index, &scan_cursor, scan_has_more, &scan.chunks)?;
        }

        consumed = consumed.saturating_add(raw_count);
        has_more = scan_has_more;
        cursor = Some(scan_cursor);
        page_index = page_index.saturating_add(1);
        if !has_more {
            break;
        }
    }

    Ok(StreamedShowSummary {
        chunks: consumed,
        has_more,
    })
}

/// Third-party processors still speak the historical `Vec<ActivityChunk>`
/// protocol. Keep that compatibility boundary page-bounded and prevent it
/// from becoming a built-in provider loader fallback.
fn for_each_builtin_processed_show_page(
    conn: &mut Connection,
    session_id: &str,
    source: &str,
    processors: &[ProcessorPlugin],
    timeout: std::time::Duration,
    max_chunks: usize,
    mut visit: impl FnMut(usize, &ReplayCursor, bool, &[ActivityChunk]) -> Result<(), String>,
) -> Result<StreamedShowSummary, String> {
    for_each_builtin_indexed_show_page(
        conn,
        session_id,
        max_chunks,
        |_conn, page_index, cursor, has_more, indexed| {
            let chunks = indexed
                .iter()
                .map(|indexed| indexed.chunk.clone())
                .collect::<Vec<_>>();
            let chunks = apply_chunk_processors(session_id, source, chunks, processors, timeout);
            visit(page_index, cursor, has_more, &chunks)
        },
    )
}

fn stream_builtin_show_template(
    conn: &mut Connection,
    session_id: &str,
    source: &str,
    opts: &Options,
    processors: &[ProcessorPlugin],
    formatter: &FormatterPlugin,
) -> Result<(), String> {
    let max_chunks = opts.limit.unwrap_or(usize::MAX);
    for_each_builtin_processed_show_page(
        conn,
        session_id,
        source,
        processors,
        opts.timeout(),
        max_chunks,
        |page_index, cursor, has_more, chunks| {
            let context = serde_json::json!({
                "command": "show",
                "sessionId": session_id,
                "chunks": chunks,
                "page": {
                    "index": page_index,
                    "hasMore": has_more,
                    "generation": &cursor.generation,
                    "revision": cursor.revision,
                    "throughSequence": cursor.through_sequence,
                },
            });
            render_template(formatter, &context)
        },
    )?;
    Ok(())
}

fn stream_builtin_show(
    conn: &mut Connection,
    session_id: &str,
    source: ImportedHistorySourceId,
    opts: &Options,
    processors: &[ProcessorPlugin],
) -> Result<(), String> {
    let format = opts.format()?;
    let stdout = io::stdout();
    let mut out = io::BufWriter::new(stdout.lock());
    match format {
        Format::Json => out.write_all(b"[\n").map_err(show_write_error)?,
        Format::Md => writeln!(out, "# Session {session_id}\n").map_err(show_write_error)?,
        Format::Csv => out
            .write_all(b"created_at,role,action_type,function,preview\n")
            .map_err(show_write_error)?,
        Format::Table => writeln!(out, "Session {session_id} — streaming activity chunks\n")
            .map_err(show_write_error)?,
    }

    let mut wrote_json_chunk = false;
    let max_chunks = opts.limit.unwrap_or(usize::MAX);
    let summary = if processors.is_empty() {
        for_each_builtin_indexed_show_page(
            conn,
            session_id,
            max_chunks,
            |conn, _page_index, cursor, _has_more, chunks| {
                for indexed in chunks {
                    if format == Format::Json && wrote_json_chunk {
                        out.write_all(b",\n").map_err(show_write_error)?;
                    }
                    write_indexed_show_chunk(
                        conn,
                        &mut out,
                        source,
                        session_id,
                        &cursor.generation,
                        format,
                        indexed,
                    )?;
                    wrote_json_chunk |= format == Format::Json;
                }
                Ok(())
            },
        )?
    } else {
        eprintln!(
            "orgtrack: custom chunk processors receive bounded compact pages; deferred payloads remain previews"
        );
        for_each_builtin_processed_show_page(
            conn,
            session_id,
            source.as_str(),
            processors,
            opts.timeout(),
            max_chunks,
            |_page_index, _cursor, _has_more, chunks| {
                for chunk in chunks {
                    if format == Format::Json && wrote_json_chunk {
                        out.write_all(b",\n").map_err(show_write_error)?;
                    }
                    write_processed_show_chunk(&mut out, format, chunk)?;
                    wrote_json_chunk |= format == Format::Json;
                }
                Ok(())
            },
        )?
    };

    match format {
        Format::Json => out.write_all(b"\n]\n").map_err(show_write_error)?,
        Format::Table => {
            writeln!(out, "\n{} activity chunks shown.", summary.chunks)
                .map_err(show_write_error)?;
        }
        Format::Md | Format::Csv => {}
    }
    out.flush().map_err(show_write_error)?;
    if summary.has_more {
        eprintln!(
            "orgtrack: output stopped at --limit {} (more activity is available)",
            opts.limit.unwrap_or(summary.chunks)
        );
    }
    Ok(())
}

fn write_processed_show_chunk(
    writer: &mut impl Write,
    format: Format,
    chunk: &ActivityChunk,
) -> Result<(), String> {
    match format {
        Format::Json => {
            serde_json::to_writer(writer, chunk).map_err(|err| format!("json encode: {err}"))
        }
        Format::Md => writer
            .write_all(render_show_md_chunk(chunk).as_bytes())
            .map_err(show_write_error),
        Format::Csv => writer
            .write_all(render_show_csv_chunk(chunk).as_bytes())
            .map_err(show_write_error),
        Format::Table => write_show_table_chunk(writer, chunk),
    }
}

#[allow(clippy::too_many_arguments)]
fn write_indexed_show_chunk(
    conn: &mut Connection,
    writer: &mut impl Write,
    source: ImportedHistorySourceId,
    session_id: &str,
    generation: &str,
    format: Format,
    indexed: &ReplayIndexedChunk,
) -> Result<(), String> {
    if format == Format::Table {
        return write_show_table_chunk(writer, &indexed.chunk);
    }
    let mut read_range = |field_path: &str, offset: u64, max_bytes: usize| {
        replay::read_payload_range(
            conn,
            source,
            session_id,
            generation,
            &indexed.chunk.chunk_id,
            field_path,
            offset,
            Some(max_bytes),
        )
    };
    match format {
        Format::Json => write_indexed_chunk_json_with_reader(writer, indexed, &mut read_range),
        Format::Md => write_indexed_chunk_md_with_reader(writer, indexed, &mut read_range),
        Format::Csv => write_indexed_chunk_csv_with_reader(writer, indexed, &mut read_range),
        Format::Table => unreachable!("table returned before opening a payload reader"),
    }
}

fn write_indexed_chunk_json_with_reader<W, R>(
    writer: &mut W,
    indexed: &ReplayIndexedChunk,
    read_range: &mut R,
) -> Result<(), String>
where
    W: Write,
    R: FnMut(&str, u64, usize) -> Result<ReplayPayloadRange, String>,
{
    let chunk = &indexed.chunk;
    writer
        .write_all(b"{\"chunk_id\":")
        .map_err(show_write_error)?;
    write_small_json(writer, &chunk.chunk_id)?;
    writer
        .write_all(b",\"session_id\":")
        .map_err(show_write_error)?;
    write_small_json(writer, &chunk.session_id)?;
    writer
        .write_all(b",\"action_type\":")
        .map_err(show_write_error)?;
    write_small_json(writer, &chunk.action_type)?;
    writer
        .write_all(b",\"function\":")
        .map_err(show_write_error)?;
    write_small_json(writer, &chunk.function)?;
    writer.write_all(b",\"args\":").map_err(show_write_error)?;
    write_replay_json_value_with_reader(
        writer,
        "args",
        &chunk.args,
        &indexed.payloads,
        read_range,
    )?;
    writer
        .write_all(b",\"result\":")
        .map_err(show_write_error)?;
    write_replay_json_value_with_reader(
        writer,
        "result",
        &chunk.result,
        &indexed.payloads,
        read_range,
    )?;
    writer
        .write_all(b",\"created_at\":")
        .map_err(show_write_error)?;
    write_small_json(writer, &chunk.created_at)?;
    if let Some(thread_id) = &chunk.thread_id {
        writer
            .write_all(b",\"thread_id\":")
            .map_err(show_write_error)?;
        write_small_json(writer, thread_id)?;
    }
    if let Some(process_id) = &chunk.process_id {
        writer
            .write_all(b",\"process_id\":")
            .map_err(show_write_error)?;
        write_small_json(writer, process_id)?;
    }
    writer.write_all(b"}").map_err(show_write_error)
}

fn write_small_json(writer: &mut impl Write, value: &impl serde::Serialize) -> Result<(), String> {
    serde_json::to_writer(writer, value).map_err(|err| format!("json encode: {err}"))
}

fn write_replay_json_value_with_reader<W, R>(
    writer: &mut W,
    path: &str,
    value: &serde_json::Value,
    payloads: &[ReplayPayloadDescriptor],
    read_range: &mut R,
) -> Result<(), String>
where
    W: Write,
    R: FnMut(&str, u64, usize) -> Result<ReplayPayloadRange, String>,
{
    if let Some(payload) = payloads.iter().find(|payload| payload.field_path == path) {
        return match payload.resolved_encoding() {
            replay::ReplayPayloadEncoding::JsonValue => {
                stream_payload_with_reader(writer, path, false, read_range)
            }
            replay::ReplayPayloadEncoding::Utf8Text => {
                writer.write_all(b"\"").map_err(show_write_error)?;
                stream_payload_with_reader(writer, path, true, read_range)?;
                writer.write_all(b"\"").map_err(show_write_error)
            }
            replay::ReplayPayloadEncoding::LegacyPathInferred => {
                unreachable!("resolved replay payload encoding cannot remain legacy")
            }
        };
    }

    match value {
        serde_json::Value::Null
        | serde_json::Value::Bool(_)
        | serde_json::Value::Number(_)
        | serde_json::Value::String(_) => write_small_json(writer, value),
        serde_json::Value::Array(values) => {
            writer.write_all(b"[").map_err(show_write_error)?;
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    writer.write_all(b",").map_err(show_write_error)?;
                }
                write_replay_json_value_with_reader(
                    writer,
                    &format!("{path}.{index}"),
                    value,
                    payloads,
                    read_range,
                )?;
            }
            writer.write_all(b"]").map_err(show_write_error)
        }
        serde_json::Value::Object(values) => {
            writer.write_all(b"{").map_err(show_write_error)?;
            let mut wrote_field = false;
            for (key, value) in values {
                if replay::is_compact_only_replay_field(key) {
                    continue;
                }
                if wrote_field {
                    writer.write_all(b",").map_err(show_write_error)?;
                }
                wrote_field = true;
                write_small_json(writer, key)?;
                writer.write_all(b":").map_err(show_write_error)?;
                write_replay_json_value_with_reader(
                    writer,
                    &format!("{path}.{key}"),
                    value,
                    payloads,
                    read_range,
                )?;
            }
            writer.write_all(b"}").map_err(show_write_error)
        }
    }
}

fn stream_payload_with_reader<W, R>(
    writer: &mut W,
    field_path: &str,
    escape_json_string: bool,
    read_range: &mut R,
) -> Result<(), String>
where
    W: Write,
    R: FnMut(&str, u64, usize) -> Result<ReplayPayloadRange, String>,
{
    let mut offset = 0u64;
    loop {
        let range = read_range(field_path, offset, replay::HARD_MAX_PAYLOAD_RANGE_BYTES)?;
        if range.field_path != field_path {
            return Err(format!(
                "Replay payload {field_path} returned mismatched path {}",
                range.field_path
            ));
        }
        if range.offset != offset {
            return Err(format!(
                "Replay payload {field_path} skipped from {offset} to {}",
                range.offset
            ));
        }
        if escape_json_string {
            write_json_string_content(writer, &range.text)?;
        } else {
            writer
                .write_all(range.text.as_bytes())
                .map_err(show_write_error)?;
        }
        if range.next_offset <= offset && !range.eof {
            return Err(format!(
                "Replay payload {field_path} made no progress at {offset}"
            ));
        }
        offset = range.next_offset;
        if range.eof {
            if offset != range.total_bytes {
                return Err(format!(
                    "Replay payload {field_path} ended at {offset}, expected {}",
                    range.total_bytes
                ));
            }
            break;
        }
    }
    Ok(())
}

fn write_json_string_content(writer: &mut impl Write, text: &str) -> Result<(), String> {
    for ch in text.chars() {
        match ch {
            '"' => writer.write_all(b"\\\"").map_err(show_write_error)?,
            '\\' => writer.write_all(b"\\\\").map_err(show_write_error)?,
            '\u{08}' => writer.write_all(b"\\b").map_err(show_write_error)?,
            '\u{0c}' => writer.write_all(b"\\f").map_err(show_write_error)?,
            '\n' => writer.write_all(b"\\n").map_err(show_write_error)?,
            '\r' => writer.write_all(b"\\r").map_err(show_write_error)?,
            '\t' => writer.write_all(b"\\t").map_err(show_write_error)?,
            control if control <= '\u{1f}' => {
                write!(writer, "\\u{:04x}", control as u32).map_err(show_write_error)?;
            }
            other => {
                let mut encoded = [0u8; 4];
                writer
                    .write_all(other.encode_utf8(&mut encoded).as_bytes())
                    .map_err(show_write_error)?;
            }
        }
    }
    Ok(())
}

enum ReplayBodySelection<'a> {
    Compact(String),
    Payload(&'a ReplayPayloadDescriptor),
    Projection(&'a replay::ReplayPayloadBodyProjection),
    CompactProjection(String),
}

fn select_replay_body(indexed: &ReplayIndexedChunk) -> Option<ReplayBodySelection<'_>> {
    select_replay_body_root(indexed, "args", &indexed.chunk.args)
        .or_else(|| select_replay_body_root(indexed, "result", &indexed.chunk.result))
}

fn select_replay_body_root<'a>(
    indexed: &'a ReplayIndexedChunk,
    root: &'static str,
    value: &'a serde_json::Value,
) -> Option<ReplayBodySelection<'a>> {
    let payloads = indexed
        .payloads
        .iter()
        .filter(|payload| payload_path_is_under(&payload.field_path, root))
        .collect::<Vec<_>>();
    if let Some(payload) = payloads.iter().find(|payload| payload.field_path == root) {
        if let Some(projection) = payload.body_projection.as_ref() {
            return Some(ReplayBodySelection::Projection(projection));
        }
        return chunk_body(value).map(ReplayBodySelection::CompactProjection);
    }

    let selected_path = selected_compact_body_path(value, root)?;
    if let Some(payload) = payloads
        .iter()
        .find(|payload| payload.field_path == selected_path)
    {
        return Some(ReplayBodySelection::Payload(payload));
    }
    if selected_path == root && !payloads.is_empty() {
        return chunk_body(value).map(ReplayBodySelection::CompactProjection);
    }
    chunk_body(value).map(ReplayBodySelection::Compact)
}

fn selected_compact_body_path(value: &serde_json::Value, root: &str) -> Option<String> {
    match value {
        serde_json::Value::Null => None,
        serde_json::Value::String(text) => non_blank_path(text, root),
        serde_json::Value::Object(map) if map.is_empty() => None,
        serde_json::Value::Array(items) if items.is_empty() => None,
        serde_json::Value::Object(map) => {
            if let Some(text) = map
                .get("message")
                .and_then(|message| message.get("content"))
                .and_then(|content| content.as_str())
            {
                if let Some(path) = non_blank_path(text, &format!("{root}.message.content")) {
                    return Some(path);
                }
            }
            for key in [
                "content",
                "text",
                "observation",
                "cmd",
                "command",
                "body",
                "summary",
                "prompt",
                "description",
            ] {
                if let Some(text) = map.get(key).and_then(|value| value.as_str()) {
                    if let Some(path) = non_blank_path(text, &format!("{root}.{key}")) {
                        return Some(path);
                    }
                }
            }
            Some(root.to_string())
        }
        _ => Some(root.to_string()),
    }
}

fn non_blank_path(text: &str, path: &str) -> Option<String> {
    (!text.trim().is_empty()).then(|| path.to_string())
}

fn payload_path_is_under(field_path: &str, root: &str) -> bool {
    field_path == root
        || field_path
            .strip_prefix(root)
            .is_some_and(|suffix| suffix.starts_with('.'))
}

fn write_selected_replay_body<W, R>(
    writer: &mut W,
    selection: ReplayBodySelection<'_>,
    read_range: &mut R,
) -> Result<(), String>
where
    W: Write,
    R: FnMut(&str, u64, usize) -> Result<ReplayPayloadRange, String>,
{
    match selection {
        ReplayBodySelection::Compact(text) => {
            writer.write_all(text.as_bytes()).map_err(show_write_error)
        }
        ReplayBodySelection::Payload(payload) => {
            stream_payload_with_reader(writer, &payload.field_path, false, read_range)
        }
        ReplayBodySelection::Projection(projection) => {
            writer
                .write_all(projection.text.as_bytes())
                .map_err(show_write_error)?;
            if projection.truncated {
                writer
                    .write_all(REPLAY_BODY_TRUNCATED_NOTICE)
                    .map_err(show_write_error)?;
            }
            Ok(())
        }
        ReplayBodySelection::CompactProjection(text) => {
            writer
                .write_all(text.as_bytes())
                .map_err(show_write_error)?;
            writer
                .write_all(REPLAY_BODY_TRUNCATED_NOTICE)
                .map_err(show_write_error)
        }
    }
}

const REPLAY_BODY_TRUNCATED_NOTICE: &[u8] =
    b"\n... [large replay body truncated; use --format json or export for the full payload]";

fn write_indexed_chunk_md_with_reader<W, R>(
    writer: &mut W,
    indexed: &ReplayIndexedChunk,
    read_range: &mut R,
) -> Result<(), String>
where
    W: Write,
    R: FnMut(&str, u64, usize) -> Result<ReplayPayloadRange, String>,
{
    let chunk = &indexed.chunk;
    writeln!(
        writer,
        "**{}** · {}\n",
        chunk_role(chunk),
        truncate(&chunk.created_at, 19)
    )
    .map_err(show_write_error)?;
    let Some(selection) = select_replay_body(indexed) else {
        return writer
            .write_all(b"_(no content)_\n\n")
            .map_err(show_write_error);
    };
    if chunk.action_type == "tool_call" {
        writer.write_all(b"```\n").map_err(show_write_error)?;
        write_selected_replay_body(writer, selection, read_range)?;
        writer.write_all(b"\n```\n\n").map_err(show_write_error)
    } else {
        write_selected_replay_body(writer, selection, read_range)?;
        writer.write_all(b"\n\n").map_err(show_write_error)
    }
}

fn write_indexed_chunk_csv_with_reader<W, R>(
    writer: &mut W,
    indexed: &ReplayIndexedChunk,
    read_range: &mut R,
) -> Result<(), String>
where
    W: Write,
    R: FnMut(&str, u64, usize) -> Result<ReplayPayloadRange, String>,
{
    let chunk = &indexed.chunk;
    let role = chunk_role(chunk);
    for field in [
        chunk.created_at.as_str(),
        role.as_str(),
        chunk.action_type.as_str(),
        chunk.function.as_str(),
    ] {
        write_csv_field(writer, field)?;
        writer.write_all(b",").map_err(show_write_error)?;
    }
    writer.write_all(b"\"").map_err(show_write_error)?;
    if let Some(selection) = select_replay_body(indexed) {
        let mut csv_body = CsvBodyWriter { inner: writer };
        write_selected_replay_body(&mut csv_body, selection, read_range)?;
    }
    writer.write_all(b"\"\n").map_err(show_write_error)
}

fn write_csv_field(writer: &mut impl Write, field: &str) -> Result<(), String> {
    if field.contains([',', '"', '\n', '\r']) {
        writer.write_all(b"\"").map_err(show_write_error)?;
        let mut escaped = CsvBodyWriter { inner: writer };
        escaped
            .write_all(field.as_bytes())
            .map_err(show_write_error)?;
        writer.write_all(b"\"").map_err(show_write_error)
    } else {
        writer.write_all(field.as_bytes()).map_err(show_write_error)
    }
}

struct CsvBodyWriter<'a, W> {
    inner: &'a mut W,
}

impl<W: Write> Write for CsvBodyWriter<'_, W> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let mut start = 0usize;
        for (index, byte) in bytes.iter().enumerate() {
            let replacement = match byte {
                b'"' => Some(&b"\"\""[..]),
                b'\n' => Some(&b" "[..]),
                _ => None,
            };
            if let Some(replacement) = replacement {
                self.inner.write_all(&bytes[start..index])?;
                self.inner.write_all(replacement)?;
                start = index + 1;
            }
        }
        self.inner.write_all(&bytes[start..])?;
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

fn write_show_table_chunk(writer: &mut impl Write, chunk: &ActivityChunk) -> Result<(), String> {
    let label = if chunk.function.is_empty() {
        chunk.action_type.clone()
    } else {
        format!("{}:{}", chunk.action_type, chunk.function)
    };
    writeln!(writer, "[{}] {}", truncate(&chunk.created_at, 19), label)
        .map_err(show_write_error)?;
    if let Some(text) = preview_of(&chunk.args).or_else(|| preview_of(&chunk.result)) {
        writeln!(writer, "    {}", truncate(&text, 160)).map_err(show_write_error)?;
    }
    Ok(())
}

fn show_write_error(error: io::Error) -> String {
    format!("write show output: {error}")
}

/// Portable markdown transcript of a session — the export format. Message
/// bodies render as prose; tool calls render as fenced code so a transcript
/// round-trips into any markdown viewer.
pub(crate) fn render_show_md(session_id: &str, chunks: &[ActivityChunk]) -> String {
    let mut out = format!("# Session {session_id}\n\n");
    for chunk in chunks {
        out.push_str(&render_show_md_chunk(chunk));
    }
    out
}

fn render_show_md_chunk(chunk: &ActivityChunk) -> String {
    let role = chunk_role(chunk);
    let mut out = format!("**{role}** · {}\n\n", truncate(&chunk.created_at, 19));
    let body = chunk_body(&chunk.args).or_else(|| chunk_body(&chunk.result));
    match body {
        Some(text) if chunk.action_type == "tool_call" => {
            out.push_str(&format!("```\n{}\n```\n\n", text.trim_end()))
        }
        Some(text) => out.push_str(&format!("{}\n\n", text.trim_end())),
        None => out.push_str("_(no content)_\n\n"),
    }
    out
}

pub(crate) fn render_show_csv(chunks: &[ActivityChunk]) -> String {
    let mut out = String::from("created_at,role,action_type,function,preview\n");
    for chunk in chunks {
        out.push_str(&render_show_csv_chunk(chunk));
    }
    out
}

fn render_show_csv_chunk(chunk: &ActivityChunk) -> String {
    let preview = preview_of(&chunk.args)
        .or_else(|| preview_of(&chunk.result))
        .unwrap_or_default();
    csv_row(&[
        &chunk.created_at,
        &chunk_role(chunk),
        &chunk.action_type,
        &chunk.function,
        &preview,
    ])
}

/// Human role label for a chunk: `user`, `assistant`, `assistant (thinking)`,
/// or `tool: <name>`.
pub(crate) fn chunk_role(chunk: &ActivityChunk) -> String {
    match chunk.action_type.as_str() {
        "raw" if chunk.function.contains("user") => "user".to_string(),
        "assistant" => "assistant".to_string(),
        "thinking" => "assistant (thinking)".to_string(),
        "tool_call" => format!("tool: {}", chunk.function),
        other => other.to_string(),
    }
}

#[cfg(test)]
#[path = "show_tests.rs"]
mod show_stream_tests;
