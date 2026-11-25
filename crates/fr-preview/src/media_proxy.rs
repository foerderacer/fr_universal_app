use std::net::SocketAddr;
use std::sync::{Arc, RwLock};

use axum::Router;
use axum::body::Body;
use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use fr_core::{FrError, Result};
use fr_storage::{CloudPath, StorageBackend};
use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
use serde::Deserialize;
use subtle::ConstantTimeEq;
use tokio::net::TcpListener;
use uuid::Uuid;

use crate::image_helper::transcode_to_png;

/// Shared dynamic storage backend slot read by the local Range-streaming media proxy.
pub type SharedBackendSlot = Arc<RwLock<Option<Arc<dyn StorageBackend>>>>;

#[derive(Clone)]
struct ProxyState {
    token: String,
    backend_slot: SharedBackendSlot,
}

#[derive(Deserialize)]
struct MediaQuery {
    path: String,
    transcode: Option<String>,
}

/// Ephemeral loopback-only (`127.0.0.1:0`) HTTP server providing authenticated `Range`
/// (`206 Partial Content`) media streaming for `<video>`, `<audio>`, `pdfjs-dist`, and images.
pub struct MediaProxyServer {
    addr: SocketAddr,
    token: String,
    backend_slot: SharedBackendSlot,
    _task: tokio::task::JoinHandle<()>,
}

impl std::fmt::Debug for MediaProxyServer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MediaProxyServer")
            .field("addr", &self.addr)
            .field("token", &"[REDACTED]")
            .finish()
    }
}

impl MediaProxyServer {
    /// Starts the local media streaming server on `127.0.0.1:0` with a random 256-bit session token.
    pub async fn start(backend_slot: SharedBackendSlot) -> Result<Self> {
        let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        let state = ProxyState {
            token: token.clone(),
            backend_slot: backend_slot.clone(),
        };

        let app = Router::new()
            .route(
                "/media/{token}",
                get(handle_media_get).head(handle_media_head),
            )
            .with_state(state);

        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|err| FrError::Other(format!("failed to bind media proxy: {err}")))?;
        let addr = listener
            .local_addr()
            .map_err(|err| FrError::Other(format!("failed to inspect media proxy addr: {err}")))?;

        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        Ok(Self {
            addr,
            token,
            backend_slot,
            _task: task,
        })
    }

    pub fn addr(&self) -> SocketAddr {
        self.addr
    }

    pub fn backend_slot(&self) -> &SharedBackendSlot {
        &self.backend_slot
    }

    /// Builds an authenticated loopback URL for streaming `cloud_path` from the active backend.
    pub fn media_url(&self, cloud_path: &CloudPath, transcode_png: bool) -> String {
        let encoded_path = utf8_percent_encode(cloud_path.as_str(), NON_ALPHANUMERIC);
        if transcode_png {
            format!(
                "http://127.0.0.1:{}/media/{}?path={}&transcode=png",
                self.addr.port(),
                self.token,
                encoded_path
            )
        } else {
            format!(
                "http://127.0.0.1:{}/media/{}?path={}",
                self.addr.port(),
                self.token,
                encoded_path
            )
        }
    }
}

fn verify_token(expected: &str, supplied: &str) -> bool {
    expected.len() == supplied.len() && bool::from(expected.as_bytes().ct_eq(supplied.as_bytes()))
}

fn guess_content_type(path: &CloudPath, mime_from_stat: Option<&str>) -> String {
    if let Some(mime) = mime_from_stat
        && !mime.is_empty()
        && mime != "application/octet-stream"
    {
        return mime.to_owned();
    }
    let ext = path
        .file_name()
        .and_then(|n| n.rsplit('.').next())
        .map(str::to_ascii_lowercase);
    match ext.as_deref() {
        Some("mp4" | "m4v") => "video/mp4",
        Some("webm") => "video/webm",
        Some("mov") => "video/quicktime",
        Some("mkv") => "video/x-matroska",
        Some("pdf" | "ai") => "application/pdf",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        Some("bmp") => "image/bmp",
        Some("svg") => "image/svg+xml",
        Some("stl") => "model/stl",
        Some("glb") => "model/gltf-binary",
        _ => "application/octet-stream",
    }
    .to_owned()
}

