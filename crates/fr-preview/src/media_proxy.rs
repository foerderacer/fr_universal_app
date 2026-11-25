use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use axum::Router;
use axum::body::Body;
use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use bytes::Bytes;
use fr_core::{FrError, Result};
use fr_storage::{CloudPath, StorageBackend};
use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
use serde::Deserialize;
use subtle::ConstantTimeEq;
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use uuid::Uuid;

use crate::image_helper::{MAX_TRANSCODE_INPUT_BYTES, transcode_to_png};

/// Shared dynamic storage backend slot read by the local Range-streaming media proxy.
pub type SharedBackendSlot = Arc<RwLock<Option<Arc<dyn StorageBackend>>>>;

const RANGE_CHUNK_CAP: u64 = 4 * 1024 * 1024;
const STREAM_CHUNK_SIZE: u64 = 1024 * 1024;
const STAT_CACHE_TTL: Duration = Duration::from_secs(10);
const STAT_CACHE_MAX_ENTRIES: usize = 128;

#[derive(Clone)]
struct CachedStat {
    size: u64,
    content_type: String,
    fetched_at: Instant,
}

#[derive(Clone)]
struct ProxyState {
    token: String,
    backend_slot: SharedBackendSlot,
    stat_cache: Arc<Mutex<HashMap<(usize, String), CachedStat>>>,
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
    task: tokio::task::JoinHandle<()>,
}

