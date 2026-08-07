//! Best-effort loopback POST of a normalized live-status event.
//!
//! Runs inside the short-lived `--session-provenance-hook` subprocess, which
//! deliberately has no Tauri boot and no tokio runtime — so this is a bare
//! `std::net::TcpStream` HTTP/1.1 request with tight timeouts. Every failure
//! is swallowed: when the desktop app is closed the connect refuses in
//! microseconds, and durability comes from the desktop-side last-status
//! cache plus the transcript-mtime fallback, not from this channel.

use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::time::Duration;

use orgtrack_core::status_adapter::AgentStatusEventV1;

const CONNECT_TIMEOUT: Duration = Duration::from_millis(500);
const IO_TIMEOUT: Duration = Duration::from_secs(1);

#[derive(serde::Deserialize)]
pub(super) struct EndpointFile {
    #[serde(default)]
    version: u32,
    pub(super) port: u16,
    pub(super) token: String,
}

/// The endpoint file is re-read on every invocation (not cached from the PTY
/// environment) so CLI sessions that outlive an Orgii restart post to the
/// current server and token. Shared with `approval_gate`, which long-polls
/// the same loopback server for permission decisions.
pub(super) fn read_endpoint() -> Option<EndpointFile> {
    let bytes = std::fs::read(app_paths::agent_status_endpoint_path()).ok()?;
    let endpoint = serde_json::from_slice::<EndpointFile>(&bytes).ok()?;
    if endpoint.version != 1 || endpoint.token.is_empty() {
        return None;
    }
    Some(endpoint)
}

/// Fire-and-forget: any error (no endpoint file, dead server, timeout,
/// non-2xx) is swallowed by design.
pub fn post_status_event(event: &AgentStatusEventV1) {
    let Some(endpoint) = read_endpoint() else {
        return;
    };
    let Ok(body) = serde_json::to_vec(event) else {
        return;
    };
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, endpoint.port));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT) else {
        return;
    };
    let _ = stream.set_write_timeout(Some(IO_TIMEOUT));
    let _ = stream.set_read_timeout(Some(IO_TIMEOUT));
    let request = format!(
        "POST /hooks/agent-status HTTP/1.1\r\n\
         Host: 127.0.0.1:{port}\r\n\
         Content-Type: application/json\r\n\
         Content-Length: {length}\r\n\
         X-Orgii-Hook-Token: {token}\r\n\
         Connection: close\r\n\r\n",
        port = endpoint.port,
        length = body.len(),
        token = endpoint.token,
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return;
    }
    if stream.write_all(&body).is_err() {
        return;
    }
    // Read (and discard) the response so the server never sees an aborted
    // connection mid-write; bounded by the read timeout either way.
    let mut sink = [0u8; 256];
    let _ = stream.read(&mut sink);
}
