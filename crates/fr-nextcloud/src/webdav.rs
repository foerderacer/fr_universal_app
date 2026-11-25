use async_trait::async_trait;
use bytes::Bytes;
use chrono::{DateTime, Utc};
use fr_core::{FrError, Result};
use fr_storage::{CloudPath, Etag, FileEntry, FileKind, StorageBackend};
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, percent_decode_str, utf8_percent_encode};
use quick_xml::Reader;
use quick_xml::events::Event;
use reqwest::{Method, StatusCode};
use url::Url;
use uuid::Uuid;

use crate::auth::NextcloudCredentials;
use crate::build_http_client;

/// Files larger than 10 MiB automatically use Nextcloud Chunked Upload v2.
pub const DEFAULT_CHUNK_THRESHOLD: usize = 10 * 1024 * 1024;
/// Default chunk size (5 MiB) for Nextcloud Chunked Upload v2.
pub const DEFAULT_CHUNK_SIZE: usize = 5 * 1024 * 1024;

/// Characters kept unencoded inside a single WebDAV URL path segment (RFC 3986 pchar subset).
const PATH_SEGMENT_ENCODE_SET: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'~');

const PROPFIND_BODY: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns">
  <d:prop>
    <d:resourcetype/>
    <d:getcontentlength/>
    <d:getcontenttype/>
    <d:getetag/>
    <d:getlastmodified/>
    <oc:fileid/>
    <oc:id/>
  </d:prop>
</d:propfind>"#;

/// Production [`StorageBackend`] communicating directly with Nextcloud WebDAV & Preview APIs.
#[derive(Clone)]
pub struct NextcloudBackend {
    client: reqwest::Client,
    creds: NextcloudCredentials,
    dav_base_path: String,
    chunk_threshold: usize,
    chunk_size: usize,
}

impl std::fmt::Debug for NextcloudBackend {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NextcloudBackend")
            .field("server_url", &self.creds.server_url)
            .field("login_name", &self.creds.login_name)
            .finish()
    }
}

impl NextcloudBackend {
    pub fn new(creds: NextcloudCredentials) -> Result<Self> {
        let client = build_http_client()?;
        Self::with_client(client, creds)
    }

    pub fn with_client(client: reqwest::Client, creds: NextcloudCredentials) -> Result<Self> {
        let parsed = Url::parse(&creds.server_url)
            .map_err(|err| FrError::InvalidConfig(format!("invalid Nextcloud URL: {err}")))?;
        let base_prefix = parsed.path().trim_end_matches('/');
        let encoded_user = utf8_percent_encode(&creds.login_name, PATH_SEGMENT_ENCODE_SET);
        let dav_base_path = format!("{base_prefix}/remote.php/dav/files/{encoded_user}");

        Ok(Self {
            client,
            creds,
            dav_base_path,
            chunk_threshold: DEFAULT_CHUNK_THRESHOLD,
            chunk_size: DEFAULT_CHUNK_SIZE,
        })
    }

    /// Overrides chunked upload thresholds (useful for testing chunked uploads with small buffers).
    pub fn with_chunk_config(mut self, threshold: usize, chunk_size: usize) -> Self {
        self.chunk_threshold = threshold.max(1);
        self.chunk_size = chunk_size.max(1);
        self
    }

    pub fn credentials(&self) -> &NextcloudCredentials {
        &self.creds
    }

    fn dav_url(&self, path: &CloudPath) -> String {
        let mut url = format!(
            "{}/remote.php/dav/files/{}",
            self.creds.server_url,
            utf8_percent_encode(&self.creds.login_name, PATH_SEGMENT_ENCODE_SET)
        );
        for seg in path.segments() {
            url.push('/');
            url.push_str(&utf8_percent_encode(seg, PATH_SEGMENT_ENCODE_SET).to_string());
        }
        url
    }

    fn uploads_base_url(&self, upload_id: &str) -> String {
        format!(
            "{}/remote.php/dav/uploads/{}/{}",
            self.creds.server_url,
            utf8_percent_encode(&self.creds.login_name, PATH_SEGMENT_ENCODE_SET),
            utf8_percent_encode(upload_id, PATH_SEGMENT_ENCODE_SET)
        )
    }