impl Drop for MediaProxyServer {
    fn drop(&mut self) {
        self.task.abort();
    }
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
            stat_cache: Arc::new(Mutex::new(HashMap::new())),
        };

        let app = Router::new()
            .route(
                "/media/{token}",
                get(handle_media_get)
                    .head(handle_media_head)
                    .options(handle_media_options),
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
            task,
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

fn allowed_cors_origin(headers: &HeaderMap) -> Option<&str> {
    let origin = headers.get(header::ORIGIN)?.to_str().ok()?;
    let allowed = matches!(
        origin,
        "tauri://localhost"
            | "http://tauri.localhost"
            | "https://tauri.localhost"
            | "http://localhost:1420"
            | "http://127.0.0.1:1420"
    );
    if allowed { Some(origin) } else { None }
}

/// Safe media/binary MIME allowlist — never serves `text/html`, `application/xhtml+xml`, or
/// `image/svg+xml` as executable documents from the loopback proxy origin.
fn guess_safe_content_type(path: &CloudPath, mime_from_stat: Option<&str>) -> String {
    if let Some(raw_mime) = mime_from_stat {
        let base = raw_mime
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        let is_safe = matches!(
            base.as_str(),
            "video/mp4"
                | "video/webm"
                | "video/quicktime"
                | "video/x-matroska"
                | "audio/mpeg"
                | "audio/mp4"
                | "audio/ogg"
                | "audio/wav"
                | "audio/webm"
                | "image/png"
                | "image/jpeg"
                | "image/webp"
                | "image/gif"
                | "image/bmp"
                | "application/pdf"
                | "model/stl"
                | "model/gltf-binary"
                | "text/plain"
        );
        if is_safe {
            return base;
        }
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

fn with_security_and_cors(mut resp: Response, req_headers: &HeaderMap) -> Response {
    let headers = resp.headers_mut();
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("default-src 'none'; sandbox"),
    );
    headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    headers.insert(
        header::ACCESS_CONTROL_EXPOSE_HEADERS,
        HeaderValue::from_static("Content-Range, Accept-Ranges, Content-Length"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, HEAD, OPTIONS"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("Range"),
    );
    headers.insert(header::VARY, HeaderValue::from_static("Origin"));

    if let Some(origin) = allowed_cors_origin(req_headers)
        && let Ok(val) = HeaderValue::from_str(origin)
    {
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, val);
    }

    resp
}

fn error_response(status: StatusCode, req_headers: &HeaderMap) -> Response {
    with_security_and_cors(status.into_response(), req_headers)
}

fn range_not_satisfiable(total_len: u64, req_headers: &HeaderMap) -> Response {
    let resp = Response::builder()
        .status(StatusCode::RANGE_NOT_SATISFIABLE)
        .header(
            header::CONTENT_RANGE,
            HeaderValue::from_str(&format!("bytes */{total_len}"))
                .unwrap_or_else(|_| HeaderValue::from_static("bytes */0")),
        )
        .body(Body::empty())
        .unwrap_or_else(|_| StatusCode::RANGE_NOT_SATISFIABLE.into_response());
    with_security_and_cors(resp, req_headers)
}

async fn resolve_stat_cached(
    state: &ProxyState,
    backend: &Arc<dyn StorageBackend>,
    cloud_path: &CloudPath,
) -> std::result::Result<(u64, String), StatusCode> {
    let backend_ptr = Arc::as_ptr(backend) as *const () as usize;
    let key = (backend_ptr, cloud_path.as_str().to_owned());

    if let Ok(cache) = state.stat_cache.lock()
        && let Some(entry) = cache.get(&key)
        && entry.fetched_at.elapsed() < STAT_CACHE_TTL
    {
        return Ok((entry.size, entry.content_type.clone()));
    }

    let entry = backend.stat(cloud_path).await.map_err(|err| match err {
        FrError::NotFound(_) => StatusCode::NOT_FOUND,
        FrError::AuthRequired(_) => StatusCode::UNAUTHORIZED,
        _ => StatusCode::BAD_GATEWAY,
    })?;
    let content_type = guess_safe_content_type(cloud_path, entry.mime_type.as_deref());
    let size = entry.size;

    if let Ok(mut cache) = state.stat_cache.lock() {
        if cache.len() >= STAT_CACHE_MAX_ENTRIES {
            cache.retain(|_, v| v.fetched_at.elapsed() < STAT_CACHE_TTL);
            if cache.len() >= STAT_CACHE_MAX_ENTRIES {
                cache.clear();
            }
        }
        cache.insert(
            key,
            CachedStat {
                size,
                content_type: content_type.clone(),
                fetched_at: Instant::now(),
            },
        );
    }

    Ok((size, content_type))
}

async fn handle_media_options(
    State(state): State<ProxyState>,
    AxumPath(token): AxumPath<String>,
    req_headers: HeaderMap,
) -> Response {
    if !verify_token(&state.token, &token) {
        return error_response(StatusCode::FORBIDDEN, &req_headers);
    }
    with_security_and_cors(StatusCode::NO_CONTENT.into_response(), &req_headers)
}

async fn handle_media_head(
    State(state): State<ProxyState>,
    AxumPath(token): AxumPath<String>,
    Query(query): Query<MediaQuery>,
    req_headers: HeaderMap,
) -> Response {
    if !verify_token(&state.token, &token) {
        return error_response(StatusCode::FORBIDDEN, &req_headers);
    }
    let Ok(cloud_path) = CloudPath::parse(&query.path) else {
        return error_response(StatusCode::BAD_REQUEST, &req_headers);
    };
    let backend = match state.backend_slot.read() {
        Ok(guard) => guard.clone(),
        Err(_) => None,
    };
    let Some(backend) = backend else {
        return error_response(StatusCode::UNAUTHORIZED, &req_headers);
    };

    match resolve_stat_cached(&state, &backend, &cloud_path).await {
        Ok((size, content_type)) => {
            let mut builder = Response::builder().status(StatusCode::OK);
            if query.transcode.as_deref() == Some("png") {
                // Transcoded PNG byte length differs from the source file; omit Content-Length.
                builder = builder.header(header::CONTENT_TYPE, "image/png");
            } else {
                builder = builder
                    .header(header::CONTENT_TYPE, content_type)
                    .header(header::CONTENT_LENGTH, size.to_string());
            }
            let resp = builder
                .body(Body::empty())
                .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response());
            with_security_and_cors(resp, &req_headers)
        }
        Err(status) => error_response(status, &req_headers),
    }
}

async fn handle_media_get(
    State(state): State<ProxyState>,
    AxumPath(token): AxumPath<String>,
    Query(query): Query<MediaQuery>,
    req_headers: HeaderMap,
) -> Response {
    if !verify_token(&state.token, &token) {
        return error_response(StatusCode::FORBIDDEN, &req_headers);
    }
    let Ok(cloud_path) = CloudPath::parse(&query.path) else {
        return error_response(StatusCode::BAD_REQUEST, &req_headers);
    };
    let backend = match state.backend_slot.read() {
        Ok(guard) => guard.clone(),
        Err(_) => None,
    };
    let Some(backend) = backend else {
        return error_response(StatusCode::UNAUTHORIZED, &req_headers);
    };

    let (total_len, content_type) = match resolve_stat_cached(&state, &backend, &cloud_path).await {
        Ok(meta) => meta,
        Err(status) => return error_response(status, &req_headers),
    };

    // Transcode TIFF/BMP to PNG on demand with bounded size + offloaded CPU decode.
    if query.transcode.as_deref() == Some("png") {
        if total_len as usize > MAX_TRANSCODE_INPUT_BYTES {
            return error_response(StatusCode::PAYLOAD_TOO_LARGE, &req_headers);
        }
        return match backend.read(&cloud_path).await {
            Ok((bytes, _)) => {
                let encoded = tokio::task::spawn_blocking(move || transcode_to_png(&bytes)).await;
                match encoded {
                    Ok(Ok(png)) => {
                        let resp = Response::builder()
                            .status(StatusCode::OK)
                            .header(header::CONTENT_TYPE, "image/png")
                            .header(header::CONTENT_LENGTH, png.len().to_string())
                            .body(Body::from(png))
                            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response());
                        with_security_and_cors(resp, &req_headers)
                    }
                    _ => error_response(StatusCode::UNPROCESSABLE_ENTITY, &req_headers),
                }
            }
            Err(FrError::NotFound(_)) => error_response(StatusCode::NOT_FOUND, &req_headers),
            Err(FrError::AuthRequired(_)) => error_response(StatusCode::UNAUTHORIZED, &req_headers),
            Err(_) => error_response(StatusCode::BAD_GATEWAY, &req_headers),
        };
    }

    if let Some(range_val) = req_headers.get(header::RANGE).and_then(|v| v.to_str().ok()) {
        let Ok((start, end)) = parse_byte_range(range_val, total_len) else {
            return range_not_satisfiable(total_len, &req_headers);
        };

        // Cap individual range responses to 4 MiB chunks for snappy video seeking & bounded RAM.
        let capped_end = end.min(start.saturating_add(RANGE_CHUNK_CAP - 1));
        return match backend
            .read_range(&cloud_path, start, Some(capped_end))
            .await
        {
            Ok(bytes) => {
                if bytes.is_empty() {
                    return range_not_satisfiable(total_len, &req_headers);
                }
                let actual_end = start.saturating_add(bytes.len().saturating_sub(1) as u64);
                let resp = Response::builder()
                    .status(StatusCode::PARTIAL_CONTENT)
                    .header(header::CONTENT_TYPE, content_type)
                    .header(header::CONTENT_LENGTH, bytes.len().to_string())
                    .header(
                        header::CONTENT_RANGE,
                        format!("bytes {start}-{actual_end}/{total_len}"),
                    )
                    .body(Body::from(bytes))
                    .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response());
                with_security_and_cors(resp, &req_headers)
            }
            Err(FrError::NotFound(_)) => error_response(StatusCode::NOT_FOUND, &req_headers),
            Err(FrError::AuthRequired(_)) => error_response(StatusCode::UNAUTHORIZED, &req_headers),
            Err(_) => error_response(StatusCode::BAD_GATEWAY, &req_headers),
        };
    }

    // Stream full GET in bounded 1 MiB chunks so large videos/CAD files never OOM the app.
    if total_len == 0 {
        let resp = Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, content_type)
            .header(header::CONTENT_LENGTH, "0")
            .body(Body::empty())
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response());
        return with_security_and_cors(resp, &req_headers);
    }

    let (tx, rx) = mpsc::channel::<std::result::Result<Bytes, std::io::Error>>(4);
    let backend_clone = backend.clone();
    let path_clone = cloud_path.clone();
    tokio::spawn(async move {
        let mut offset = 0u64;
        while offset < total_len {
            let chunk_end = (offset.saturating_add(STREAM_CHUNK_SIZE - 1)).min(total_len - 1);
            match backend_clone
                .read_range(&path_clone, offset, Some(chunk_end))
                .await
            {
                Ok(chunk) if !chunk.is_empty() => {
                    offset = offset.saturating_add(chunk.len() as u64);
                    if tx.send(Ok(chunk)).await.is_err() {
                        break;
                    }
                }
                Ok(_) => break,
                Err(err) => {
                    let _ = tx.send(Err(std::io::Error::other(err.to_string()))).await;
                    break;
                }
            }
        }
    });

    let resp = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CONTENT_LENGTH, total_len.to_string())
        .body(Body::from_stream(ReceiverStream::new(rx)))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response());
    with_security_and_cors(resp, &req_headers)
}

