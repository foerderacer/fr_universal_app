//! Headless PrusaSlicer CLI runner (separate child process, never FFI).
//!
//! Spawns `<prusa-slicer> --export-gcode --load <composed.ini> --output <out.gcode> <model>`,
//! parses stdout/stderr progress lines, supports cancellation & timeout, and cleans up
//! temporary job workspaces automatically.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use bytes::Bytes;
use fr_core::{FrError, Result};
use serde::{Deserialize, Serialize};
use specta::Type;
use tempfile::TempDir;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::watch;

use crate::profiles::{
    MaterialPreset, QualityPreset, RigidityPreset, SliceOverrides, compose_prusaslicer_ini,
};
use crate::validate::{PlateBoundsMm, SliceValidationRequest, validate_slice_request};

/// Default hard timeout for a single slicing job (10 minutes).
pub const DEFAULT_SLICE_TIMEOUT: Duration = Duration::from_secs(600);

/// Detection result for the local PrusaSlicer executable.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SlicerBinaryInfo {
    pub available: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub source: String,
}

/// Real-time progress emitted while PrusaSlicer runs.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SlicerProgressEvent {
    pub job_id: String,
    pub percent: u8,
    pub stage: String,
}

/// Input to execute a headless PrusaSlicer job.
#[derive(Debug, Clone)]
pub struct SliceEngineRequest {
    pub job_id: String,
    pub model_file_name: String,
    pub model_bytes: Bytes,
    pub bounds: Option<PlateBoundsMm>,
    pub quality: QualityPreset,
    pub rigidity: RigidityPreset,
    pub material: MaterialPreset,
    pub overrides: SliceOverrides,
    pub timeout: Duration,
}

/// Finished slicing output (G-code bytes + extracted summary comments — no layer preview).
#[derive(Debug, Clone)]
pub struct SliceEngineResult {
    pub gcode_bytes: Bytes,
    pub estimated_time: Option<String>,
    pub filament_grams: Option<f64>,
    pub filament_mm: Option<f64>,
    pub engine_log: String,
}

#[derive(Debug, Clone)]
pub struct PrusaSlicerEngine {
    binary_path: PathBuf,
}

impl PrusaSlicerEngine {
    pub fn new(binary_path: impl Into<PathBuf>) -> Self {
        Self {
            binary_path: binary_path.into(),
        }
    }

    pub fn binary_path(&self) -> &Path {
        &self.binary_path
    }

