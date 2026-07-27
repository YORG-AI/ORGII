//! Wire helpers (protobuf wire format + hex + file URIs) used to decode the
//! root-blob manifest and the `meta` header.

pub(super) enum WireValue<'a> {
    Varint(u64),
    Bytes(&'a [u8]),
}

/// Minimal protobuf wire-format walker for the root manifest. The store has
/// no published descriptor, so this decodes just the tag/length framing and
/// leaves interpretation to the caller. Returns `None` on malformed input.
pub(super) fn wire_fields(data: &[u8]) -> Option<Vec<(u32, WireValue<'_>)>> {
    let mut fields = Vec::new();
    let mut offset = 0usize;
    while offset < data.len() {
        let (tag, next) = read_varint(data, offset)?;
        offset = next;
        let field = (tag >> 3) as u32;
        match tag & 7 {
            0 => {
                let (value, next) = read_varint(data, offset)?;
                offset = next;
                fields.push((field, WireValue::Varint(value)));
            }
            1 => {
                offset = offset.checked_add(8).filter(|end| *end <= data.len())?;
            }
            2 => {
                let (length, next) = read_varint(data, offset)?;
                offset = next;
                let end = offset.checked_add(usize::try_from(length).ok()?)?;
                if end > data.len() {
                    return None;
                }
                fields.push((field, WireValue::Bytes(&data[offset..end])));
                offset = end;
            }
            5 => {
                offset = offset.checked_add(4).filter(|end| *end <= data.len())?;
            }
            _ => return None,
        }
    }
    Some(fields)
}

fn read_varint(data: &[u8], mut offset: usize) -> Option<(u64, usize)> {
    let mut value = 0u64;
    let mut shift = 0u32;
    loop {
        let byte = *data.get(offset)?;
        offset += 1;
        value |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Some((value, offset));
        }
        shift += 7;
        if shift >= 64 {
            return None;
        }
    }
}

pub(super) fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(char::from_digit(u32::from(byte >> 4), 16).unwrap_or('0'));
        out.push(char::from_digit(u32::from(byte & 0x0f), 16).unwrap_or('0'));
    }
    out
}

pub(super) fn hex_decode(text: &str) -> Option<Vec<u8>> {
    let text = text.trim();
    if text.is_empty() || text.len() % 2 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity(text.len() / 2);
    let bytes = text.as_bytes();
    for pair in bytes.chunks_exact(2) {
        let high = (pair[0] as char).to_digit(16)?;
        let low = (pair[1] as char).to_digit(16)?;
        out.push(((high << 4) | low) as u8);
    }
    Some(out)
}

/// Decode a `file://` URI into a filesystem path (percent-decoding included).
pub(super) fn file_uri_to_path(uri: &str) -> Option<String> {
    let raw = uri.trim().strip_prefix("file://")?;
    let decoded = percent_decode(raw);
    // Windows URIs look like `file:///C:/path`; strip the leading slash.
    let decoded = if decoded.len() >= 3
        && decoded.starts_with('/')
        && decoded.as_bytes()[2] == b':'
        && decoded.as_bytes()[1].is_ascii_alphabetic()
    {
        decoded[1..].to_string()
    } else {
        decoded
    };
    (!decoded.is_empty()).then_some(decoded)
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0usize;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let high = (bytes[index + 1] as char).to_digit(16);
            let low = (bytes[index + 2] as char).to_digit(16);
            if let (Some(high), Some(low)) = (high, low) {
                out.push(((high << 4) | low) as u8);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}