#[cfg(test)]
mod tests {
    use super::*;
    use fr_storage::LocalFsBackend;
    use tempfile::tempdir;

    #[test]
    fn parses_byte_range_edge_cases() {
        assert_eq!(parse_byte_range("bytes=0-0", 10), Ok((0, 0)));
        assert_eq!(parse_byte_range("bytes=4-9", 16), Ok((4, 9)));
        assert_eq!(parse_byte_range("bytes=4-", 16), Ok((4, 15)));
        assert_eq!(parse_byte_range("bytes=4-999", 16), Ok((4, 15)));
        assert_eq!(parse_byte_range("bytes=-5", 16), Ok((11, 15)));
        assert_eq!(parse_byte_range("bytes=-50", 16), Ok((0, 15)));
        assert!(parse_byte_range("bytes=16-20", 16).is_err());
        assert!(parse_byte_range("bytes=9-4", 16).is_err());
        assert!(parse_byte_range("bytes=-0", 16).is_err());
        assert!(parse_byte_range("bytes=0-1", 0).is_err());
        assert!(parse_byte_range("items=0-1", 16).is_err());
    }

    #[test]
    fn blocks_executable_mime_types_on_proxy() {
        let html = CloudPath::parse("/evil.html").unwrap();
        assert_eq!(
            guess_safe_content_type(&html, Some("text/html; charset=utf-8")),
            "application/octet-stream"
        );
        let svg = CloudPath::parse("/logo.svg").unwrap();
        assert_eq!(
            guess_safe_content_type(&svg, Some("image/svg+xml")),
            "application/octet-stream"
        );
        let pdf = CloudPath::parse("/spec.pdf").unwrap();
        assert_eq!(
            guess_safe_content_type(&pdf, Some("application/pdf")),
            "application/pdf"
        );
    }

