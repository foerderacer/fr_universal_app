use std::io::Cursor;

use fr_core::{FrError, Result};
use image::ImageFormat;
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ImageDimensions {
    pub width: u32,
    pub height: u32,
}

/// Inspects width & height from raw encoded image bytes without full decode when possible.
pub fn inspect_image_dimensions(bytes: &[u8]) -> Option<ImageDimensions> {
    let reader = image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .ok()?;
    let (width, height) = reader.into_dimensions().ok()?;
    Some(ImageDimensions { width, height })
}

/// Decodes any supported raster image (including `.tiff` / `.bmp`) and re-encodes it as PNG
/// for consistent rendering across Windows WebView2 and macOS WKWebView.
pub fn transcode_to_png(bytes: &[u8]) -> Result<Vec<u8>> {
    let img = image::load_from_memory(bytes)
        .map_err(|err| FrError::Other(format!("failed to decode image for preview: {err}")))?;
    let mut out = Cursor::new(Vec::new());
    img.write_to(&mut out, ImageFormat::Png)
        .map_err(|err| FrError::Other(format!("failed to encode PNG preview: {err}")))?;
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
}
