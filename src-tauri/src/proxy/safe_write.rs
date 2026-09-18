//! Port of `vendor/cc-monitor/shared/safe-settings-writer.js`.
//!
//! Four enforced gates (CONTRACT §5.1):
//!   1. diff guard  — |len(new)-len(old)| / max(1,len(old)) > maxDeltaRatio → Err, zero bytes written
//!   2. pre-write backup — copy once to `<file>.bak`; NEVER overwrite an existing `.bak`
//!   3. atomic write — `<file>.tmp` + rename; `.tmp` cleaned up on failure
//!   4. post-write validation — JSON parse the result; on failure roll back from `.bak`;
//!      if rollback also fails, an aggregated error is returned
//!
//! Extra semantics from the reference:
//! - `transform` returning byte-identical text → return `Ok(())` with **no I/O at all**
//!   (no `.bak`, no `.tmp`).
//! - every failure propagates as `Err`; nothing is silently swallowed.
//! - rollback-success messages contain `restored from backup`; rollback-failure
//!   messages contain `rollback failed`.
//!
//! Length semantics: JS `String.length` counts UTF-16 code units, and the Node
//! guard compares `.length`. We mirror that exactly with `encode_utf16().count()`
//! instead of byte or scalar-value length, so the guard fires at identical ratios.

use std::fs;
use std::path::{Path, PathBuf};

pub const DEFAULT_MAX_DELTA_RATIO: f64 = 0.5;

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

fn backup_of(file_path: &Path) -> PathBuf {
    PathBuf::from(format!("{}.bak", file_path.display()))
}

fn tmp_of(file_path: &Path) -> PathBuf {
    PathBuf::from(format!("{}.tmp", file_path.display()))
}

/// Gate 2: create `<file>.bak` once; never overwrite.
fn ensure_backup(file_path: &Path, backup_path: &Path) -> Result<(), String> {
    if backup_path.exists() {
        return Ok(());
    }
    fs::copy(file_path, backup_path).map_err(|e| format!("backup failed: {e}"))?;
    Ok(())
}

/// Gate 3: write `.tmp` then rename onto the target; clean `.tmp` on any failure.
fn atomic_write(file_path: &Path, tmp_path: &Path, text: &str) -> Result<(), String> {
    if let Err(e) = fs::write(tmp_path, text) {
        let _ = fs::remove_file(tmp_path);
        return Err(format!("write failed: {e}"));
    }
    if let Err(e) = fs::rename(tmp_path, file_path) {
        let _ = fs::remove_file(tmp_path);
        return Err(format!("write failed: {e}"));
    }
    Ok(())
}

/// Rollback: restore the target from `.bak` using the same atomic tmp+rename dance.
fn restore_from_backup(file_path: &Path, backup_path: &Path, tmp_path: &Path) -> Result<(), String> {
    let backup = fs::read_to_string(backup_path).map_err(|e| e.to_string())?;
    fs::write(tmp_path, backup).map_err(|e| e.to_string())?;
    fs::rename(tmp_path, file_path).map_err(|e| e.to_string())?;
    Ok(())
}

/// Gate 4: parse the freshly written file; roll back on failure.
fn validate_or_rollback(file_path: &Path, backup_path: &Path, tmp_path: &Path) -> Result<(), String> {
    let parsed = fs::read_to_string(file_path)
        .map_err(|e| e.to_string())
        .and_then(|s| {
            serde_json::from_str::<serde_json::Value>(&s)
                .map(|_| ())
                .map_err(|e| e.to_string())
        });
    match parsed {
        Ok(()) => Ok(()),
        Err(e) => {
            eprintln!("[safe-settings-writer] post-write validation failed, rolling back: {e}");
            match restore_from_backup(file_path, backup_path, tmp_path) {
                Ok(()) => Err(format!(
                    "post-write validation failed, restored from backup: {e}"
                )),
                Err(re) => {
                    eprintln!("[safe-settings-writer] CRITICAL: rollback failed: {re}");
                    Err(format!("validation failed AND rollback failed: {e} / {re}"))
                }
            }
        }
    }
}

