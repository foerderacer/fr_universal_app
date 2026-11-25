use std::io::{Cursor, Read};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use chrono::{DateTime, Utc};
use fr_core::{FrError, Result};
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::image_helper::transcode_to_png;

/// Engineering metadata extracted from SolidWorks OLE2 `SummaryInformation` streams.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SolidWorksMetadata {
    pub title: Option<String>,
    pub subject: Option<String>,
    pub author: Option<String>,
    pub keywords: Option<String>,
    pub comments: Option<String>,
    pub last_saved_by: Option<String>,
    pub application_name: Option<String>,
    pub created_at: Option<String>,
    pub last_saved_at: Option<String>,
}

/// Pure-Rust preview payload extracted from a SolidWorks `.sldprt` / `.sldasm` / `.slddrw` file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SolidWorksPreview {
    /// Data URL (`data:image/png;base64,...`) of the embedded thumbnail, if present.
    pub thumbnail_data_url: Option<String>,
    pub metadata: SolidWorksMetadata,
    pub stream_count: u32,
}

/// Extracts embedded preview PNG/BMP and OLE2 SummaryInformation metadata from a SolidWorks
/// compound file in pure Rust (zero external CAD binaries required; works on Windows & macOS).
pub fn extract_solidworks_preview(bytes: &[u8]) -> Result<SolidWorksPreview> {
    let mut comp = cfb::CompoundFile::open(Cursor::new(bytes)).map_err(|err| {
        FrError::Other(format!("not a valid SolidWorks OLE2 compound file: {err}"))
    })?;

    let mut preview_png_path: Option<String> = None;
    let mut preview_dib_path: Option<String> = None;
    let mut summary_info_path: Option<String> = None;
    let mut stream_count = 0u32;

    for entry in comp.walk() {
        if !entry.is_stream() {
            continue;
        }
        stream_count = stream_count.saturating_add(1);
        let path_str = entry.path().to_string_lossy().into_owned();
        let name_lower = entry.name().to_ascii_lowercase();

        if name_lower == "previewpng" {
            preview_png_path = Some(path_str);
        } else if name_lower == "preview" && preview_dib_path.is_none() {
            preview_dib_path = Some(path_str);
        } else if name_lower.contains("summaryinformation")
            && !name_lower.contains("documentsummaryinformation")
        {
            summary_info_path = Some(path_str);
        }
    }

    let thumbnail_data_url = if let Some(path) = preview_png_path {
        read_stream(&mut comp, &path)
            .ok()
            .and_then(|raw| normalize_preview_image(&raw))
    } else if let Some(path) = preview_dib_path {
        read_stream(&mut comp, &path)
            .ok()
            .and_then(|raw| normalize_preview_image(&raw))
    } else {
        None
    };

    let metadata = if let Some(path) = summary_info_path {
        read_stream(&mut comp, &path)
            .map(|raw| parse_summary_information(&raw))
            .unwrap_or_default()
    } else {
        SolidWorksMetadata::default()
    };

    Ok(SolidWorksPreview {
        thumbnail_data_url,
        metadata,
        stream_count,
    })
}

fn read_stream(comp: &mut cfb::CompoundFile<Cursor<&[u8]>>, path: &str) -> Result<Vec<u8>> {
    let mut stream = comp
        .open_stream(path)
        .map_err(|err| FrError::Other(format!("failed to open CFBF stream '{path}': {err}")))?;
    let mut buf = Vec::new();
    stream.read_to_end(&mut buf)?;
    Ok(buf)
}

fn normalize_preview_image(raw: &[u8]) -> Option<String> {
    if raw.len() < 16 {
        return None;
    }

    // Modern SolidWorks `PreviewPNG` starts with the PNG magic signature.
    if raw.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10]) {
        return Some(format!("data:image/png;base64,{}", BASE64.encode(raw)));
    }

    // Legacy `Preview` streams may already have a BMP header (`BM`) or start directly with a
    // 40-byte BITMAPINFOHEADER DIB.
    let bmp_bytes = if raw.starts_with(b"BM") {
        raw.to_vec()
    } else {
        wrap_dib_as_bmp(raw)?
    };

    if let Ok(png) = transcode_to_png(&bmp_bytes) {
        Some(format!("data:image/png;base64,{}", BASE64.encode(png)))
    } else {
        Some(format!(
            "data:image/bmp;base64,{}",
            BASE64.encode(bmp_bytes)
        ))
    }
}

