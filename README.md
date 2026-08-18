<p align="center">
  <img src="src-tauri/icons/128x128.png" width="96" alt="Winampfy icon">
</p>

<h1 align="center">Winampfy</h1>

<p align="center">
  A native, Winamp 2-style Spotify Premium player for macOS, Windows and Linux.
</p>

<p align="center">
  <a href="README.tr.md">Türkçe</a>
  ·
  <a href="https://github.com/KiPSOFT/winampfy/releases/latest">Downloads</a>
  ·
  <a href="https://github.com/KiPSOFT/winampfy/actions/workflows/release.yml">Builds</a>
</p>

<p align="center">
  <a href="https://github.com/KiPSOFT/winampfy/actions/workflows/release.yml"><img src="https://github.com/KiPSOFT/winampfy/actions/workflows/release.yml/badge.svg" alt="Release build"></a>
  <a href="https://github.com/KiPSOFT/winampfy/releases/latest"><img src="https://img.shields.io/github/v/release/KiPSOFT/winampfy?display_name=tag" alt="Latest release"></a>
</p>

![Winampfy running with the classic Winamp interface](docs/winampfy.png)

Winampfy combines Webamp's faithful Winamp 2.x interface with a native Tauri shell and direct Spotify playback through librespot. Spotify does not need to remain open after authentication.

> [!IMPORTANT]
> Winampfy is an unofficial, personal/experimental client. It is not affiliated with or endorsed by Spotify or Winamp. A Spotify Premium account is required. Use it at your own risk and review the applicable service terms.

## Features

- Authentic Winamp 2.x windows and `.wsz` skin support through Webamp
- Native, frameless and draggable macOS/Windows/Linux desktop window
- Direct Spotify audio playback powered by librespot
- Reliable background playback: a Rust watchdog keeps the queue going while the window is hidden, resumes stalled tracks in place and reconnects dropped sessions
- Spotify search inside a Winamp-styled dialog
- Multi-select search results and queue playback
- Spotify playlist browser with name/owner filtering and direct playlist URL support
- Built-in **Liked Songs** entry at the top of the playlist browser, loadable like any playlist
- First-run quick-start guide for adding songs and loading playlists, available again from About
- Full-screen modes for the Spotify playlist and Skin Museum browsers
- Infinite-scroll browser for 100,000+ classic skins from [Winamp Skin Museum](https://skins.webamp.org/)
- Downloaded skins are added to Webamp's native **Skins** menu and restored between launches
- Replace the current queue from **LIST OPTS → LOAD LIST**, optionally shuffled before loading
- Play, pause, previous, next, seek, volume, shuffle and repeat controls
- Playlist persistence between launches
- Minimize-to-tray, tray restore and quit actions
- Signed automatic updates from GitHub Releases, re-checked periodically while the app runs
- 320 kbps playback and a local audio cache

## Downloads

Installers are attached to [GitHub Releases](https://github.com/KiPSOFT/winampfy/releases):

- **macOS Apple Silicon:** download the `aarch64` DMG
- **macOS Intel:** download the `x86_64` DMG
- **Windows x64:** download the NSIS `.exe` or WiX `.msi` installer
- **Arch Linux x64:** download the `.AppImage`, make it executable and launch it

The public builds are currently not notarized or signed with a commercial certificate. On macOS, you may need to approve the application under **System Settings → Privacy & Security**. Windows SmartScreen may also display an unknown-publisher warning.

## Usage

Winampfy shows a three-step quick-start guide on first launch. You can open it again at any time by clicking the Winamp lightning-bolt logo and choosing **HOW TO USE**.

### Connect Spotify

1. Launch Winampfy and press **Play**, or press **ADD** in the Playlist Editor.
2. Complete Spotify OAuth in the system browser when prompted.
3. Return to Winampfy. Spotify does not need to remain open.

### Add songs

1. Press **ADD** at the bottom-left of the Playlist Editor.
2. Search by song, artist or album, or paste a Spotify track URL.
3. Select one or more search results and press **ADD SEL**.
4. Press **Play** to play the queue in order. The queue is preserved between launches.

### Load a playlist

1. Open **LIST OPTS → LOAD LIST** at the bottom-right of the Playlist Editor.
2. Search your Spotify playlists, or paste any accessible Spotify playlist URL—including a public playlist link. Your **Liked Songs** are listed first and load like any playlist.
3. Select one playlist, optionally enable **SHUFFLE BEFORE LOAD**, and press **LOAD**. Loading replaces the current queue.
4. Use the square button in the dialog title bar to enter or leave full-screen mode.

### Explore skins

1. Open Winamp's main menu and choose **Skins → Explore Skins...**.
2. Browse the infinite-scrolling Winamp Skin Museum list or search by name, select a skin, then press **DOWNLOAD + APPLY**. Double-clicking a skin does the same thing.
3. Downloaded skins appear in the native **Skins** menu and remain available after restarting Winampfy.
4. The Skin Museum dialog can also be switched to full-screen mode from its title bar.

Authentication is handled in the browser. Winampfy receives an access token through a localhost OAuth callback; it does not ask for or store your Spotify password.

## Development

### Prerequisites

- Node.js 20 or newer
- Rust stable (Rust 1.85 or newer)
- Platform prerequisites from the [Tauri documentation](https://v2.tauri.app/start/prerequisites/)
  - macOS: Xcode Command Line Tools
  - Windows: Microsoft C++ Build Tools and WebView2
  - Arch Linux: `webkit2gtk-4.1`, `libappindicator-gtk3`, `alsa-lib` and the other packages listed in the Tauri prerequisites

```sh
npm ci
npm run tauri dev
```

Run the checks and create a local bundle with:

```sh
npm run build
cd src-tauri && cargo test && cd ..
npm run tauri -- build
```

## Releases

The [release workflow](.github/workflows/release.yml) builds four targets in parallel:

- macOS Apple Silicon (`aarch64-apple-darwin`)
- macOS Intel (`x86_64-apple-darwin`)
- Windows x64 (`x86_64-pc-windows-msvc`)
- Linux x64 AppImage (`x86_64-unknown-linux-gnu`), compatible with Arch Linux

Push a version tag matching the versions in `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`:

```sh
git tag v0.1.0
git push origin v0.1.0
```

The workflow creates a public GitHub Release, attaches the generated installers and publishes the signed `latest.json` updater manifest. It can also be started manually from the Actions tab.

Automatic updates require a Tauri updater signing key. Keep the private key outside Git and add its complete contents as the `TAURI_SIGNING_PRIVATE_KEY` repository secret. The matching public key is embedded in `src-tauri/tauri.conf.json`. Losing the private key prevents future updates for existing installations.

## Architecture

| Layer | Technology | Responsibility |
| --- | --- | --- |
| Interface | TypeScript + Webamp | Winamp UI, playlist and controls |
| Desktop | Tauri 2 | Native window, tray and IPC |
| Playback | Rust + librespot | OAuth, search, Spotify Connect and audio |

## Third-party software and trademarks

- [Webamp](https://github.com/captbaritone/webamp) — MIT; Winamp 2 interface and `.wsz` skin support
- [librespot](https://github.com/librespot-org/librespot) — MIT; unofficial Spotify playback

The Winamp logo and names may be protected trademarks of their respective owners. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for attribution and additional notices.