/// Read `file_path`, run `transform`, and persist the result through the four gates.
pub fn with_safe_settings_write<F>(
    file_path: &Path,
    transform: F,
    max_delta_ratio: Option<f64>,
) -> Result<(), String>
where
    F: FnOnce(&str) -> Result<String, String>,
{
    let max_delta_ratio = max_delta_ratio.unwrap_or(DEFAULT_MAX_DELTA_RATIO);
    let backup_path = backup_of(file_path);
    let tmp_path = tmp_of(file_path);

    let text = fs::read_to_string(file_path).map_err(|e| format!("read failed: {e}"))?;
    let new_text = transform(&text)?;
    if new_text == text {
        // No change: zero I/O, and crucially no `.bak` is created.
        return Ok(());
    }

    // Gate 1: diff guard.
    let old_len = utf16_len(&text);
    let new_len = utf16_len(&new_text);
    let delta = (new_len as f64 - old_len as f64).abs() / std::cmp::max(1, old_len) as f64;
    if delta > max_delta_ratio {
        return Err(format!(
            "aborted: size delta {:.1}% exceeds {}% threshold",
            delta * 100.0,
            max_delta_ratio * 100.0
        ));
    }

    ensure_backup(file_path, &backup_path)?; // gate 2
    atomic_write(file_path, &tmp_path, &new_text)?; // gate 3
    validate_or_rollback(file_path, &backup_path, &tmp_path) // gate 4
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn unique_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "spike-safe-write-{}-{}-{}",
            std::process::id(),
            tag,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn read(p: &Path) -> String {
        std::fs::read_to_string(p).unwrap()
    }

    /// Gate 1: an over-threshold length delta errors and changes zero bytes,
    /// creating neither `.bak` nor leaving `.tmp`.
    #[test]
    fn gate1_diff_guard_aborts_without_touching_file() {
        let d = unique_dir("gate1");
        let f = d.join("settings.json");
        let original = r#"{ "env": { "ANTHROPIC_BASE_URL": "http://a" } }"#;
        fs::write(&f, original).unwrap();

        let err = with_safe_settings_write(&f, |_| Ok("x".repeat(500)), None).unwrap_err();
        assert!(err.contains("aborted: size delta"), "got: {err}");
        assert!(err.contains("exceeds 50% threshold"), "got: {err}");
        assert_eq!(read(&f), original, "file must be byte-identical");
        assert!(!backup_of(&f).exists(), ".bak must not be created");
        assert!(!tmp_of(&f).exists(), ".tmp must not be left behind");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// Gate 1 boundary: exactly at the ratio is allowed (`>` not `>=`).
    #[test]
    fn gate1_boundary_is_strictly_greater_than() {
        // `{"a":"N b's"}` = 8 + N chars. 12 -> 18 is exactly 50%.
        assert_eq!(r#"{"a":"bbbb"}"#.len(), 12);
        assert_eq!(r#"{"a":"bbbbbbbbbb"}"#.len(), 18);

        let d = unique_dir("gate1b");
        let f = d.join("settings.json");
        fs::write(&f, r#"{"a":"bbbb"}"#).unwrap();
        let res = with_safe_settings_write(&f, |_| Ok(r#"{"a":"bbbbbbbbbb"}"#.to_string()), Some(0.5));
        assert!(res.is_ok(), "exactly 50% must pass: {res:?}");
        assert_eq!(read(&f), r#"{"a":"bbbbbbbbbb"}"#);

        // 12 -> 19 is 58.3% > 50% -> abort, file untouched.
        let g = d.join("settings2.json");
        fs::write(&g, r#"{"a":"bbbb"}"#).unwrap();
        let res = with_safe_settings_write(&g, |_| Ok(r#"{"a":"bbbbbbbbbbb"}"#.to_string()), Some(0.5));
        assert!(res.is_err(), "58.3% must abort");
        assert_eq!(read(&g), r#"{"a":"bbbb"}"#);
        let _ = std::fs::remove_dir_all(&d);
    }

    /// transform returning identical text → no I/O at all, and no `.bak`.
    #[test]
    fn unchanged_transform_does_no_io_and_creates_no_backup() {
        let d = unique_dir("nochange");
        let f = d.join("settings.json");
        let original = r#"{ "env": { "ANTHROPIC_BASE_URL": "http://a" } }"#;
        fs::write(&f, original).unwrap();

        with_safe_settings_write(&f, |t| Ok(t.to_string()), None).unwrap();
        assert_eq!(read(&f), original);
        assert!(!backup_of(&f).exists(), ".bak must NOT be created when unchanged");
        assert!(!tmp_of(&f).exists());

        // Even an explicit identity transform with a huge delta ratio does the same.
        with_safe_settings_write(&f, |t| Ok(t.to_string()), Some(100.0)).unwrap();
        assert!(!backup_of(&f).exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    /// Gate 2: `.bak` holds the pre-change bytes and is created exactly once.
    #[test]
    fn gate2_backup_created_once_and_never_overwritten() {
        let d = unique_dir("gate2");
        let f = d.join("settings.json");
        fs::write(&f, r#"{"v":"one"}"#).unwrap();

        with_safe_settings_write(&f, |_| Ok(r#"{"v":"two"}"#.to_string()), None).unwrap();
        assert_eq!(read(&backup_of(&f)), r#"{"v":"one"}"#);

        // Second write: .bak must still be the ORIGINAL pre-first-write text.
        with_safe_settings_write(&f, |_| Ok(r#"{"v":"tre"}"#.to_string()), None).unwrap();
        assert_eq!(read(&backup_of(&f)), r#"{"v":"one"}"#);
        assert_eq!(read(&f), r#"{"v":"tre"}"#);
        assert!(!tmp_of(&f).exists(), "no .tmp residue");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// Gate 4: invalid post-write JSON is rolled back from `.bak`, error mentions it.
    #[test]
    fn gate4_rollback_restores_original_on_invalid_json() {
        let d = unique_dir("gate4");
        let f = d.join("settings.json");
        let original = r#"{"a":"b"}"#;
        fs::write(&f, original).unwrap();

        // Drop the closing brace: shorter, well inside the diff guard, invalid JSON.
        let err = with_safe_settings_write(&f, |t| Ok(t.trim_end_matches('}').to_string()), None)
            .unwrap_err();
        assert!(err.contains("restored from backup"), "got: {err}");
        assert_eq!(read(&f), original, "rollback must restore original bytes");
        assert_eq!(read(&backup_of(&f)), original, ".bak holds the original");
        assert!(!tmp_of(&f).exists(), "no .tmp residue after rollback");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// Gate 4 failure path: if the rollback itself fails we must aggregate the error.
    /// We force this by pre-creating `.bak` as a *directory*: `exists()` is true so
    /// gate 2 skips, but reading it as text fails during rollback.
    #[test]
    fn gate4_rollback_failure_is_reported_as_aggregate_error() {
        let d = unique_dir("gate4fail");
        let f = d.join("settings.json");
        fs::write(&f, r#"{"a":"b"}"#).unwrap();
        fs::create_dir(backup_of(&f)).unwrap(); // .bak is a directory

        let err = with_safe_settings_write(&f, |t| Ok(t.trim_end_matches('}').to_string()), None)
            .unwrap_err();
        assert!(err.contains("validation failed AND rollback failed"), "got: {err}");
        assert!(err.contains("rollback failed"), "got: {err}");
        // The invalid text is what remains on disk (rollback was impossible).
        assert_eq!(read(&f), r#"{"a":"b""#);
        let _ = std::fs::remove_dir_all(&d);
    }

    /// transform errors propagate untouched; no backup is made.
    #[test]
    fn transform_error_propagates() {
        let d = unique_dir("transformerr");
        let f = d.join("settings.json");
        fs::write(&f, r#"{"a":"b"}"#).unwrap();

        let err = with_safe_settings_write(
            &f,
            |_| Err("ANTHROPIC_BASE_URL key not found in settings.json".to_string()),
            None,
        )
        .unwrap_err();
        assert!(err.contains("ANTHROPIC_BASE_URL key not found"));
        assert_eq!(read(&f), r#"{"a":"b"}"#);
        assert!(!backup_of(&f).exists(), "no .bak when transform rejects");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// Reading a missing file fails loudly.
    #[test]
    fn missing_target_file_errors() {
        let d = unique_dir("missing");
        let f = d.join("nope.json");
        let err = with_safe_settings_write(&f, |t| Ok(t.to_string()), None).unwrap_err();
        assert!(err.contains("read failed"), "got: {err}");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// The guard uses JS-style UTF-16 code-unit lengths, so astral characters
    /// count as 2 — matching Node exactly.
    #[test]
    fn length_metric_matches_js_utf16_code_units() {
        assert_eq!(utf16_len("🌏"), 2);
        assert_eq!(utf16_len("你好，世界"), 5);
        assert_eq!(utf16_len("abc"), 3);
    }

    /// Realistic settings.json: only the value bytes change, everything else is
    /// preserved byte-for-byte (indentation, key order, other keys).
    #[test]
    fn only_the_targeted_value_span_changes() {
        let d = unique_dir("span");
        let f = d.join("settings.json");
        let original = "{\n  \"env\": {\n    \"ANTHROPIC_BASE_URL\": \"https://relay.example.com/api\",\n    \"ANTHROPIC_AUTH_TOKEN\": \"sk-keep-me\"\n  },\n  \"permissions\": { \"allow\": [\"Bash\"] }\n}\n";
        fs::write(&f, original).unwrap();

        with_safe_settings_write(
            &f,
            |t| Ok(t.replace("https://relay.example.com/api", "http://localhost:1234")),
            None,
        )
        .unwrap();

        let after = read(&f);
        assert_eq!(
            after,
            "{\n  \"env\": {\n    \"ANTHROPIC_BASE_URL\": \"http://localhost:1234\",\n    \"ANTHROPIC_AUTH_TOKEN\": \"sk-keep-me\"\n  },\n  \"permissions\": { \"allow\": [\"Bash\"] }\n}\n"
        );
        assert_eq!(read(&backup_of(&f)), original);
        let _ = std::fs::remove_dir_all(&d);
    }
}