fn wrap_dib_as_bmp(dib: &[u8]) -> Option<Vec<u8>> {
    if dib.len() < 40 {
        return None;
    }
    let header_size = u32::from_le_bytes(dib[0..4].try_into().ok()?);
    if header_size != 40 {
        return None;
    }
    let bit_count = u16::from_le_bytes(dib[14..16].try_into().ok()?);
    let colors_used = u32::from_le_bytes(dib[32..36].try_into().ok()?);
    let palette_entries = if colors_used > 0 {
        colors_used
    } else if bit_count <= 8 {
        1u32.checked_shl(u32::from(bit_count))?
    } else {
        0
    };
    let pixel_offset = 14u32
        .checked_add(header_size)?
        .checked_add(palette_entries.checked_mul(4)?)?;
    let file_size = 14u32.checked_add(u32::try_from(dib.len()).ok()?)?;

    let mut out = Vec::with_capacity(file_size as usize);
    out.extend_from_slice(b"BM");
    out.extend_from_slice(&file_size.to_le_bytes());
    out.extend_from_slice(&[0u8; 4]);
    out.extend_from_slice(&pixel_offset.to_le_bytes());
    out.extend_from_slice(dib);
    Some(out)
}

/// Minimal pure-Rust `[MS-OLEPS]` Property Set Stream parser for `\x05SummaryInformation`.
fn parse_summary_information(data: &[u8]) -> SolidWorksMetadata {
    let mut meta = SolidWorksMetadata::default();
    if data.len() < 48 {
        return meta;
    }

    // Header: ByteOrder (0xFFFE), Version, SystemIdentifier, CLSID (16), NumPropertySets (u32 @ 24)
    let byte_order = read_u16(data, 0).unwrap_or(0);
    if byte_order != 0xFFFE {
        return meta;
    }
    let num_sections = read_u32(data, 24).unwrap_or(0);
    if num_sections == 0 {
        return meta;
    }

    // First section descriptor starts at offset 28: FMTID (16 bytes) + Offset (u32 @ 44).
    let Some(section_offset) = read_u32(data, 44).map(|v| v as usize) else {
        return meta;
    };
    if section_offset + 8 > data.len() {
        return meta;
    }

    let num_props = read_u32(data, section_offset + 4).unwrap_or(0) as usize;
    let table_start = section_offset + 8;

    for i in 0..num_props.min(64) {
        let entry_off = table_start + i * 8;
        if entry_off + 8 > data.len() {
            break;
        }
        let prop_id = read_u32(data, entry_off).unwrap_or(0);
        let rel_offset = read_u32(data, entry_off + 4).unwrap_or(0) as usize;
        let Some(prop_off) = section_offset.checked_add(rel_offset) else {
            continue;
        };
        if prop_off + 4 > data.len() {
            continue;
        }

        let prop_type = read_u32(data, prop_off).unwrap_or(0);
        match prop_id {
            2 => meta.title = parse_ole_string(data, prop_off + 4, prop_type),
            3 => meta.subject = parse_ole_string(data, prop_off + 4, prop_type),
            4 => meta.author = parse_ole_string(data, prop_off + 4, prop_type),
            5 => meta.keywords = parse_ole_string(data, prop_off + 4, prop_type),
            6 => meta.comments = parse_ole_string(data, prop_off + 4, prop_type),
            8 => meta.last_saved_by = parse_ole_string(data, prop_off + 4, prop_type),
            12 => meta.created_at = parse_ole_filetime(data, prop_off + 4, prop_type),
            13 => meta.last_saved_at = parse_ole_filetime(data, prop_off + 4, prop_type),
            18 => meta.application_name = parse_ole_string(data, prop_off + 4, prop_type),
            _ => {}
        }
    }

    meta
}

fn read_u16(data: &[u8], offset: usize) -> Option<u16> {
    let slice = data.get(offset..offset + 2)?;
    Some(u16::from_le_bytes([slice[0], slice[1]]))
}