    /// Runs PrusaSlicer headlessly in an isolated temporary directory.
    pub async fn run_slice<F>(
        &self,
        req: SliceEngineRequest,
        mut cancel_rx: watch::Receiver<bool>,
        mut on_progress: F,
    ) -> Result<SliceEngineResult>
    where
        F: FnMut(SlicerProgressEvent) + Send,
    {
        let model_size_bytes = u32::try_from(req.model_bytes.len()).map_err(|_| {
            FrError::InvalidInput("The combined model exceeds the 100 MiB slicing limit.".into())
        })?;
        validate_slice_request(&SliceValidationRequest {
            file_name: req.model_file_name.clone(),
            model_size_bytes,
            bounds: req.bounds.clone(),
            quality: req.quality,
            material: req.material.clone(),
        })?;

        if !self.binary_path.is_file() {
            return Err(FrError::NotFound(format!(
                "PrusaSlicer executable not found at '{}'. Install PrusaSlicer or select its path in the 3D Slicer setup panel.",
                self.binary_path.display()
            )));
        }

        let work_dir = TempDir::new()?;
        let ini_path = work_dir.path().join("mk3s-composed.ini");
        let ext = if req
            .model_file_name
            .trim()
            .to_ascii_lowercase()
            .ends_with(".3mf")
        {
            "3mf"
        } else {
            "stl"
        };
        let model_path = work_dir.path().join(format!("plate.{ext}"));
        let output_path = work_dir.path().join("output.gcode");

        let ini_text =
            compose_prusaslicer_ini(req.quality, req.rigidity, &req.material, &req.overrides);
        tokio::fs::write(&ini_path, ini_text.as_bytes()).await?;
        tokio::fs::write(&model_path, &req.model_bytes).await?;

        on_progress(SlicerProgressEvent {
            job_id: req.job_id.clone(),
            percent: 5,
            stage: "Starting PrusaSlicer...".into(),
        });

        let mut cmd = build_command(&self.binary_path);
        cmd.current_dir(work_dir.path())
            .arg("--export-gcode")
            .arg("--load")
            .arg(&ini_path)
            .arg("--output")
            .arg(&output_path)
            .arg(&model_path)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let mut child = cmd.spawn().map_err(|err| {
            FrError::Other(format!(
                "We couldn't start PrusaSlicer ({}): {err}",
                self.binary_path.display()
            ))
        })?;

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        let (line_tx, mut line_rx) = tokio::sync::mpsc::channel::<String>(128);
        let mut reader_handles = Vec::new();

        if let Some(out) = stdout {
            let tx = line_tx.clone();
            reader_handles.push(tokio::spawn(async move {
                let mut lines = BufReader::new(out).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if tx.send(line).await.is_err() {
                        break;
                    }
                }
            }));
        }
        if let Some(err_stream) = stderr {
            let tx = line_tx.clone();
            reader_handles.push(tokio::spawn(async move {
                let mut lines = BufReader::new(err_stream).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if tx.send(line).await.is_err() {
                        break;
                    }
                }
            }));
        }
        drop(line_tx);

        let mut log_lines: Vec<String> = Vec::new();
        let mut last_percent = 5u8;
        let deadline = tokio::time::sleep(req.timeout);
        tokio::pin!(deadline);

        let status = loop {
            tokio::select! {
                biased;
                changed = cancel_rx.changed() => {
                    if changed.is_ok() && *cancel_rx.borrow() {
                        let _ = child.kill().await;
                        let _ = child.wait().await;
                        for h in reader_handles {
                            h.abort();
                        }
                        return Err(FrError::Other("slicer_cancelled: Slicing was cancelled.".into()));
                    }
                }
                () = &mut deadline => {
                    let _ = child.kill().await;
                    let _ = child.wait().await;
                    for h in reader_handles {
                        h.abort();
                    }
                    return Err(FrError::Other(
                        "slicer_timeout: Slicing took too long and was stopped automatically.".into(),
                    ));
                }
                maybe_line = line_rx.recv() => {
                    match maybe_line {
                        Some(line) => {
                            if log_lines.len() < 400 {
                                log_lines.push(line.clone());
                            }
                            if let Some((pct, stage)) = parse_progress_line(&line, last_percent) {
                                last_percent = pct.max(last_percent);
                                on_progress(SlicerProgressEvent {
                                    job_id: req.job_id.clone(),
                                    percent: last_percent,
                                    stage,
                                });
                            }
                        }
                        None => {
                            // Both stdout and stderr closed; wait for process exit.
                            break child.wait().await.map_err(FrError::Io)?;
                        }
                    }
                }
            }
        };

        // Check if cancellation raced with completion.
        if *cancel_rx.borrow() {
            return Err(FrError::Other(
                "slicer_cancelled: Slicing was cancelled.".into(),
            ));
        }

        let engine_log = log_lines.join("\n");
        if !status.success() {
            let code = status
                .code()
                .map(|c| c.to_string())
                .unwrap_or_else(|| "signal".into());
            return Err(FrError::Other(format!(
                "slicer_failed: PrusaSlicer exited with status {code}.\n{engine_log}"
            )));
        }

        let gcode_raw = tokio::fs::read(&output_path).await.map_err(|err| {
            FrError::Other(format!(
                "slicer_failed: PrusaSlicer finished but did not produce a G-code file ({err}).\n{engine_log}"
            ))
        })?;
        if gcode_raw.is_empty() {
            return Err(FrError::Other(format!(
                "slicer_failed: Generated G-code file was empty.\n{engine_log}"
            )));
        }

        let (estimated_time, filament_grams, filament_mm) = parse_gcode_summary(&gcode_raw);
        on_progress(SlicerProgressEvent {
            job_id: req.job_id,
            percent: 100,
            stage: "G-code ready for Prusa MK3S".into(),
        });

        Ok(SliceEngineResult {
            gcode_bytes: Bytes::from(gcode_raw),
            estimated_time,
            filament_grams,
            filament_mm,
            engine_log,
        })
    }
}

fn build_command(binary_path: &Path) -> Command {
    #[cfg(windows)]
    {
        // Support `.cmd`/`.bat` scripts (used in unit tests) as well as `.exe` binaries.
        let is_batch = binary_path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"))
            .unwrap_or(false);
        let mut cmd = if is_batch {
            let mut c = Command::new("cmd");
            c.arg("/C").arg(binary_path);
            c
        } else {
            Command::new(binary_path)
        };
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd
    }
    #[cfg(not(windows))]
    {
        Command::new(binary_path)
    }
}

