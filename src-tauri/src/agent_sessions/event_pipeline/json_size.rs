//! Allocation-free JSON byte measurement for hot replay paths.
//!
//! Replay budgets need the exact serialized size, but they do not need to
//! retain the serialized bytes. Writing into this counter avoids repeatedly
//! allocating multi-megabyte temporary `Vec<u8>` buffers while a long external
//! transcript is opened or prepended.

use std::io::{self, Write};

use serde::Serialize;

#[derive(Default)]
struct CountingWriter {
    bytes: usize,
}

impl Write for CountingWriter {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.bytes = self
            .bytes
            .checked_add(buffer.len())
            .ok_or_else(|| io::Error::other("serialized JSON byte count overflow"))?;
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

pub(crate) fn serialized_json_bytes<T: Serialize + ?Sized>(
    value: &T,
) -> Result<usize, serde_json::Error> {
    let mut writer = CountingWriter::default();
    serde_json::to_writer(&mut writer, value)?;
    Ok(writer.bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_serde_json_vec_length() {
        let value = serde_json::json!({
            "text": "bounded replay",
            "values": [1, 2, 3],
            "enabled": true,
        });

        assert_eq!(
            serialized_json_bytes(&value).expect("measure JSON"),
            serde_json::to_vec(&value).expect("serialize JSON").len()
        );
    }
}
