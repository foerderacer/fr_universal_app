use std::fmt;
use std::path::{Component, Path};

use fr_core::{FrError, Result};
use serde::{Deserialize, Deserializer, Serialize};
use specta::Type;

/// Normalized, POSIX-style virtual cloud path always starting with `/`.
///
/// Examples:
/// - Root: `/`
/// - Folder: `/Projects/Design`
/// - File: `/Projects/Design/spec.md`
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Type)]
#[serde(transparent)]
pub struct CloudPath(String);

impl<'de> Deserialize<'de> for CloudPath {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = String::deserialize(deserializer)?;
        CloudPath::parse(&raw).map_err(serde::de::Error::custom)
    }
}

impl CloudPath {
    /// Returns the root path (`/`).
    pub fn root() -> Self {
        Self("/".to_owned())
    }

    /// Parses and normalizes an untrusted path string, rejecting path traversal (`..`),
    /// Windows drive/UNC prefixes, colons, and null bytes.
    pub fn parse(raw: &str) -> Result<Self> {
        let normalized = raw.trim().replace('\\', "/");
        if normalized.starts_with("//") {
            return Err(FrError::InvalidPath(format!(
                "UNC and double-slash network prefixes are not allowed: {raw}"
            )));
        }

        if normalized.is_empty() || normalized == "/" {
            return Ok(Self::root());
        }

        let mut segments = Vec::new();
        for segment in normalized.split('/') {
            if segment.is_empty() || segment == "." {
                continue;
            }
            if segment == ".." {
                return Err(FrError::InvalidPath(format!(
                    "parent directory traversal is not allowed: {raw}"
                )));
            }
            if segment.contains('\0') {
                return Err(FrError::InvalidPath(
                    "null bytes are not allowed in paths".into(),
                ));
            }
            if segment.contains(':') {
                return Err(FrError::InvalidPath(format!(
                    "colon characters and drive prefixes are not allowed: {raw}"
                )));
            }
            // Double-check against OS path component parsing so no platform-specific prefix
            // or root component can ever alter `PathBuf::push`.
            let mut comps = Path::new(segment).components();
            match (comps.next(), comps.next()) {
                (Some(Component::Normal(_)), None) => {}
                _ => {
                    return Err(FrError::InvalidPath(format!(
                        "invalid path segment '{segment}' in '{raw}'"
                    )));
                }
            }
            segments.push(segment);
        }

        if segments.is_empty() {
            Ok(Self::root())
        } else {
            Ok(Self(format!("/{}", segments.join("/"))))
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn is_root(&self) -> bool {
        self.0 == "/"
    }

    /// Returns the relative segments without leading slash (empty slice for `/`).
    pub fn segments(&self) -> impl Iterator<Item = &str> {
        self.0
            .trim_start_matches('/')
            .split('/')
            .filter(|s| !s.is_empty())
    }

    /// Returns the final component (file or folder name), or `None` for `/`.
    pub fn file_name(&self) -> Option<&str> {
        if self.is_root() {
            None
        } else {
            self.0.rsplit('/').next()
        }
    }

    /// Joins a child path segment onto this path.
    pub fn join(&self, child: &str) -> Result<Self> {
        let combined = if self.is_root() {
            format!("/{child}")
        } else {
            format!("{}/{child}", self.0)
        };
        Self::parse(&combined)
    }

    /// Returns the parent directory, or `None` if already at `/`.
    pub fn parent(&self) -> Option<Self> {
        if self.is_root() {
            return None;
        }
        match self.0.rfind('/') {
            Some(0) | None => Some(Self::root()),
            Some(idx) => Some(Self(self.0[..idx].to_owned())),
        }
    }
}

impl fmt::Display for CloudPath {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_valid_paths() {
        assert_eq!(CloudPath::parse("").unwrap().as_str(), "/");
        assert_eq!(CloudPath::parse("/").unwrap().as_str(), "/");
        assert_eq!(
            CloudPath::parse("Projects\\CAD//part.sldprt/")
                .unwrap()
                .as_str(),
            "/Projects/CAD/part.sldprt"
        );
    }

    #[test]
    fn rejects_traversal_and_prefix_paths() {
        assert!(CloudPath::parse("/Projects/../secret").is_err());
        assert!(CloudPath::parse("..").is_err());
        assert!(CloudPath::parse("C:/Windows/System32").is_err());
        assert!(CloudPath::parse("/folder/C:/escape").is_err());
        assert!(CloudPath::parse("file:stream").is_err());
        assert!(CloudPath::parse(r"\\server\share\file.txt").is_err());
        assert!(CloudPath::parse("//server/share/file.txt").is_err());
        assert!(CloudPath::parse(r"\/server\share\file.txt").is_err());
        assert!(CloudPath::parse(r"/\server/share/file.txt").is_err());
    }

    #[test]
    fn deserialize_validates_cloud_path() {
        let ok: CloudPath = serde_json::from_str("\"/Team/notes.md\"").unwrap();
        assert_eq!(ok.as_str(), "/Team/notes.md");

        assert!(serde_json::from_str::<CloudPath>("\"../escape\"").is_err());
        assert!(serde_json::from_str::<CloudPath>("\"C:/Windows\"").is_err());
    }

    #[test]
    fn parent_and_join_work() {
        let p = CloudPath::root()
            .join("Team")
            .unwrap()
            .join("notes.md")
            .unwrap();
        assert_eq!(p.as_str(), "/Team/notes.md");
        assert_eq!(p.file_name(), Some("notes.md"));
        assert_eq!(p.parent().unwrap().as_str(), "/Team");
        assert_eq!(p.parent().unwrap().parent().unwrap().as_str(), "/");
        assert!(CloudPath::root().parent().is_none());
    }
}