fn parse_byte_range(raw: &str, total_len: u64) -> std::result::Result<(u64, u64), ()> {
    if total_len == 0 {
        return Err(());
    }
    let spec = raw.trim().strip_prefix("bytes=").ok_or(())?;
    // Multi-range requests aren't needed for WebView media; serve first range cleanly.
    let first = spec.split(',').next().ok_or(())?.trim();
    let (start_str, end_str) = first.split_once('-').ok_or(())?;

    if start_str.is_empty() {
        // Suffix range: bytes=-500
        let suffix: u64 = end_str.parse().map_err(|_| ())?;
        if suffix == 0 {
            return Err(());
        }
        let start = total_len.saturating_sub(suffix);
        Ok((start, total_len - 1))
    } else {
        let start: u64 = start_str.parse().map_err(|_| ())?;
        if start >= total_len {
            return Err(());
        }
        let end = if end_str.is_empty() {
            total_len - 1
        } else {
            let parsed: u64 = end_str.parse().map_err(|_| ())?;
            parsed.min(total_len - 1)
        };
        if end < start {
            return Err(());
        }
        Ok((start, end))
    }
}

fn base_security_headers(builder: axum::http::response::Builder) -> axum::http::response::Builder {
    builder
        .header(header::CACHE_CONTROL, "private, no-store")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header("Access-Control-Allow-Origin", "*")
        .header(header::ACCEPT_RANGES, "bytes")
}

async fn handle_media_head(
    State(state): State<ProxyState>,
    AxumPath(token): AxumPath<String>,
    Query(query): Query<MediaQuery>,
) -> Response {
    if !verify_token(&state.token, &token) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Ok(cloud_path) = CloudPath::parse(&query.path) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let backend = match state.backend_slot.read() {
        Ok(guard) => guard.clone(),
        Err(_) => None,
    };
    let Some(backend) = backend else {
        return StatusCode::UNAUTHORIZED.into_response();
    };

    match backend.stat(&cloud_path).await {
        Ok(entry) => {
            let content_type = if query.transcode.as_deref() == Some("png") {
                "image/png".to_owned()
            } else {
                guess_content_type(&cloud_path, entry.mime_type.as_deref())
            };
            base_security_headers(Response::builder())
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, content_type)
                .header(header::CONTENT_LENGTH, entry.size.to_string())
                .body(Body::empty())
                .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
        }
        Err(FrError::NotFound(_)) => StatusCode::NOT_FOUND.into_response(),
        Err(FrError::AuthRequired(_)) => StatusCode::UNAUTHORIZED.into_response(),
        Err(_) => StatusCode::BAD_GATEWAY.into_response(),
    }
}

