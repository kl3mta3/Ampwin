# Ampwin Backlog

Requested features not yet implemented. Captured verbatim-in-intent from user
requests so we can pick them up later. Nothing here is built yet.

## Bugs / regressions

- [x] **Video doesn't play.** ~~Videos are not opening/playing.~~ Fixed by the video-on-surface refactor: video now plays on the host's VizSurface `<video>` element.
- [x] **Video should replace the visualizer surface.** Done — video plays on the visualizer surface in the mini view, pop-out, and fullscreen (host `VizSurface`); the separate video window was retired.
- [x] **Single click in fullscreen should change the preset.** Fixed — the fullscreen surface now wires click→random preset (video mode: click = play/pause).
- [x] **Spectrum bars visualizer ('bars') does not work at all.** Fixed — the host now gives each visualizer a fresh canvas, so bars gets a real 2D context (Butterchurn's WebGL context was poisoning the shared canvas).
- [x] **Real-world video files (MKV, AC3/DTS audio, mpeg4/etc.) don't play.** Fixed — ffprobe codec probing routes each file: direct play / instant MKV→MP4 remux / audio-only re-encode (AC3→AAC, fast) / full re-encode (slow, cached, with % progress in the title bar). Video errors now show in the title marquee instead of silently stopping. +files dialog now defaults to "All media" so videos are selectable.
- [x] **Progressive playback (play while converting).** Done — non-direct video streams through ffmpeg → fragmented MP4 → MSE with a rolling buffer (~60s ahead via pipe backpressure, 30s back-buffer for rewinds). Any video starts in under a second, including full re-encodes; seeks outside the buffer restart the stream at the exact target (-copyts). No cache files needed for video.
  - Note: if a full re-encode can't keep up with realtime on a weak CPU (e.g. 4K HEVC), playback can catch up to the conversion and stall momentarily — a "buffering" indicator would be a nice polish item.

## Sources: links & YouTube — DONE

- [x] **"Add link"** control (+ link) next to +files/+folder. Modal: paste URL, audio-only checkbox, search + sign-in buttons.
- [x] **YouTube search** window (via yt-dlp) with thumbnails; click a result to add.
- [x] **"Sign in to YouTube"** — opens a real YouTube login window in an isolated session; exports cookies to yt-dlp for age/region-locked videos.
- [x] Links add to the playlist like files; audio-only → audio, else video in mini/pop-out/fullscreen. Remote tracks re-resolve on each play (URLs expire). Direct media URLs bypass yt-dlp. yt-dlp downloads on first use and self-updates.
  - Notes: YouTube video caps ~720p (single progressive stream; 1080p+ is DASH and needs audio/video muxing — a later upgrade). Downloading/streaming YouTube violates YouTube ToS and can break when they change their site (yt-dlp -U mitigates).

## Downloads — DONE

- [x] **Right-click ▸ Download** on remote/link tracks → submenu: **Audio (.m4a)**, **Video (no audio)**, **Audio + Video (.mp4)**. Saves to `%APPDATA%\Ampwin\downloads`, shows progress in the title marquee, and adds the finished local file to the playlist (so it plays offline afterward). Works on multi-selection (sequential). Audio+Video merges best streams via ffmpeg → full quality (beyond the ~720p live-stream cap). `ampwin.links.download()` / `openDownloadsFolder()`.

## UX fixes

- [x] **Distinguish "unreadable" from "missing"** in the playlist. A corrupt/incomplete file that exists (e.g. MP4 with no moov atom) now shows "— unreadable" in reddish text instead of the same strikethrough as a truly missing file.

## Playlist

- [ ] **Pop-out playlist** button next to the fullscreen-visualizer button. In the lite skin, a button that opens a popped-out playlist window.
- [ ] **Playlists persist across app close.** (Note: session playlist + position already persists to `session.json`; confirm whether this means named/saved playlists auto-restoring, or a bug in current restore.)

## Right-click "File" submenu (playlist context menu)

- [ ] **File ▸ Convert ▸ <format>** — submenu listing every format FFmpeg can output (no extra options/knobs). On completion, pop a **save dialog**.
- [ ] **File ▸ Get stems** — separate audio into stems.
  - Use a JS-friendly model (UVR ONNX / Spleeter) via **onnxruntime-node**.
  - Wire the flow first; on **first use**, tell the user a model bundle is needed, **download the ONNX model**, then run it.
  - Stems open in a **separate window** with all stems for preview.
  - Per-stem download buttons: **WAV / FLAC / MP3**.
  - Bottom bar: **Restem**, **Download all (MP3)**, **Download all (WAV)**, **Download all (FLAC)**.

## Devices

- [ ] **Output/input device chooser** button next to the mute button (Web Audio `setSinkId` for output; `getUserMedia`/`enumerateDevices` for input).

## Extensions / add-ons (research + design)

- [ ] Investigate a **extension/add-on system** so third parties can add integrations:
  - Spotify / Apple Music playback from a signed-in account.
  - Stems could ship as an add-on rather than core.
  - See design notes discussed with the user (sandboxing, capability grants, packaging).