    #[tokio::test]
    async fn media_proxy_enforces_token_loopback_cors_and_ranges() {
        let dir = tempdir().expect("tempdir");
        let local = Arc::new(LocalFsBackend::new(dir.path()));
        let video_path = CloudPath::parse("/demo.mp4").unwrap();
        local
            .write(&video_path, Bytes::from_static(b"0123456789abcdef"), None)
            .await
            .unwrap();

        let slot: SharedBackendSlot = Arc::new(RwLock::new(Some(local)));
        let proxy = MediaProxyServer::start(slot).await.unwrap();
        assert!(proxy.addr().ip().is_loopback());

        let client = reqwest::Client::new();

        // Wrong token must be rejected with 403 and still carry CORS/security headers for app origin.
        let bad_url = format!(
            "http://127.0.0.1:{}/media/wrong-token?path=%2Fdemo.mp4",
            proxy.addr().port()
        );
        let bad_resp = client
            .get(&bad_url)
            .header("Origin", "tauri://localhost")
            .send()
            .await
            .unwrap();
        assert_eq!(bad_resp.status(), reqwest::StatusCode::FORBIDDEN);
        assert_eq!(
            bad_resp
                .headers()
                .get("access-control-allow-origin")
                .unwrap(),
            "tauri://localhost"
        );
        assert_eq!(
            bad_resp.headers().get("content-security-policy").unwrap(),
            "default-src 'none'; sandbox"
        );

        // Untrusted origin must NOT receive Access-Control-Allow-Origin.
        let url = proxy.media_url(&video_path, false);
        let untrusted = client
            .get(&url)
            .header("Origin", "https://evil.example")
            .send()
            .await
            .unwrap();
        assert!(
            untrusted
                .headers()
                .get("access-control-allow-origin")
                .is_none()
        );

        // OPTIONS preflight succeeds with Expose-Headers for pdf.js range requests.
        let preflight = client
            .request(reqwest::Method::OPTIONS, &url)
            .header("Origin", "http://localhost:1420")
            .send()
            .await
            .unwrap();
        assert_eq!(preflight.status(), reqwest::StatusCode::NO_CONTENT);
        assert!(
            preflight
                .headers()
                .get("access-control-expose-headers")
                .unwrap()
                .to_str()
                .unwrap()
                .contains("Content-Range")
        );

        // Valid streamed full GET returns 200 with exact bytes.
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

        // Out-of-bounds range returns 416 with CORS headers intact.
        let oob = client
            .get(&url)
            .header("Origin", "tauri://localhost")
            .header("Range", "bytes=99-120")
            .send()
            .await
            .unwrap();
        assert_eq!(oob.status(), reqwest::StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(
            oob.headers().get("access-control-allow-origin").unwrap(),
            "tauri://localhost"
        );
    }
}
