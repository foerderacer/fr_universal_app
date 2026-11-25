//! Client-side preview classification, SolidWorks OLE2/CFBF extractor, image transcoding,
//! and ephemeral loopback Range-request media streaming proxy.

pub mod image_helper;
pub mod media_proxy;
pub mod solidworks;

use std::path::Path;

use serde::{Deserialize, Serialize};
use specta::Type;

pub use image_helper::{ImageDimensions, inspect_image_dimensions, transcode_to_png};
pub use media_proxy::MediaProxyServer;
pub use solidworks::{SolidWorksMetadata, SolidWorksPreview, extract_solidworks_preview};

/// Rendering/preview strategy selected for a file in the Files workspace.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum PreviewKind {
    Markdown,
    Image,
    Video,
    Pdf,
    VectorSvg,
    VectorAi,
    VectorDxf,
    VectorEps,
    SolidWorks,
    Cad3d,
    PlainText,
    Unsupported,
}

/// Classifies a file by its filename/extension into a [`PreviewKind`].
pub fn classify_preview(file_name: &str) -> PreviewKind {
    let ext = Path::new(file_name)
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase);

    match ext.as_deref() {
        Some("md" | "markdown") => PreviewKind::Markdown,
        Some("png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp" | "tif" | "tiff" | "avif") => {
            PreviewKind::Image
        }
        Some("mp4" | "webm" | "mov" | "mkv" | "m4v") => PreviewKind::Video,
        Some("pdf") => PreviewKind::Pdf,
        Some("svg") => PreviewKind::VectorSvg,
        Some("ai") => PreviewKind::VectorAi,
        Some("dxf") => PreviewKind::VectorDxf,
        Some("eps") => PreviewKind::VectorEps,
        Some("sldprt" | "sldasm" | "slddrw") => PreviewKind::SolidWorks,
        Some("step" | "stp" | "stl" | "glb" | "gltf" | "obj") => PreviewKind::Cad3d,
        Some("txt" | "json" | "yaml" | "yml" | "csv" | "log" | "xml" | "toml") => {
            PreviewKind::PlainText
        }
        _ => PreviewKind::Unsupported,
    }
}

/// Returns whether the file supports in-app editing in Phase 1.
pub fn is_editable_in_app(kind: PreviewKind) -> bool {
    matches!(kind, PreviewKind::Markdown)
}

/// Returns whether an image extension should be transcoded to PNG by the Rust proxy for
/// consistent WebView2/WKWebView rendering.
pub fn needs_png_transcode(file_name: &str) -> bool {
    matches!(
        Path::new(file_name)
            .extension()
            .and_then(|e| e.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("tif" | "tiff" | "bmp")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_phase_one_formats() {
        assert_eq!(classify_preview("README.MD"), PreviewKind::Markdown);
        assert_eq!(classify_preview("bracket.SLDPRT"), PreviewKind::SolidWorks);
        assert_eq!(classify_preview("assembly.sldasm"), PreviewKind::SolidWorks);
        assert_eq!(classify_preview("drawing.slddrw"), PreviewKind::SolidWorks);
        assert_eq!(classify_preview("logo.svg"), PreviewKind::VectorSvg);
        assert_eq!(classify_preview("poster.ai"), PreviewKind::VectorAi);
        assert_eq!(classify_preview("laser.dxf"), PreviewKind::VectorDxf);
        assert_eq!(classify_preview("demo.mp4"), PreviewKind::Video);
        assert_eq!(classify_preview("spec.pdf"), PreviewKind::Pdf);
        assert!(is_editable_in_app(PreviewKind::Markdown));
        assert!(!is_editable_in_app(PreviewKind::SolidWorks));
        assert!(needs_png_transcode("scan.tiff"));
        assert!(!needs_png_transcode("photo.png"));
    }
}
