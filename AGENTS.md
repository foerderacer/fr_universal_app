# AGENTS.md — Engineering & Workflow Guide

This file defines the architecture rules, development workflow, and quality standards for **FR Universal App** (`foerderacer/fr_universal_app`). Every contributor and AI coding agent working in this repository must follow these conventions.

---

## 1. Product Context & Design Principles

- **What this app is:** A cross-platform desktop workspace (**Windows** & **macOS**) built with **Rust + Tauri v2 + React/TypeScript/Tailwind CSS**.
  - Connects directly to **Nextcloud** (WebDAV + OCS API + Login Flow v2) with local SQLite metadata & file caching.
  - Designed as a **modular, upgradable shell** (`Files` first, followed by internal modules such as `Finance` and `Automation Workflows`).
  - Supports **dual MCP (Model Context Protocol)** — acting as both an **MCP Server** (exposing app modules to external AI tools) and an **MCP Client** (allowing workflows/modules to call external MCP servers).
- **Target audience:** **Non-technical team members.**
  - Prioritize zero-setup onboarding (1-click browser login, editable default server URL, zero external sync clients).
  - Never expose raw stack traces, HTTP error codes, or technical jargon in primary UI error states. Show clear, friendly explanations and recovery actions (tuck technical details behind an optional expandable details view or log).
  - Never silently lose user edits (maintain local drafts and handle Nextcloud `412 Precondition Failed` ETag conflicts explicitly).

---

## 2. Repository & Architecture Rules

### Planned Workspace Layout
```text
├── .plan/                       # Local-only planning docs (gitignored — NEVER commit)
├── Cargo.toml                   # Rust workspace root
├── crates/
│   ├── fr-core/                 # Shared domain types, config, errors, EventBus, FrModule trait
│   ├── fr-storage/              # StorageBackend trait, LocalFsBackend, SQLite cache layer
│   ├── fr-nextcloud/            # Nextcloud Login Flow v2, WebDAV/OCS client, Range streaming
│   ├── fr-preview/              # Client-side preview extractors (SolidWorks CFBF, vector/media helpers, loopback Range media proxy)
│   ├── fr-mcp/                  # Dual MCP Server + MCP Client (rmcp)
│   ├── fr-talk/                 # Nextcloud Talk OCS chat client, pure file-ID references & SQLite cache
│   ├── fr-workflows/            # Automation engine (triggers, steps, MCP tool invocations)
│   └── modules/                 # Pluggable domain modules (fr-mod-files, fr-mod-talk, fr-mod-finance, fr-mod-automation)
└── apps/
    └── desktop/                 # Tauri v2 desktop app (Windows & macOS)
        ├── src-tauri/           # Thin Tauri bridge (commands, media protocol, updater, tray/window)
        └── ui/                  # React + TypeScript + Vite + Tailwind CSS workspace shell
```

### Hard Architectural Guardrails
1. **Pure Rust Core:** `crates/*` must remain 100% UI-agnostic and free of Tauri dependencies so every crate compiles and tests cleanly with plain `cargo test`.
2. **Storage Abstraction:** All modules and MCP tools access files exclusively through `StorageBackend` (`fr-storage`), never raw `reqwest` or ad-hoc filesystem paths. Use `LocalFsBackend` for fast unit/integration tests.
3. **Typed IPC Boundary:** All Rust ↔ TypeScript Tauri commands must use strongly typed `serde` structs, exporting TypeScript bindings via `tauri-specta` so backend and frontend contracts never drift.
4. **Thin Presentation Layer:** Keep business logic, Nextcloud networking, conflict detection, caching, and workflow execution in Rust—not in React components.
5. **Cross-Platform Parity:** Never assume Windows-only or macOS-only paths, line endings, or OS APIs without proper cross-platform handling (`std::path::PathBuf`, `directories`, `keyring`, `open`).

---

## 3. Security & Public Repository Hygiene

This repository may be **public**. Strictly enforce:
- **Never commit `.plan/`** (must stay in `.gitignore`).
- **Never commit secrets, credentials, tokens, signing keys, or private company endpoints.**
  - Inject any organization-specific default Nextcloud URL via build-time environment variable (`FR_DEFAULT_NEXTCLOUD_URL`) / CI repository variable, while always allowing users to configure/change the server URL in the app UI.
- **Credential Storage:** Persist Nextcloud app passwords and external MCP tokens exclusively in the OS credential store via `keyring` (Windows Credential Manager / macOS Keychain)—never plaintext files.
- **MCP Server Safety:**
  - Bind strictly to `127.0.0.1` (never `0.0.0.0`).
  - Require an auto-generated Bearer token.
  - Default to disabled or read-only until explicitly enabled by the user, with UI confirmation/audit logging for destructive or write operations.
- **SVG & Preview Safety:** Sanitize untrusted `.svg` files before rendering in WebView to prevent embedded script execution.

---

## 4. Git Workflow & Conventions

- **Default branch:** `main` — always kept green and buildable on both **Windows** and **macOS**.
- **Branching:**
  - Use short-lived branches for features, fixes, and chores:
    - `feat/<short-name>`
    - `fix/<short-name>`
    - `chore/<short-name>`
  - Open Pull Requests into `main` so GitHub Actions verifies both Windows and macOS before merge. *(Small repo-setup/doc chores during Phase 0 may go directly to `main` when explicitly requested.)*
- **Commit Messages:** Follow **Conventional Commits**:
  - `feat(nextcloud): implement Login Flow v2 authentication`
  - `feat(preview): extract SolidWorks CFBF embedded thumbnail`
  - `fix(editor): show ETag conflict dialog on HTTP 412`
  - `chore(ci): add Windows and macOS build matrix`
- **Small Vertical Slices:** Prefer small, focused, verifiable changes that compile, pass tests, and deliver one clear capability at a time.

---

## 5. Verification & Quality Gates

Before opening a PR or marking any implementation task complete, run the applicable checks for the touched areas:

### Rust (Workspace)
```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

### Frontend (`apps/desktop/ui`)
```bash
npm run typecheck   # tsc --noEmit
npm run lint
npm run build
```

### CI / Releases
- GitHub Actions runs Rust checks, Frontend checks, and Tauri build verification on both `windows-latest` and `macos-latest`.
- Tagged releases (`vX.Y.Z`) build Windows (`.msi` / `.exe`) and macOS (`.dmg`) artifacts plus signed `tauri-plugin-updater` manifests on GitHub Releases.

---

## 6. Planning & Collaboration Cadence

1. **Plan First:** Document goals, edge cases, and acceptance criteria in local `.plan/` before building a new phase or module.
2. **Build in Vertical Slices:** Implement backend crate + unit tests → Tauri command + typed bindings → UI integration.
3. **Verify Automatically & Live:** Pass all local tests/linters first, then validate desktop UX live against Nextcloud on Windows/macOS.
4. **Keep This File Current:** Whenever an architecture rule, command, or module convention changes, update `AGENTS.md` in the same PR.
