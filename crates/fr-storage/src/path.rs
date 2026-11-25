use std::fmt;

use fr_core::{FrError, Result};
use serde::{Deserialize, Serialize};
use specta::Type;

/// Normalized, POSIX-style virtual cloud path always starting with `/`.
///
/// Examples:
/// - Root: `/`
/// - Folder: `/Projects/Design`
/// - File: `/Projects/Design/spec.md`
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, Type)]
#[serde(transparent)]
pub struct CloudPath(String);

impl CloudPath {
    /// Returns the root path (`/`).
    pub fn root() -> Self {
        Self("/".to_owned())
    }

    /// Parses and normalizes an untrusted path string, rejecting path traversal (`..`).
    pub fn parse(raw: &str) -> Result<Self> {
        let normalized = raw.trim().replace('\\', "/");
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
    fn rejects_traversal_paths() {
        assert!(CloudPath::parse("/Projects/../secret").is_err());
        assert!(CloudPath::parse("..").is_err());
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