    fn normalize_etag(raw: &str) -> Etag {
        let trimmed = raw.trim();
        let no_weak = trimmed
            .strip_prefix("W/")
            .or_else(|| trimmed.strip_prefix("w/"))
            .unwrap_or(trimmed);
        Etag::new(no_weak.trim_matches('"'))
    }

    fn format_if_match(etag: &Etag) -> String {
        let clean = etag.as_str().trim_matches('"');
        format!("\"{clean}\"")
    }

    fn map_status_error(
        status: StatusCode,
        path: &CloudPath,
        expected_etag: Option<&Etag>,
    ) -> FrError {
        match status {
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
                FrError::AuthRequired("Nextcloud session expired or unauthorized".into())
            }
            StatusCode::NOT_FOUND => FrError::NotFound(path.to_string()),
            StatusCode::METHOD_NOT_ALLOWED | StatusCode::CONFLICT => {
                FrError::AlreadyExists(path.to_string())
            }
            StatusCode::PRECONDITION_FAILED => FrError::Conflict {
                path: path.to_string(),
                expected: expected_etag
                    .map(|e| e.as_str().to_owned())
                    .unwrap_or_default(),
                actual: "modified-on-server".into(),
            },
            other => FrError::Network(format!(
                "Nextcloud WebDAV request for '{path}' failed with HTTP {}",
                other.as_u16()
            )),
        }
    }

    async fn propfind(&self, path: &CloudPath, depth: &str) -> Result<Vec<FileEntry>> {
        let method = Method::from_bytes(b"PROPFIND")
            .map_err(|err| FrError::Other(format!("invalid WebDAV method: {err}")))?;
        let url = self.dav_url(path);

        let resp = self
            .client
            .request(method, &url)
            .basic_auth(&self.creds.login_name, Some(&self.creds.app_password))
            .header("Depth", depth)
            .header("Content-Type", "application/xml; charset=utf-8")
            .body(PROPFIND_BODY)
            .send()
            .await
            .map_err(|err| FrError::Network(format!("PROPFIND failed: {err}")))?;

        if !resp.status().is_success() && resp.status() != StatusCode::MULTI_STATUS {
            return Err(Self::map_status_error(resp.status(), path, None));
        }

        let xml = resp
            .text()
            .await
            .map_err(|err| FrError::Network(format!("failed reading PROPFIND XML: {err}")))?;

        parse_multistatus_xml(&xml, &self.dav_base_path, path, depth == "1")
    }

    async fn write_chunked(
        &self,
        path: &CloudPath,
        data: Bytes,
        expected_etag: Option<&Etag>,
    ) -> Result<Etag> {
        let upload_id = format!("fr-{}", Uuid::new_v4());
        let upload_dir_url = self.uploads_base_url(&upload_id);
        let mkcol = Method::from_bytes(b"MKCOL")
            .map_err(|err| FrError::Other(format!("invalid MKCOL method: {err}")))?;

        let mkcol_resp = self
            .client
            .request(mkcol, &upload_dir_url)
            .basic_auth(&self.creds.login_name, Some(&self.creds.app_password))
            .send()
            .await
            .map_err(|err| FrError::Network(format!("chunked upload MKCOL failed: {err}")))?;
        if !mkcol_resp.status().is_success() {
            return Err(Self::map_status_error(
                mkcol_resp.status(),
                path,
                expected_etag,
            ));
        }

        let total_len = data.len();
        let mut offset = 0usize;
        let mut part_index = 1usize;

        while offset < total_len {
            let end = (offset + self.chunk_size).min(total_len);
            let chunk = data.slice(offset..end);
            let part_url = format!("{upload_dir_url}/{part_index:08}");

            let put_res = self
                .client
                .put(&part_url)
                .basic_auth(&self.creds.login_name, Some(&self.creds.app_password))
                .header("OC-Total-Length", total_len.to_string())
                .body(chunk)
                .send()
                .await;

            match put_res {
                Ok(resp) if resp.status().is_success() => {}
                Ok(resp) => {
                    let _ = self.abort_chunked_upload(&upload_dir_url).await;
                    return Err(Self::map_status_error(resp.status(), path, expected_etag));
                }
                Err(err) => {
                    let _ = self.abort_chunked_upload(&upload_dir_url).await;
                    return Err(FrError::Network(format!("chunk upload failed: {err}")));
                }
            }

            offset = end;
            part_index += 1;
        }

        let move_method = Method::from_bytes(b"MOVE")
            .map_err(|err| FrError::Other(format!("invalid MOVE method: {err}")))?;
        let assemble_url = format!("{upload_dir_url}/.file");
        let dest_url = self.dav_url(path);

        let mut req = self
            .client
            .request(move_method, &assemble_url)
            .basic_auth(&self.creds.login_name, Some(&self.creds.app_password))
            .header("Destination", dest_url)
            .header("OC-Total-Length", total_len.to_string());

        if let Some(etag) = expected_etag {
            req = req.header("If-Match", Self::format_if_match(etag));
        }

        let move_resp = req.send().await.map_err(|err| {
            FrError::Network(format!("chunked upload assemble MOVE failed: {err}"))
        })?;

        if !move_resp.status().is_success() {
            let status = move_resp.status();
            let _ = self.abort_chunked_upload(&upload_dir_url).await;
            return Err(Self::map_status_error(status, path, expected_etag));
        }

        let new_etag = move_resp
            .headers()
            .get("etag")
            .and_then(|v| v.to_str().ok())
            .map(Self::normalize_etag);

        if let Some(etag) = new_etag {
            Ok(etag)
        } else {
            let entry = self.stat(path).await?;
            Ok(entry.etag.unwrap_or_else(|| Etag::new("")))
        }
    }

    async fn abort_chunked_upload(&self, upload_dir_url: &str) -> Result<()> {
        let _ = self
            .client
            .delete(upload_dir_url)
            .basic_auth(&self.creds.login_name, Some(&self.creds.app_password))
            .send()
            .await;
        Ok(())
    }
}