fn read_u32(data: &[u8], offset: usize) -> Option<u32> {
    let slice = data.get(offset..offset + 4)?;
    Some(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

fn parse_ole_string(data: &[u8], offset: usize, prop_type: u32) -> Option<String> {
    let count = read_u32(data, offset)? as usize;
    let payload_start = offset + 4;
    match prop_type {
        // VT_LPSTR (30): count is byte length including null terminator.
        30 => {
            let bytes = data.get(payload_start..payload_start.checked_add(count)?)?;
            let text = String::from_utf8_lossy(bytes)
                .trim_end_matches('\0')
                .trim()
                .to_owned();
            if text.is_empty() { None } else { Some(text) }
        }
        // VT_LPWSTR (31): count is UTF-16 code unit count including null terminator.
        31 => {
            let byte_len = count.checked_mul(2)?;
            let bytes = data.get(payload_start..payload_start.checked_add(byte_len)?)?;
            let units: Vec<u16> = bytes
                .as_chunks::<2>()
                .0
                .iter()
                .map(|c| u16::from_le_bytes(*c))
                .collect();
            let text = String::from_utf16_lossy(&units)
                .trim_end_matches('\0')
                .trim()
                .to_owned();
            if text.is_empty() { None } else { Some(text) }
        }
        _ => None,
    }
}

fn parse_ole_filetime(data: &[u8], offset: usize, prop_type: u32) -> Option<String> {
    // VT_FILETIME (64): 100-nanosecond intervals since January 1, 1601 UTC.
    if prop_type != 64 {
        return None;
    }
    let slice = data.get(offset..offset + 8)?;
    let raw = u64::from_le_bytes(slice.try_into().ok()?);
    const EPOCH_DIFF_100NS: u64 = 116_444_736_000_000_000;
    if raw < EPOCH_DIFF_100NS {
        return None;
    }
    let unix_100ns = raw - EPOCH_DIFF_100NS;
    let secs = (unix_100ns / 10_000_000) as i64;
    let nanos = ((unix_100ns % 10_000_000) * 100) as u32;
    let dt: DateTime<Utc> = DateTime::from_timestamp(secs, nanos)?;
    Some(dt.to_rfc3339())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn build_summary_stream(title: &str, author: &str, app: &str) -> Vec<u8> {
        let mut buf = vec![0u8; 48];
        buf[0..2].copy_from_slice(&0xFFFEu16.to_le_bytes());
        buf[24..28].copy_from_slice(&1u32.to_le_bytes()); // 1 section
        buf[44..48].copy_from_slice(&48u32.to_le_bytes()); // section offset = 48

        let props: Vec<(u32, &str)> = vec![(2, title), (4, author), (18, app)];
        let header_and_table_len = 8 + props.len() * 8;
        let mut section = vec![0u8; header_and_table_len];
        section[4..8].copy_from_slice(&(props.len() as u32).to_le_bytes());

        for (idx, (id, val)) in props.iter().enumerate() {
            let rel_off = section.len() as u32;
            let entry_pos = 8 + idx * 8;
            section[entry_pos..entry_pos + 4].copy_from_slice(&id.to_le_bytes());
            section[entry_pos + 4..entry_pos + 8].copy_from_slice(&rel_off.to_le_bytes());

            section.extend_from_slice(&30u32.to_le_bytes()); // VT_LPSTR
            let mut bytes = val.as_bytes().to_vec();
            bytes.push(0);
            section.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
            section.extend_from_slice(&bytes);
            while !section.len().is_multiple_of(4) {
                section.push(0);
            }
        }
        let section_len = section.len() as u32;
        section[0..4].copy_from_slice(&section_len.to_le_bytes());
        buf.extend_from_slice(&section);
        buf
    }

    #[test]
    fn extracts_embedded_png_and_summary_metadata_from_solidworks_cfbf() {
        let mut cursor = Cursor::new(Vec::new());
        {
            let mut comp = cfb::CompoundFile::create(&mut cursor).unwrap();
            let mut png_stream = comp.create_stream("/PreviewPNG").unwrap();
            png_stream
                .write_all(&[137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82])
                .unwrap();

            let mut sum_stream = comp.create_stream("/\x05SummaryInformation").unwrap();
            sum_stream
                .write_all(&build_summary_stream(
                    "Chassis Bracket",
                    "Alex CAD",
                    "SOLIDWORKS 2025",
                ))
                .unwrap();
        }

        let preview = extract_solidworks_preview(cursor.get_ref()).unwrap();
        assert!(
            preview
                .thumbnail_data_url
                .as_deref()
                .is_some_and(|u| u.starts_with("data:image/png;base64,"))
        );
        assert_eq!(preview.metadata.title.as_deref(), Some("Chassis Bracket"));
        assert_eq!(preview.metadata.author.as_deref(), Some("Alex CAD"));
        assert_eq!(
            preview.metadata.application_name.as_deref(),
            Some("SOLIDWORKS 2025")
        );
        assert_eq!(preview.stream_count, 2);
    }
}
