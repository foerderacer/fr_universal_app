# Release & Signed Auto-Updates Runbook

This guide covers how **FR Universal App** builds cross-platform releases and delivers cryptographically verified updates via GitHub Releases.

## 1. Installer Format & Platform Support

- **Windows (primary verified target):** NSIS per-user installer (`-setup.exe`, `installMode: "currentUser"`), installed under `%LOCALAPPDATA%\Programs\`. Updates install in passive mode (compact progress dialog, no UAC elevation) and work for non-admin accounts.
- **macOS (best-effort unsigned unless `APPLE_*` secrets are configured):** Universal `.dmg` + `.app.tar.gz`. Without Apple Developer ID notarization, first launch requires right-click → **Open** (or **System Settings → Privacy & Security → Open Anyway**).

## 2. One-Time Signing Key Setup

Generate a Tauri updater signing keypair on a secure machine:

```bash
cargo tauri signer generate -w ~/.tauri/fr_universal_app.key
```

Configure the GitHub repository settings:

| Setting | Kind | Value |
|---|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | Repository **Secret** | Full contents of `~/.tauri/fr_universal_app.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Repository **Secret** | Password chosen during generation |
| `FR_UPDATER_PUBKEY` | Repository **Variable** | Contents of `~/.tauri/fr_universal_app.key.pub` |
| `FR_DEFAULT_NEXTCLOUD_URL` | Repository **Variable** | Optional organization default Nextcloud URL |

> **Important:** Back up the private key offline (e.g. password manager). The public key is compiled into installed apps; losing the private key prevents existing installations from verifying future updates.

## 3. Cutting a Release

1. Bump `version` in root `Cargo.toml` and `apps/desktop/ui/package.json` (Tauri inherits the Cargo workspace version automatically — `tauri.conf.json` intentionally omits `"version"`).
2. Run `node scripts/release-prep.mjs` on clean `main` (verifies clean working tree and Cargo ↔ `package.json` version parity).
3. Tag and push `vX.Y.Z`:
   ```bash
   git tag -a v0.2.0 -m "Release v0.2.0"
   git push origin v0.2.0
   ```
4. Wait for `.github/workflows/release.yml` (`Build & Publish` + `Verify & Merge Updater Manifest`) to turn green.
5. Open the Draft GitHub Release, write clear non-technical release notes, and click **Publish release**. Publishing automatically re-runs `Verify & Merge Updater Manifest` (~10 s) to refresh `latest.json` with your published release notes so the in-app update dialog displays them directly.

## 4. Key-Rotation ("Bridge Release") Procedure

If you ever need to rotate the updater signing key without breaking existing installations:

1. Generate the new keypair (`new.key` / `new.key.pub`).
2. Keep `TAURI_SIGNING_PRIVATE_KEY` set to the **old** private key, and update `FR_UPDATER_PUBKEY` to the **new** public key.
3. Cut and publish a **bridge release** (e.g. `v0.5.0`): existing apps verify it with the old pubkey and upgrade to a binary embedding the new pubkey.
4. Once teammates have upgraded past the bridge release, switch `TAURI_SIGNING_PRIVATE_KEY` to the **new** private key for `v0.5.1+`.