#[async_trait]
impl StorageBackend for NextcloudBackend {
    async fn list(&self, path: &CloudPath) -> Result<Vec<FileEntry>> {
        let mut entries = self.propfind(path, "1").await?;
        entries.sort_by(|a, b| {
            let rank = |k: FileKind| match k {
                FileKind::Directory => 0_u8,
                FileKind::File => 1_u8,
            };
            rank(a.kind)
                .cmp(&rank(b.kind))
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Ok(entries)
    }

    async fn stat(&self, path: &CloudPath) -> Result<FileEntry> {
        let mut entries = self.propfind(path, "0").await?;
        entries
            .pop()
            .ok_or_else(|| FrError::NotFound(path.to_string()))
    }

    async fn read(&self, path: &CloudPath) -> Result<(Bytes, Etag)> {
        let url = self.dav_url(path);
        let resp = self
            .client
            .get(&url)
            .basic_auth(&self.creds.login_name, Some(&self.creds.app_password))
            .send()
            .await
            .map_err(|err| FrError::Network(format!("WebDAV GET failed: {err}")))?;

        if !resp.status().is_success() {
            return Err(Self::map_status_error(resp.status(), path, None));
        }

        let etag = resp
            .headers()
            .get("etag")
            .and_then(|v| v.to_str().ok())
            .map(Self::normalize_etag)
            .unwrap_or_else(|| Etag::new(""));

        let bytes = resp
            .bytes()
            .await
            .map_err(|err| FrError::Network(format!("failed reading response body: {err}")))?;

        Ok((bytes, etag))
    }

    async fn read_range(&self, path: &CloudPath, start: u64, end: Option<u64>) -> Result<Bytes> {
        let url = self.dav_url(path);
        let range_header = match end {
            Some(inclusive_end) => format!("bytes={start}-{inclusive_end}"),
            None => format!("bytes={start}-"),
        };

        let resp = self
            .client
            .get(&url)
            .basic_auth(&self.creds.login_name, Some(&self.creds.app_password))
            .header("Range", range_header)
            .send()
            .await
            .map_err(|err| FrError::Network(format!("WebDAV range GET failed: {err}")))?;

        if resp.status() == StatusCode::RANGE_NOT_SATISFIABLE {
            return Ok(Bytes::new());
        }
        if !resp.status().is_success() {
            return Err(Self::map_status_error(resp.status(), path, None));
        }

        let status = resp.status();
        let bytes = resp
            .bytes()
            .await
            .map_err(|err| FrError::Network(format!("failed reading range body: {err}")))?;

        // If the server returned 200 OK (ignored Range), slice locally to honor the contract.
        if status == StatusCode::OK {
            let len = bytes.len() as u64;
            if start >= len {
                return Ok(Bytes::new());
            }
            let inclusive_end = end.unwrap_or(len - 1).min(len - 1);
            if inclusive_end < start {
                return Ok(Bytes::new());
            }
            return Ok(bytes.slice((start as usize)..=(inclusive_end as usize)));
        }

        Ok(bytes)
    }

    async fn write(
        &self,
        path: &CloudPath,
        data: Bytes,
        expected_etag: Option<&Etag>,
    ) -> Result<Etag> {
        if path.is_root() {
            return Err(FrError::InvalidPath("cannot write directly to root".into()));
        }

        if data.len() > self.chunk_threshold {
            return self.write_chunked(path, data, expected_etag).await;
        }

        let url = self.dav_url(path);
        let mut req = self
            .client
            .put(&url)
            .basic_auth(&self.creds.login_name, Some(&self.creds.app_password))
            .body(data);

        if let Some(etag) = expected_etag {
            req = req.header("If-Match", Self::format_if_match(etag));
        }

        let resp = req
            .send()
            .await
            .map_err(|err| FrError::Network(format!("WebDAV PUT failed: {err}")))?;

        if !resp.status().is_success() {
            return Err(Self::map_status_error(resp.status(), path, expected_etag));
        }

        if let Some(etag) = resp
            .headers()
            .get("etag")
            .and_then(|v| v.to_str().ok())
            .map(Self::normalize_etag)
        {
            Ok(etag)
        } else {
            let entry = self.stat(path).await?;
            Ok(entry.etag.unwrap_or_else(|| Etag::new("")))
        }
    }

    async fn mkdir(&self, path: &CloudPath) -> Result<()> {
        if path.is_root() {
            return Ok(());
        }
        let method = Method::from_bytes(b"MKCOL")
            .map_err(|err| FrError::Other(format!("invalid MKCOL method: {err}")))?;
        let url = self.dav_url(path);

        let resp = self
            .client
            .request(method, &url)
            .basic_auth(&self.creds.login_name, Some(&self.creds.app_password))
            .send()
            .await
            .map_err(|err| FrError::Network(format!("WebDAV MKCOL failed: {err}")))?;

        if !resp.status().is_success() {
            return Err(Self::map_status_error(resp.status(), path, None));
        }
        Ok(())
    }

    async fn rename(&self, from: &CloudPath, to: &CloudPath) -> Result<()> {
        if from.is_root() || to.is_root() {
            return Err(FrError::InvalidPath("cannot rename root directory".into()));
        }
        let method = Method::from_bytes(b"MOVE")
            .map_err(|err| FrError::Other(format!("invalid MOVE method: {err}")))?;
        let from_url = self.dav_url(from);
        let to_url = self.dav_url(to);

        let resp = self
            .client
            .request(method, &from_url)
            .basic_auth(&self.creds.login_name, Some(&self.creds.app_password))
            .header("Destination", to_url)
            .header("Overwrite", "F")
            .send()
            .await
            .map_err(|err| FrError::Network(format!("WebDAV MOVE failed: {err}")))?;

        if !resp.status().is_success() {
            return Err(Self::map_status_error(resp.status(), from, None));
        }
        Ok(())
    }

    async fn delete(&self, path: &CloudPath) -> Result<()> {
        if path.is_root() {
            return Err(FrError::InvalidPath("cannot delete root directory".into()));
        }
        let url = self.dav_url(path);
        let resp = self
            .client
            .delete(&url)
            .basic_auth(&self.creds.login_name, Some(&self.creds.app_password))
            .send()
            .await
            .map_err(|err| FrError::Network(format!("WebDAV DELETE failed: {err}")))?;

        if !resp.status().is_success() {
            return Err(Self::map_status_error(resp.status(), path, None));
        }
        Ok(())
    }

    async fn thumbnail(&self, file_id: &str, width: u32, height: u32) -> Result<Option<Bytes>> {
        if file_id.trim().is_empty() {
            return Ok(None);
        }
        let mut url = Url::parse(&format!("{}/index.php/core/preview", self.creds.server_url))
            .map_err(|err| FrError::InvalidConfig(format!("invalid preview URL: {err}")))?;
        url.query_pairs_mut()
            .append_pair("fileId", file_id)
            .append_pair("x", &width.to_string())
            .append_pair("y", &height.to_string())
            .append_pair("a", "true");

        let resp = self
            .client
            .get(url)
            .basic_auth(&self.creds.login_name, Some(&self.creds.app_password))
            .send()
            .await
            .map_err(|err| FrError::Network(format!("thumbnail fetch failed: {err}")))?;

        match resp.status() {
            StatusCode::OK => {
                let bytes = resp
                    .bytes()
                    .await
                    .map_err(|err| FrError::Network(format!("thumbnail body error: {err}")))?;
                Ok(Some(bytes))
            }
            StatusCode::NOT_FOUND
            | StatusCode::UNSUPPORTED_MEDIA_TYPE
            | StatusCode::BAD_REQUEST => Ok(None),
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
                Err(FrError::AuthRequired("Nextcloud session expired".into()))
            }
            other => Err(FrError::Network(format!(
                "Nextcloud thumbnail endpoint returned HTTP {}",
                other.as_u16()
            ))),
        }
    }
}

fn local_name(raw: &str) -> String {
    raw.rsplit(':').next().unwrap_or(raw).to_ascii_lowercase()
}

fn href_to_cloud_path(href: &str, dav_base_path: &str) -> Option<CloudPath> {
    let path_only = if href.contains("://") {
        Url::parse(href).ok()?.path().to_owned()
    } else {
        href.to_owned()
    };

    let decoded_href = percent_decode_str(&path_only).decode_utf8().ok()?;
    let decoded_base = percent_decode_str(dav_base_path).decode_utf8().ok()?;

    let trimmed_href = decoded_href.trim_end_matches('/');
    let trimmed_base = decoded_base.trim_end_matches('/');

    let rel = trimmed_href.strip_prefix(trimmed_base)?;
    if rel.is_empty() {
        Some(CloudPath::root())
    } else {
        CloudPath::parse(rel).ok()
    }
}

#[derive(Default)]
struct RawPropStat {
    status: String,
    is_collection: bool,
    size: u64,
    mime_type: Option<String>,
    etag: Option<Etag>,
    modified_at: Option<DateTime<Utc>>,
    file_id: Option<String>,
}

#[derive(Default)]
struct RawResponse {
    href: String,
    propstats: Vec<RawPropStat>,
}

fn parse_multistatus_xml(
    xml: &str,
    dav_base_path: &str,
    requested_path: &CloudPath,
    skip_self: bool,
) -> Result<Vec<FileEntry>> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);

    let mut responses: Vec<RawResponse> = Vec::new();
    let mut current_resp: Option<RawResponse> = None;
    let mut current_ps: Option<RawPropStat> = None;
    let mut current_tag: Option<String> = None;
    let mut tag_buf = String::new();
    let mut in_resourcetype = false;

    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => {
                let tag = local_name(e.name().as_ref());
                match tag.as_str() {
                    "response" => {
                        current_resp = Some(RawResponse::default());
                    }
                    "propstat" => {
                        current_ps = Some(RawPropStat::default());
                    }
                    "resourcetype" => {
                        in_resourcetype = true;
                    }
                    "collection" if in_resourcetype => {
                        if let Some(ps) = current_ps.as_mut() {
                            ps.is_collection = true;
                        }
                    }
                    _ => {
                        tag_buf.clear();
                        current_tag = Some(tag);
                    }
                }
            }
            Ok(Event::Empty(e)) => {
                let tag = local_name(e.name().as_ref());
                if tag == "collection"
                    && in_resourcetype
                    && let Some(ps) = current_ps.as_mut()
                {
                    ps.is_collection = true;
                }
            }
            Ok(Event::Text(e)) => {
                if current_tag.is_some() {
                    tag_buf.push_str(&e.xml10_content());
                }
            }
            Ok(Event::GeneralRef(e)) => {
                if current_tag.is_some() {
                    match e.resolve_char_ref() {
                        Ok(Some(ch)) => tag_buf.push(ch),
                        _ => match e.xml10_content().as_ref() {
                            "amp" => tag_buf.push('&'),
                            "lt" => tag_buf.push('<'),
                            "gt" => tag_buf.push('>'),
                            "quot" => tag_buf.push('"'),
                            "apos" => tag_buf.push('\''),
                            _ => {}
                        },
                    }
                }
            }
            Ok(Event::End(e)) => {
                let tag = local_name(e.name().as_ref());
                if current_tag.as_deref() == Some(tag.as_str()) {
                    let text = std::mem::take(&mut tag_buf);
                    if tag == "href" {
                        if let Some(resp) = current_resp.as_mut() {
                            resp.href = text;
                        }
                    } else if let Some(ps) = current_ps.as_mut() {
                        match tag.as_str() {
                            "status" => ps.status = text,
                            "getcontentlength" => {
                                if let Ok(v) = text.trim().parse::<u64>() {
                                    ps.size = v;
                                }
                            }
                            "getcontenttype" if !text.trim().is_empty() => {
                                ps.mime_type = Some(text.trim().to_owned());
                            }
                            "getetag" if !text.trim().is_empty() => {
                                ps.etag = Some(NextcloudBackend::normalize_etag(&text));
                            }
                            "getlastmodified" => {
                                if let Ok(dt) = DateTime::parse_from_rfc2822(text.trim()) {
                                    ps.modified_at = Some(dt.with_timezone(&Utc));
                                }
                            }
                            "fileid" if !text.trim().is_empty() => {
                                ps.file_id = Some(text.trim().to_owned());
                            }
                            "id" if ps.file_id.is_none() && !text.trim().is_empty() => {
                                ps.file_id = Some(text.trim().to_owned());
                            }
                            _ => {}
                        }
                    }
                    current_tag = None;
                }
                match tag.as_str() {
                    "response" => {
                        if let Some(resp) = current_resp.take() {
                            responses.push(resp);
                        }
                    }
                    "propstat" => {
                        if let (Some(resp), Some(ps)) = (current_resp.as_mut(), current_ps.take()) {
                            resp.propstats.push(ps);
                        }
                    }
                    "resourcetype" => {
                        in_resourcetype = false;
                    }
                    _ => {}
                }
            }
            Ok(Event::Eof) => break,
            Err(err) => {
                return Err(FrError::Network(format!(
                    "failed to parse WebDAV multistatus XML: {err}"
                )));
            }
            _ => {}
        }
    }

    let mut entries = Vec::new();
    for resp in responses {
        let Some(cloud_path) = href_to_cloud_path(&resp.href, dav_base_path) else {
            continue;
        };
        if skip_self && cloud_path == *requested_path {
            continue;
        }

        let mut is_dir = false;
        let mut size = 0u64;
        let mut mime_type = None;
        let mut etag = None;
        let mut modified_at = None;
        let mut file_id = None;

        for ps in resp.propstats {
            if !ps.status.contains(" 200") {
                continue;
            }
            is_dir |= ps.is_collection;
            if ps.size > 0 {
                size = ps.size;
            }
            if ps.mime_type.is_some() {
                mime_type = ps.mime_type;
            }
            if ps.etag.is_some() {
                etag = ps.etag;
            }
            if ps.modified_at.is_some() {
                modified_at = ps.modified_at;
            }
            if ps.file_id.is_some() {
                file_id = ps.file_id;
            }
        }

        let name = cloud_path.file_name().unwrap_or("/").to_owned();
        entries.push(FileEntry {
            id: file_id.unwrap_or_else(|| cloud_path.as_str().to_owned()),
            name,
            path: cloud_path,
            kind: if is_dir {
                FileKind::Directory
            } else {
                FileKind::File
            },
            size: if is_dir { 0 } else { size },
            mime_type: if is_dir { None } else { mime_type },
            etag,
            modified_at,
        });
    }

    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{header, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn test_backend(uri: String) -> NextcloudBackend {
        NextcloudBackend::new(NextcloudCredentials {
            server_url: uri,
            login_name: "alice".into(),
            app_password: "secret".into(),
        })
        .unwrap()
    }

    #[tokio::test]
    async fn webdav_propfind_lists_folders_and_files() {
        let server = MockServer::start().await;
        let xml = r#"<?xml version="1.0"?>
        <d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
          <d:response>
            <d:href>/remote.php/dav/files/alice/</d:href>
            <d:propstat>
              <d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop>
              <d:status>HTTP/1.1 200 OK</d:status>
            </d:propstat>
          </d:response>
          <d:response>
            <d:href>/remote.php/dav/files/alice/Team%20Docs/</d:href>
            <d:propstat>
              <d:prop>
                <d:resourcetype><d:collection/></d:resourcetype>
                <d:getetag>"dir-etag"</d:getetag>
                <oc:fileid>101</oc:fileid>
              </d:prop>
              <d:status>HTTP/1.1 200 OK</d:status>
            </d:propstat>
          </d:response>
          <d:response>
            <d:href>/remote.php/dav/files/alice/part%201.sldprt</d:href>
            <d:propstat>
              <d:prop>
                <d:resourcetype/>
                <d:getcontentlength>4096</d:getcontentlength>
                <d:getcontenttype>application/octet-stream</d:getcontenttype>
                <d:getetag>"abc123"</d:getetag>
                <d:getlastmodified>Wed, 25 Nov 2026 12:00:00 GMT</d:getlastmodified>
                <oc:fileid>202</oc:fileid>
              </d:prop>
              <d:status>HTTP/1.1 200 OK</d:status>
            </d:propstat>
          </d:response>
        </d:multistatus>"#;

        Mock::given(method("PROPFIND"))
            .and(path("/remote.php/dav/files/alice"))
            .and(header("Depth", "1"))
            .respond_with(ResponseTemplate::new(207).set_body_string(xml))
            .mount(&server)
            .await;

        let backend = test_backend(server.uri());
        let entries = backend.list(&CloudPath::root()).await.unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].name, "Team Docs");
        assert_eq!(entries[0].kind, FileKind::Directory);
        assert_eq!(entries[0].id, "101");
        assert_eq!(entries[1].name, "part 1.sldprt");
        assert_eq!(entries[1].kind, FileKind::File);
        assert_eq!(entries[1].size, 4096);
        assert_eq!(entries[1].etag, Some(Etag::new("abc123")));
        assert_eq!(entries[1].id, "202");
    }

    #[tokio::test]
    async fn webdav_put_maps_http_412_to_conflict() {
        let server = MockServer::start().await;
        Mock::given(method("PUT"))
            .and(path("/remote.php/dav/files/alice/notes.md"))
            .and(header("If-Match", "\"old-etag\""))
            .respond_with(ResponseTemplate::new(412))
            .mount(&server)
            .await;

        let backend = test_backend(server.uri());
        let err = backend
            .write(
                &CloudPath::parse("/notes.md").unwrap(),
                Bytes::from_static(b"# edited"),
                Some(&Etag::new("old-etag")),
            )
            .await
            .unwrap_err();
        assert!(matches!(err, FrError::Conflict { .. }));
    }

    #[tokio::test]
    async fn webdav_range_read_and_thumbnail() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/remote.php/dav/files/alice/video.mp4"))
            .and(header("Range", "bytes=0-3"))
            .respond_with(ResponseTemplate::new(206).set_body_bytes(b"ftyp".as_slice()))
            .mount(&server)
            .await;

        Mock::given(method("GET"))
            .and(path("/index.php/core/preview"))
            .and(query_param("fileId", "202"))
            .and(query_param("x", "256"))
            .and(query_param("y", "256"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(b"PNG".as_slice()))
            .mount(&server)
            .await;

        let backend = test_backend(server.uri());
        let range = backend
            .read_range(&CloudPath::parse("/video.mp4").unwrap(), 0, Some(3))
            .await
            .unwrap();
        assert_eq!(range, Bytes::from_static(b"ftyp"));

        let thumb = backend.thumbnail("202", 256, 256).await.unwrap();
        assert_eq!(thumb, Some(Bytes::from_static(b"PNG")));
    }

    #[tokio::test]
    async fn webdav_chunked_upload_v2_splits_and_assembles() {
        let server = MockServer::start().await;

        Mock::given(method("MKCOL"))
            .respond_with(ResponseTemplate::new(201))
            .expect(1)
            .mount(&server)
            .await;

        Mock::given(method("PUT"))
            .and(header("OC-Total-Length", "10"))
            .respond_with(ResponseTemplate::new(201))
            .expect(3)
            .mount(&server)
            .await;

        Mock::given(method("MOVE"))
            .and(header("OC-Total-Length", "10"))
            .respond_with(ResponseTemplate::new(201).insert_header("ETag", "\"chunked-etag\""))
            .expect(1)
            .mount(&server)
            .await;

        let backend = test_backend(server.uri()).with_chunk_config(5, 4);
        let etag = backend
            .write(
                &CloudPath::parse("/big.bin").unwrap(),
                Bytes::from_static(b"0123456789"),
                None,
            )
            .await
            .unwrap();
        assert_eq!(etag, Etag::new("chunked-etag"));
    }
}