/// Parses PrusaSlicer CLI stdout stage lines and explicit percentage lines.
pub fn parse_progress_line(line: &str, current_percent: u8) -> Option<(u8, String)> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    let lower = trimmed.to_ascii_lowercase();

    // Explicit `PROGRESS: 42% Stage` or `42%` lines (supported by stubs and newer CLI output)
    if let Some(pct) = extract_percent(trimmed) {
        let stage = trimmed
            .trim_start_matches("=>")
            .trim_start_matches("PROGRESS:")
            .trim()
            .to_owned();
        return Some((pct.min(99), stage));
    }

    if lower.contains("processing triangulated mesh") || lower.contains("loading") {
        return Some((current_percent.max(15), "Reading 3D model...".into()));
    }
    if lower.contains("slicing") {
        return Some((current_percent.max(30), "Slicing layers...".into()));
    }
    if lower.contains("generating perimeters") {
        return Some((current_percent.max(45), "Building outer walls...".into()));
    }
    if lower.contains("preparing infill") || lower.contains("infill") {
        return Some((
            current_percent.max(60),
            "Generating internal infill...".into(),
        ));
    }
    if lower.contains("generating support") || lower.contains("support material") {
        return Some((current_percent.max(70), "Generating supports...".into()));
    }
    if lower.contains("generating g-code") || lower.contains("exporting g-code") {
        return Some((current_percent.max(85), "Writing MK3S G-code...".into()));
    }
    if lower.contains("slicing result exported") {
        return Some((98, "Finalizing G-code file...".into()));
    }
    None
}

fn extract_percent(text: &str) -> Option<u8> {
    let idx = text.find('%')?;
    let prefix = text[..idx].trim_end();
    let digits: String = prefix
        .chars()
        .rev()
        .take_while(|c| c.is_ascii_digit())
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    if digits.is_empty() {
        return None;
    }
    digits.parse::<u8>().ok().filter(|&v| v <= 100)
}

/// Extracts PrusaSlicer's summary metadata comments from the tail/head of the G-code file.
pub fn parse_gcode_summary(gcode: &[u8]) -> (Option<String>, Option<f64>, Option<f64>) {
    // PrusaSlicer writes summary comments near the end (and occasionally start) of the file.
    let tail_start = gcode.len().saturating_sub(64 * 1024);
    let tail = String::from_utf8_lossy(&gcode[tail_start..]);
    let mut est_time: Option<String> = None;
    let mut grams: Option<f64> = None;
    let mut mm: Option<f64> = None;

    for line in tail.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("; estimated printing time (normal mode) =") {
            let val = rest.trim();
            if !val.is_empty() {
                est_time = Some(val.to_owned());
            }
        } else if est_time.is_none()
            && let Some(rest) = trimmed.strip_prefix("; estimated printing time =")
        {
            let val = rest.trim();
            if !val.is_empty() {
                est_time = Some(val.to_owned());
            }
        } else if let Some(rest) = trimmed.strip_prefix("; total filament used [g] =") {
            if let Ok(v) = rest.trim().parse::<f64>() {
                grams = Some(v);
            }
        } else if grams.is_none()
            && let Some(rest) = trimmed.strip_prefix("; filament used [g] =")
        {
            if let Ok(v) = rest
                .trim()
                .split(',')
                .next()
                .unwrap_or("")
                .trim()
                .parse::<f64>()
            {
                grams = Some(v);
            }
        } else if let Some(rest) = trimmed.strip_prefix("; filament used [mm] =")
            && let Ok(v) = rest
                .trim()
                .split(',')
                .next()
                .unwrap_or("")
                .trim()
                .parse::<f64>()
        {
            mm = Some(v);
        }
    }

    (est_time, grams, mm)
}

