# 🎵 Spindle

<div align="center">
  <p><strong>A tactile, analog-inspired desktop vinyl player and offline music manager.</strong></p>
  <p>
    <a href="#features">Features</a> •
    <a href="#tech-stack">Tech Stack</a> •
    <a href="#getting-started">Getting Started</a> •
    <a href="#building--packaging">Packaging</a> •
    <a href="#license">License</a>
  </p>
</div>

---

## ✨ Features

- **Interactive 3D Turntable:** Real-time WebGL/Three.js turntable simulation with a spinning vinyl disc, moving tonearm mechanics, smooth playback needle drops, and realistic groove animations.
- **Local Music Management:** Drag and drop your audio files (`.mp3`, `.wav`, `.ogg`, `.flac`, `.m4a`) or import directly into playlists.
- **YouTube & YouTube Music Integration:**
  - Background track and album downloading via `yt-dlp` and `ffmpeg`.
  - Fast background metadata discovery with automatic naming and cover extraction.
  - Authentic high-resolution album artwork inheritance for YouTube Music releases.
- **Dynamic Procedural Vinyl Labels:** Procedurally styled records with customizable vinyl label palettes and custom uploaded artwork support.
- **Persistent Offline Library:** Zero-cloud dependency; audio tracks and playlists are stored directly in your local IndexedDB storage and music directory.
- **Refined Retro Aesthetic:** Warm editorial typography, vintage warm-paper and espresso color palettes, and tactile micro-interactions.

---

## 🛠 Tech Stack

- **Desktop Framework:** [Electron](https://www.electronjs.org/)
- **Frontend / Bundler:** Vanilla JavaScript (ES Modules), [Vite](https://vitejs.dev/)
- **3D Graphics:** [Three.js](https://threejs.org/) (Custom WebGL Turntable & Tonearm Rig)
- **Styling:** [Tailwind CSS](https://tailwindcss.com/)
- **Media Pipeline:** `yt-dlp` + `ffmpeg`

---

## 🚀 Getting Started

### Prerequisites

- **Node.js** (v18+ recommended)
- **npm**
- **yt-dlp** and **ffmpeg** (for YouTube audio downloads):
  - **Fedora / RHEL:** `sudo dnf install ffmpeg yt-dlp`
  - **Ubuntu / Debian:** `sudo apt install ffmpeg yt-dlp`
  - **macOS:** `brew install ffmpeg yt-dlp`
  - **Windows:** Install via `winget install yt-dlp ffmpeg` or place binaries in your system PATH.

### Installation

1. Clone your repository:
   ```bash
   git clone https://github.com/karumataken/spindle.git
   cd spindle
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

### Running the App

- **Run Desktop App (Electron):**
  ```bash
  npm run dev:desktop
  ```

- **Run Web Frontend (Browser preview without desktop IPC):**
  ```bash
  npm run dev
  ```

---

## 📦 Building & Packaging

Create standalone production packages with electron-builder:

- **Linux AppImage:**
  ```bash
  npm run dist:linux
  ```
- **Windows Installer / Portable (`.exe`):**
  ```bash
  npm run dist:win
  ```
- **Platform Default:**
  ```bash
  npm run dist
  ```

Outputs will be saved in the `release/` directory.

---

## 📄 License

This project is licensed under the [ISC License](LICENSE).
