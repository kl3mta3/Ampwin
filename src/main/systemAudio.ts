// Enables system-audio capture for the "System audio" visualizer mode. The
// renderer calls navigator.mediaDevices.getDisplayMedia({audio, video}); this
// handler answers it with a screen video source plus { audio: 'loopback' },
// which on Windows is WASAPI loopback of the whole system output. The renderer
// keeps only the audio track (see renderer/audio/systemAudio.ts).
//
// useSystemPicker:false + our own source means no picker dialog appears — the
// toggle is instant. We still require the renderer to have made the request
// from a user gesture (the toolbar button), so this can't be triggered silently.

import { desktopCapturer, session } from 'electron'

export function installSystemAudioHandler(): void {
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer
        .getSources({ types: ['screen'] })
        .then((sources) => {
          // Any screen works; we only want the accompanying loopback audio and
          // the renderer discards the video track immediately.
          callback({ video: sources[0], audio: 'loopback' })
        })
        .catch(() => {
          // Deny cleanly — the renderer's getDisplayMedia rejects and the UI
          // reports "loopback unavailable".
          callback({})
        })
    },
    // Our handler supplies the source, so skip the OS picker entirely.
    { useSystemPicker: false }
  )
}