/// Searches for a prebuilt PrusaSlicer executable (user path, PATH, standard Windows/macOS install dirs).
pub async fn detect_prusaslicer_binary(configured_path: Option<&str>) -> SlicerBinaryInfo {
    let mut candidates: Vec<(PathBuf, &'static str)> = Vec::new();

    if let Some(custom) = configured_path.map(str::trim).filter(|s| !s.is_empty()) {
        candidates.push((PathBuf::from(custom), "configured"));
    }

    // Check PATH entries
    if let Ok(path_var) = std::env::var("PATH") {
        let names: &[&str] = if cfg!(windows) {
            &["prusa-slicer-console.exe", "prusa-slicer.exe"]
        } else {
            &["prusa-slicer", "PrusaSlicer"]
        };
        for dir in std::env::split_paths(&path_var) {
            for name in names {
                candidates.push((dir.join(name), "PATH"));
            }
        }
    }

    // Standard platform install paths
    #[cfg(windows)]
    {
        if let Ok(pf) = std::env::var("ProgramFiles") {
            candidates.push((
                PathBuf::from(&pf).join("Prusa3D\\PrusaSlicer\\prusa-slicer-console.exe"),
                "Program Files",
            ));
            candidates.push((
                PathBuf::from(&pf).join("Prusa3D\\PrusaSlicer\\prusa-slicer.exe"),
                "Program Files",
            ));
        }
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            candidates.push((
                PathBuf::from(&local)
                    .join("Programs\\Prusa3D\\PrusaSlicer\\prusa-slicer-console.exe"),
                "LocalAppData",
            ));
        }
    }
    #[cfg(target_os = "macos")]
    {
        candidates.push((
            PathBuf::from(
                "/Applications/Original Prusa Drivers/PrusaSlicer.app/Contents/MacOS/PrusaSlicer",
            ),
            "Applications",
        ));
        candidates.push((
            PathBuf::from("/Applications/PrusaSlicer.app/Contents/MacOS/PrusaSlicer"),
            "Applications",
        ));
        candidates.push((PathBuf::from("/opt/homebrew/bin/prusa-slicer"), "Homebrew"));
        candidates.push((PathBuf::from("/usr/local/bin/prusa-slicer"), "Homebrew"));
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        candidates.push((PathBuf::from("/usr/bin/prusa-slicer"), "System"));
        candidates.push((PathBuf::from("/usr/local/bin/prusa-slicer"), "System"));
    }

    for (path, source) in candidates {
        if path.is_file() {
            let version = probe_version(&path).await;
            return SlicerBinaryInfo {
                available: true,
                path: Some(path.to_string_lossy().into_owned()),
                version,
                source: source.into(),
            };
        }
    }

    SlicerBinaryInfo {
        available: false,
        path: configured_path
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToOwned::to_owned),
        version: None,
        source: "not_found".into(),
    }
}

