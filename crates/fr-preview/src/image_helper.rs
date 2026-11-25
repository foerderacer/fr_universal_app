use std::io::Cursor;

use fr_core::{FrError, Result};
use image::{ImageFormat, Limits};
use serde::{Deserialize, Serialize};
use specta::Type;

/// Maximum raw encoded input size allowed for in-memory raster transcoding (50 MiB).
pub const MAX_TRANSCODE_INPUT_BYTES: usize = 50 * 1024 * 1024;
const MAX_IMAGE_DIMENSION: u32 = 16_384;
const MAX_DECODE_ALLOC_BYTES: u64 = 128 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ImageDimensions {
    pub width: u32,
    pub height: u32,
}

fn safe_decode_limits() -> Limits {
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_IMAGE_DIMENSION);
    limits.max_image_height = Some(MAX_IMAGE_DIMENSION);
    limits.max_alloc = Some(MAX_DECODE_ALLOC_BYTES);
    limits
}

/// Inspects width & height from raw encoded image bytes without full decode when possible.
pub fn inspect_image_dimensions(bytes: &[u8]) -> Option<ImageDimensions> {
    let mut reader = image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .ok()?;
    reader.limits(safe_decode_limits());
    let (width, height) = reader.into_dimensions().ok()?;
    Some(ImageDimensions { width, height })
}

/// Decodes any supported raster image (including `.tiff` / `.bmp`) with strict memory and
/// dimension bounds and re-encodes it as PNG for consistent rendering across WebView2 & WKWebView.
pub fn transcode_to_png(bytes: &[u8]) -> Result<Vec<u8>> {
    if bytes.len() > MAX_TRANSCODE_INPUT_BYTES {
        return Err(FrError::Other(
            "image exceeds maximum 50 MB size limit for preview transcoding".into(),
        ));
    }
    let mut reader = image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|err| FrError::Other(format!("failed to read image format: {err}")))?;
    reader.limits(safe_decode_limits());
    let img = reader
        .decode()
        .map_err(|err| FrError::Other(format!("failed to decode image for preview: {err}")))?;
    let mut out = Cursor::new(Vec::new());
    img.write_to(&mut out, ImageFormat::Png)
        .map_err(|err| FrError::Other(format!("failed to encode PNG preview: {err}")))?;
    Ok(out.into_inner())
}

/// Validates, optionally downscales to fit within `max_dim × max_dim`, and encodes a thumbnail
/// as PNG so untrusted embedded thumbnails cannot cause IPC/WebView memory DoS.
pub fn normalize_thumbnail_png(bytes: &[u8], max_dim: u32) -> Result<Vec<u8>> {
    if bytes.len() > MAX_TRANSCODE_INPUT_BYTES {
        return Err(FrError::Other("embedded thumbnail exceeds size cap".into()));
    }
    let mut reader = image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|err| FrError::Other(format!("failed to detect thumbnail format: {err}")))?;
    reader.limits(safe_decode_limits());
    let img = reader
        .decode()
        .map_err(|err| FrError::Other(format!("failed to decode embedded thumbnail: {err}")))?;
    let resized = if img.width() > max_dim || img.height() > max_dim {
        img.thumbnail(max_dim, max_dim)
    } else {
        img
    };
    let mut out = Cursor::new(Vec::new());
    resized
        .write_to(&mut out, ImageFormat::Png)
        .map_err(|err| FrError::Other(format!("failed to encode thumbnail PNG: {err}")))?;
    Ok(out.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgba};

    #[test]
    fn transcodes_bmp_and_inspects_dimensions() {
        let img: ImageBuffer<Rgba<u8>, Vec<u8>> =
            ImageBuffer::from_pixel(4, 3, Rgba([10, 20, 30, 255]));
        let mut bmp = Cursor::new(Vec::new());
        img.write_to(&mut bmp, ImageFormat::Bmp).unwrap();

        let dims = inspect_image_dimensions(bmp.get_ref()).unwrap();
        assert_eq!(
            dims,
            ImageDimensions {
                width: 4,
                height: 3
            }
        );

        let png = transcode_to_png(bmp.get_ref()).unwrap();
        assert!(png.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10]));
    }

    #[test]
    fn normalizes_and_downscales_oversized_thumbnail() {
        let img: ImageBuffer<Rgba<u8>, Vec<u8>> =
            ImageBuffer::from_pixel(120, 60, Rgba([200, 100, 50, 255]));
        let mut raw = Cursor::new(Vec::new());
        img.write_to(&mut raw, ImageFormat::Png).unwrap();

        let thumb = normalize_thumbnail_png(raw.get_ref(), 40).unwrap();
        let dims = inspect_image_dimensions(&thumb).unwrap();
        assert!(dims.width <= 40 && dims.height <= 40);
    }
}