async fn handle_media_get(
    State(state): State<ProxyState>,
    AxumPath(token): AxumPath<String>,
    Query(query): Query<MediaQuery>,
    headers: HeaderMap,
) -> Response {
    if !verify_token(&state.token, &token) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Ok(cloud_path) = CloudPath::parse(&query.path) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let backend = match state.backend_slot.read() {
        Ok(guard) => guard.clone(),
        Err(_) => None,
    };
    let Some(backend) = backend else {
        return StatusCode::UNAUTHORIZED.into_response();
    };

    // Transcode TIFF/BMP to PNG on demand when requested.
    if query.transcode.as_deref() == Some("png") {
        return match backend.read(&cloud_path).await {
            Ok((bytes, _)) => match transcode_to_png(&bytes) {
                Ok(png) => base_security_headers(Response::builder())
                    .status(StatusCode::OK)
                    .header(header::CONTENT_TYPE, "image/png")
                    .header(header::CONTENT_LENGTH, png.len().to_string())
                    .body(Body::from(png))
                    .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response()),
                Err(_) => StatusCode::UNPROCESSABLE_ENTITY.into_response(),
            },
            Err(FrError::NotFound(_)) => StatusCode::NOT_FOUND.into_response(),
            Err(FrError::AuthRequired(_)) => StatusCode::UNAUTHORIZED.into_response(),
            Err(_) => StatusCode::BAD_GATEWAY.into_response(),
        };
    }

    let entry = match backend.stat(&cloud_path).await {
        Ok(e) => e,
        Err(FrError::NotFound(_)) => return StatusCode::NOT_FOUND.into_response(),
        Err(FrError::AuthRequired(_)) => return StatusCode::UNAUTHORIZED.into_response(),
        Err(_) => return StatusCode::BAD_GATEWAY.into_response(),
    };

    let content_type = guess_content_type(&cloud_path, entry.mime_type.as_deref());
    let total_len = entry.size;

    if let Some(range_val) = headers.get(header::RANGE).and_then(|v| v.to_str().ok()) {
        let Ok((start, end)) = parse_byte_range(range_val, total_len) else {
            return Response::builder()
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(
                    header::CONTENT_RANGE,
                    HeaderValue::from_str(&format!("bytes */{total_len}"))
                        .unwrap_or_else(|_| HeaderValue::from_static("bytes */0")),
                )
                .body(Body::empty())
                .unwrap_or_else(|_| StatusCode::RANGE_NOT_SATISFIABLE.into_response());
        };

        // Cap individual range responses to 4 MiB chunks for snappy video seeking & bounded RAM.
        let capped_end = end.min(start.saturating_add(4 * 1024 * 1024 - 1));
        return match backend
            .read_range(&cloud_path, start, Some(capped_end))
            .await
        {
            Ok(bytes) => {
                let actual_end = start.saturating_add(bytes.len().saturating_sub(1) as u64);
                base_security_headers(Response::builder())
                    .status(StatusCode::PARTIAL_CONTENT)
                    .header(header::CONTENT_TYPE, content_type)
                    .header(header::CONTENT_LENGTH, bytes.len().to_string())
                    .header(
                        header::CONTENT_RANGE,
                        format!("bytes {start}-{actual_end}/{total_len}"),
                    )
                    .body(Body::from(bytes))
                    .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
            }
            Err(FrError::NotFound(_)) => StatusCode::NOT_FOUND.into_response(),
            Err(FrError::AuthRequired(_)) => StatusCode::UNAUTHORIZED.into_response(),
            Err(_) => StatusCode::BAD_GATEWAY.into_response(),
        };
    }

    match backend.read(&cloud_path).await {
        Ok((bytes, _)) => base_security_headers(Response::builder())
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, content_type)
            .header(header::CONTENT_LENGTH, bytes.len().to_string())
            .body(Body::from(bytes))
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response()),
        Err(FrError::NotFound(_)) => StatusCode::NOT_FOUND.into_response(),
        Err(FrError::AuthRequired(_)) => StatusCode::UNAUTHORIZED.into_response(),
        Err(_) => StatusCode::BAD_GATEWAY.into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bytes::Bytes;
    use fr_storage::LocalFsBackend;
    use tempfile::tempdir;

    #[tokio::test]
    async fn media_proxy_enforces_token_and_serves_byte_ranges() {
        let dir = tempdir().expect("tempdir");
        let local = Arc::new(LocalFsBackend::new(dir.path()));
        let video_path = CloudPath::parse("/demo.mp4").unwrap();
        local
            .write(&video_path, Bytes::from_static(b"0123456789abcdef"), None)
            .await
            .unwrap();

        let slot: SharedBackendSlot = Arc::new(RwLock::new(Some(local)));
        let proxy = MediaProxyServer::start(slot).await.unwrap();
        let client = reqwest::Client::new();

        // Wrong token must be rejected with 403.
        let bad_url = format!(
            "http://127.0.0.1:{}/media/wrong-token?path=%2Fdemo.mp4",
            proxy.addr().port()
        );
        let bad_resp = client.get(&bad_url).send().await.unwrap();
        assert_eq!(bad_resp.status(), reqwest::StatusCode::FORBIDDEN);

        // Valid full GET returns 200.
        let url = proxy.media_url(&video_path, false);
        let full_resp = client.get(&url).send().await.unwrap();
        assert_eq!(full_resp.status(), reqwest::StatusCode::OK);
        assert_eq!(
            full_resp.bytes().await.unwrap().as_ref(),
            b"0123456789abcdef"
        );

        // Byte range returns 206 Partial Content with Content-Range.
        let range_resp = client
            .get(&url)
            .header("Range", "bytes=4-9")
            .send()
            .await
            .unwrap();
        assert_eq!(range_resp.status(), reqwest::StatusCode::PARTIAL_CONTENT);
        assert_eq!(
            range_resp.headers().get("content-range").unwrap(),
            "bytes 4-9/16"
        );
        assert_eq!(range_resp.bytes().await.unwrap().as_ref(), b"456789");

        // Out-of-bounds range returns 416.
        let oob = client
            .get(&url)
            .header("Range", "bytes=99-120")
            .send()
            .await
            .unwrap();
        assert_eq!(oob.status(), reqwest::StatusCode::RANGE_NOT_SATISFIABLE);
    }
}