async fn probe_version(path: &Path) -> Option<String> {
    let mut cmd = build_command(path);
    cmd.arg("--help")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(5), cmd.output())
        .await
        .ok()?
        .ok()?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|s| s.chars().take(80).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profiles::builtin_materials;

    fn write_fake_slicer_script(dir: &Path, mode: &str) -> PathBuf {
        #[cfg(windows)]
        {
            let script_path = dir.join(format!("fake-slicer-{mode}.cmd"));
            let body = match mode {
                "ok" => {
                    "@echo off\r\n\
                     set OUT=\r\n\
                     :loop\r\n\
                     if \"%~1\"==\"\" goto run\r\n\
                     if \"%~1\"==\"--output\" (\r\n\
                       set OUT=%~2\r\n\
                       shift\r\n\
                       shift\r\n\
                       goto loop\r\n\
                     )\r\n\
                     shift\r\n\
                     goto loop\r\n\
                     :run\r\n\
                     echo =^> Processing triangulated mesh\r\n\
                     echo =^> Generating perimeters\r\n\
                     echo =^> Preparing infill\r\n\
                     echo =^> Exporting G-code\r\n\
                     (\r\n\
                       echo G28 W\r\n\
                       echo G1 X10 Y10 Z0.2\r\n\
                       echo ; estimated printing time ^(normal mode^) = 1h 24m\r\n\
                       echo ; filament used [g] = 18.42\r\n\
                       echo ; filament used [mm] = 6175.3\r\n\
                     ) > \"%OUT%\"\r\n\
                     echo Slicing result exported\r\n\
                     exit /b 0\r\n"
                }
                "fail" => {
                    "@echo off\r\n\
                     echo =^> Processing triangulated mesh\r\n\
                     echo Mesh is non-manifold and empty 1>&2\r\n\
                     exit /b 2\r\n"
                }
                "hang" => {
                    "@echo off\r\n\
                     echo =^> Processing triangulated mesh\r\n\
                     ping -n 6 127.0.0.1 >nul 2>&1\r\n\
                     exit /b 0\r\n"
                }
                _ => unreachable!(),
            };
            std::fs::write(&script_path, body).unwrap();
            script_path
        }
        #[cfg(not(windows))]
        {
            use std::os::unix::fs::PermissionsExt;
            let script_path = dir.join(format!("fake-slicer-{mode}.sh"));
            let body = match mode {
                "ok" => {
                    "#!/bin/sh\n\
                     OUT=\"\"\n\
                     while [ $# -gt 0 ]; do\n\
                       if [ \"$1\" = \"--output\" ]; then\n\
                         OUT=\"$2\"\n\
                         shift 2\n\
                       else\n\
                         shift\n\
                       fi\n\
                     done\n\
                     echo \"=> Processing triangulated mesh\"\n\
                     echo \"=> Generating perimeters\"\n\
                     echo \"=> Preparing infill\"\n\
                     echo \"=> Exporting G-code\"\n\
                     cat <<'EOF' > \"$OUT\"\n\
                     G28 W\n\
                     G1 X10 Y10 Z0.2\n\
                     ; estimated printing time (normal mode) = 1h 24m\n\
                     ; filament used [g] = 18.42\n\
                     ; filament used [mm] = 6175.3\n\
                     EOF\n\
                     echo \"Slicing result exported\"\n\
                     exit 0\n"
                }
                "fail" => {
                    "#!/bin/sh\n\
                     echo \"=> Processing triangulated mesh\"\n\
                     echo \"Mesh is non-manifold and empty\" >&2\n\
                     exit 2\n"
                }
                "hang" => {
                    "#!/bin/sh\n\
                     echo \"=> Processing triangulated mesh\"\n\
                     sleep 30\n\
                     exit 0\n"
                }
                _ => unreachable!(),
            };
            std::fs::write(&script_path, body).unwrap();
            let mut perms = std::fs::metadata(&script_path).unwrap().permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&script_path, perms).unwrap();
            script_path
        }
    }

    fn base_request() -> SliceEngineRequest {
        SliceEngineRequest {
            job_id: "job-test".into(),
            model_file_name: "bracket.stl".into(),
            model_bytes: Bytes::from_static(b"solid test\nendsolid test\n"),
            bounds: Some(PlateBoundsMm {
                min_x: 90.0,
                max_x: 160.0,
                min_y: 80.0,
                max_y: 130.0,
                min_z: 0.0,
                max_z: 25.0,
                object_count: 1,
            }),
            quality: QualityPreset::Standard,
            rigidity: RigidityPreset::Medium,
            material: builtin_materials()[0].clone(),
            overrides: SliceOverrides::default(),
            timeout: Duration::from_secs(30),
        }
    }

    #[tokio::test]
    async fn fake_engine_happy_path_emits_progress_and_parses_gcode_summary() {
        let dir = TempDir::new().unwrap();
        let bin = write_fake_slicer_script(dir.path(), "ok");
        let engine = PrusaSlicerEngine::new(&bin);
        let (_tx, rx) = watch::channel(false);
        let mut updates = Vec::new();

        let res = engine
            .run_slice(base_request(), rx, |ev| updates.push(ev))
            .await
            .unwrap();

        assert!(updates.len() >= 3);
        assert_eq!(updates.last().unwrap().percent, 100);
        assert_eq!(res.estimated_time.as_deref(), Some("1h 24m"));
        assert!((res.filament_grams.unwrap() - 18.42).abs() < 0.01);
        assert!((res.filament_mm.unwrap() - 6175.3).abs() < 0.1);
        assert!(String::from_utf8_lossy(&res.gcode_bytes).contains("G28 W"));
    }

    #[tokio::test]
    async fn fake_engine_failure_captures_stderr_and_returns_error() {
        let dir = TempDir::new().unwrap();
        let bin = write_fake_slicer_script(dir.path(), "fail");
        let engine = PrusaSlicerEngine::new(&bin);
        let (_tx, rx) = watch::channel(false);

        let err = engine
            .run_slice(base_request(), rx, |_| {})
            .await
            .unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("slicer_failed"), "unexpected error: {msg}");
        assert!(msg.contains("non-manifold"), "missing stderr log: {msg}");
    }

    #[tokio::test]
    async fn fake_engine_cancellation_kills_child_promptly() {
        let dir = TempDir::new().unwrap();
        let bin = write_fake_slicer_script(dir.path(), "hang");
        let engine = PrusaSlicerEngine::new(&bin);
        let (tx, rx) = watch::channel(false);

        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(250)).await;
            let _ = tx.send(true);
        });

        let started = std::time::Instant::now();
        let err = engine
            .run_slice(base_request(), rx, |_| {})
            .await
            .unwrap_err();
        assert!(
            err.to_string().contains("slicer_cancelled"),
            "unexpected error: {err}"
        );
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "cancellation took too long"
        );
    }
}
