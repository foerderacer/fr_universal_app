# FR Universal App

Cross-platform desktop workspace (**Windows** & **macOS**) built with **Rust** and **Tauri v2**, designed to connect seamlessly to **Nextcloud** with a modular, upgradable architecture and dual **MCP (Model Context Protocol)** support.

## Highlights

- **Zero-Setup Nextcloud Integration:** One-click Login Flow v2, OS keychain credential storage, WebDAV/OCS sync, and local caching.
- **File Workspace:** Browse, pin folders, edit Markdown (`.md`), and preview videos, images, vector files, PDFs, and SolidWorks files.
- **Native Nextcloud Talk:** Team group chat with zero-copy cloud file references and offline SQLite caching.
- **3D Printing Slicer (Prusa MK3S):** Arrange multiple STL/3MF parts on a 250×210×210 mm build plate, choose Material + Rigidity + Quality, and export `.gcode` via headless PrusaSlicer CLI.
- **Modular Architecture:** Extensible workspace shell hosting Files, Talk, 3D Slicer, Finance, Automation Workflows, and MCP / AI.
- **Dual MCP Support:** Built-in local MCP Server (`127.0.0.1`, off by default) and MCP Client capabilities.

## Workspace Layout

```text
├── Cargo.toml                   # Rust workspace root
├── LICENSE                      # GNU AGPL-3.0
├── crates/
│   ├── fr-core/                 # Domain types, config, errors, EventBus, FrModule trait
│   ├── fr-storage/              # StorageBackend trait, CloudPath, LocalFsBackend
│   ├── fr-nextcloud/            # Nextcloud URL validation, Login Flow v2 & WebDAV client
│   ├── fr-preview/              # Client-side preview classification & extractors
│   ├── fr-mcp/                  # Dual MCP Server + MCP Client
│   ├── fr-workflows/            # Declarative automation workflow engine
│   ├── fr-talk/                 # Nextcloud Talk OCS chat client & SQLite cache
│   ├── fr-slicer/               # Headless PrusaSlicer CLI runner, MK3S presets & validation
│   └── modules/
│       ├── fr-mod-files/        # Files domain module
│       ├── fr-mod-talk/         # Nextcloud Talk domain module
│       ├── fr-mod-slicer/       # 3D Printing Slicer domain module
│       ├── fr-mod-finance/      # Finance ledger domain module
│       └── fr-mod-automation/   # Automation workflows domain module
└── apps/
    └── desktop/
        ├── src-tauri/           # Thin Tauri v2 shell + tauri-specta IPC bindings
        └── ui/                  # React + TypeScript + Vite + Tailwind CSS workspace shell
```

## Development

### Prerequisites
- Rust (stable) with `rustfmt` and `clippy`
- Node.js 22+ & npm
- Tauri v2 platform prerequisites (WebView2 on Windows, Xcode Command Line Tools on macOS)

### Run Desktop App in Dev Mode
```bash
cd apps/desktop/ui
npm install
npm run tauri -- dev
```

Optionally configure a build-time default Nextcloud server URL (see [.env.example](.env.example)):
```bash
FR_DEFAULT_NEXTCLOUD_URL=https://cloud.example.com npm run tauri -- build
```

### Verification Commands
```bash
# Rust workspace
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace

# Frontend UI
cd apps/desktop/ui
npm run typecheck
npm run lint
npm run build
```

## License

Licensed under the [GNU Affero General Public License v3.0 (AGPL-3.0)](LICENSE).
The 3D Slicer module invokes external, unmodified prebuilt [PrusaSlicer](https://github.com/prusa3d/PrusaSlicer) binaries as a separate child process (also AGPL-3.0).
