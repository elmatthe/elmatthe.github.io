---
layout: page
title: Audiobook Creation Tool
permalink: /software/audiobook-creation-tool/
summary: Cross-platform desktop app that turns ebooks, PDFs, and text into tagged audiobooks using cloud-based or local AI voices.
last_updated: 2026-06-06
---

<section class="hero-panel">
  <div class="eyebrow">Desktop Application</div>
  <h1>Audiobook Creation Tool</h1>
  <p class="lede">Turn ebooks, PDFs, text, and audio into finished, professionally-tagged audiobooks — no terminal required.</p>
  <div class="btn-row" style="margin-top: 12px;">
    <span class="action-pill" style="background:#1c7550; color:#fff; padding:4px 12px; border-radius:8px; font-size:0.9em;">v0.4.0</span>
    <span class="action-pill" style="background:#8f5f12; color:#fff; padding:4px 12px; border-radius:8px; font-size:0.9em;">Windows &amp; macOS</span>
  </div>
</section>

## Overview

The Audiobook Creation Tool is a cross-platform desktop application that transforms EPUB, PDF, TXT, and existing audio into finished, chaptered audiobooks. It runs as a single-window GUI built for non-technical users — there is no command line to learn and no console windows to manage. All transformations are non-destructive: the tool works on copies, so your originals are never touched.

## AI Voice Engines — Cloud-Based & Local

Text-to-speech narration runs on one of two interchangeable AI engines, so you can choose between zero-setup cloud voices or fully offline local synthesis.

<div class="card-grid">
  <article class="card">
    <h3>☁️ Microsoft Edge TTS — Cloud-Based</h3>
    <p>Online neural voices streamed from Microsoft's service. No local model download and no GPU required — just an internet connection. Offers a wide catalog of natural-sounding voices across many languages.</p>
    <p class="muted">Best for: fast setup, lowest disk footprint, the widest voice selection.</p>
  </article>
  <article class="card">
    <h3>💻 Kokoro-82M — Local AI Model</h3>
    <p>An on-device neural voice model (~300&nbsp;MB) that synthesizes speech entirely offline — nothing leaves your machine. The app self-heals a missing or broken Kokoro install on every launch and caches the model weights inside the project tree.</p>
    <p class="muted">Best for: offline/private narration with no network dependency. Requires Python &lt; 3.13.</p>
  </article>
</div>

## What It Does

Six integrated tools in a single window:

- **TTS Audiobook** — Convert EPUB / PDF / TXT to MP3 using Edge TTS (cloud) or Kokoro-82M (local). Single-file or batch, with live logs and cancellation.
- **M4B Converter** — Batch-convert M4B audiobooks to clean MP3s with optional metadata and auto-track numbering.
- **MP3 Tool** — Combine multiple MP3s into one file, edit timing, and bulk-write ID3 tags including chapter titles.
- **M4B Maker** — Build chaptered M4B files from MP3s with embedded cover art, full metadata, and Audiobookshelf-compatible series tags.
- **Cover Image Converter** — Pad or center-crop images to square format (JPG / PNG / HEIC).
- **M4B Metadata Editor** — Edit existing M4B tags non-destructively, with per-file chapter-title importing.

## Tech Stack

| Layer | Technology |
|-------|------------|
| Language | Python (3.11 / 3.12 target) |
| Interface | Tkinter single-window GUI (no console windows via `pythonw`) |
| AI Voices | Microsoft Edge TTS (cloud), Kokoro-82M (local) |
| Audio | ffmpeg / ffprobe, pydub, mutagen |
| Documents | PyMuPDF (PDF), ebooklib (EPUB), NLTK (tokenization) |
| Imaging | Pillow (JPG / PNG / HEIC) |
| Reliability | Worker threads + queue-based communication; install-on-first-run private `.venv` |

## Download & Install

<div class="btn-row">
  <a class="btn" href="https://github.com/elmatthe/audiobook-creation-tool/releases/download/v0.4.0/AudiobookTool-Windows-v0.4.0.zip">Download for Windows (.zip, v0.4.0)</a>
  <a class="btn" href="https://github.com/elmatthe/audiobook-creation-tool/releases/download/v0.4.0/AudiobookTool-MacOS-v0.4.0.zip">Download for macOS (.zip, v0.4.0)</a>
</div>

<div class="btn-row">
  <a class="btn btn-secondary" href="https://github.com/elmatthe/audiobook-creation-tool/releases/tag/v0.4.0">View Latest Release (v0.4.0)</a>
  <a class="btn btn-secondary" href="https://github.com/elmatthe/audiobook-creation-tool#readme">README &amp; Full Documentation</a>
  <a class="btn btn-secondary" href="https://github.com/elmatthe/audiobook-creation-tool">GitHub Repository</a>
</div>

**Windows:** extract `AudiobookTool-Windows-v0.4.0.zip`, then double-click `setup_and_run.bat`. The first run installs Python 3.12, the audio libraries, and ffmpeg automatically (via winget); later runs launch instantly.

**macOS:** extract `AudiobookTool-MacOS-v0.4.0.zip`, move the folder out of Downloads (required for proper file access), then double-click `setup_and_run.command` (you may need to right-click → Open on first launch). Dependencies resolve automatically via Homebrew.

<section class="callout">
  <p><strong>First-run setup:</strong> dependencies install into a private <code>.venv</code> inside the project folder on first launch, so the download stays small instead of bundling multi-gigabyte libraries. Choose <strong>Kokoro-82M</strong> for fully offline narration or <strong>Edge TTS</strong> for cloud voices with no local model.</p>
</section>

## License

Released under the **GNU General Public License v3.0 (GPL-3.0)**, inherited from the upstream epub2tts-edge project.
