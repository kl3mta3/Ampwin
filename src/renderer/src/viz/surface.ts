// A host-owned rendering surface: a fresh <canvas> (for the active visualizer)
// and a <video> (for video playback), created together and mounted at a target
// location. Two reasons this exists:
//   1. The canvas is created fresh every time, so it never carries a stale
//      WebGL/2D context — that's the spectrum-bars bug (a canvas that already
//      held Butterchurn's WebGL context can't hand out a 2D context).
//   2. Video shares the surface with the visualizer, so a video plays exactly
//      where the visualizer would (mini view, pop-out, fullscreen).
//
// Mount modes:
//   'own'     — the host owns the container (pop-out window, fullscreen box):
//               fill it, and the surface handles its own clicks.
//   'overlay' — the anchor is the skin's canvas (in the skin iframe): float an
//               overlay over it with pointer-events:none so the skin's own
//               canvas keeps receiving clicks. Position is mirrored from the
//               anchor's rect (same idea as the drag-region mirror).

export type SurfaceMount =
  | { kind: 'own'; container: HTMLElement }
  | { kind: 'overlay'; anchor: HTMLElement }

export class VizSurface {
  readonly canvas: HTMLCanvasElement
  readonly video: HTMLVideoElement
  /** YouTube-embed fallback player (for videos we can't extract a stream for).
   *  pointer-events:auto so YouTube's own controls are clickable even in the
   *  click-through overlay mount. */
  readonly embed: HTMLIFrameElement
  /** Lyrics overlay layer — sits above the canvas/video, click-through. Populated
   *  by the host-owned LyricsOverlay; re-attached on every remount. */
  readonly lyrics: HTMLDivElement
  /** The window whose devicePixelRatio / rAF this surface lives in. */
  readonly view: Window & typeof globalThis

  private container: HTMLDivElement
  private ro: ResizeObserver | null = null
  private reposTimer: number | null = null

  constructor(mount: SurfaceMount) {
    const host = mount.kind === 'own' ? mount.container : mount.anchor
    const doc = host.ownerDocument
    this.view = doc.defaultView as Window & typeof globalThis

    this.container = doc.createElement('div')
    this.canvas = doc.createElement('canvas')
    this.video = doc.createElement('video')
    this.embed = doc.createElement('iframe')
    this.lyrics = doc.createElement('div')
    this.canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block'
    this.video.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;display:none;object-fit:contain;background:#000'
    this.video.setAttribute('playsinline', '')
    this.embed.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;display:none;border:none;background:#000;pointer-events:auto'
    this.embed.setAttribute('allow', 'autoplay; encrypted-media; fullscreen; picture-in-picture')
    this.embed.setAttribute('allowfullscreen', '')
    this.lyrics.style.cssText = 'position:absolute;inset:0;pointer-events:none;display:none;z-index:2'
    this.container.appendChild(this.canvas)
    this.container.appendChild(this.video)
    this.container.appendChild(this.embed)
    this.container.appendChild(this.lyrics)

    if (mount.kind === 'own') {
      this.container.style.cssText = 'position:absolute;inset:0;background:#000;overflow:hidden'
      mount.container.appendChild(this.container)
    } else {
      // Float over the skin's canvas; clicks fall through to it.
      this.container.style.cssText =
        'position:fixed;background:#000;overflow:hidden;pointer-events:none;z-index:1'
      doc.body.appendChild(this.container)
      const reposition = (): void => {
        const r = mount.anchor.getBoundingClientRect()
        this.container.style.left = `${r.left}px`
        this.container.style.top = `${r.top}px`
        this.container.style.width = `${r.width}px`
        this.container.style.height = `${r.height}px`
        this.container.style.display = r.width > 0 && r.height > 0 ? 'block' : 'none'
      }
      reposition()
      const ro = new this.view.ResizeObserver(reposition)
      this.ro = ro
      ro.observe(mount.anchor)
      ro.observe(doc.body)
      // Catch moves the ResizeObserver can't see (sibling reflow, scroll).
      this.reposTimer = this.view.setInterval(reposition, 400)
    }
  }

  /** For 'own' mounts, the element to attach click/dblclick handlers to. */
  get interactionTarget(): HTMLElement {
    return this.container
  }

  showVideo(): void {
    this.canvas.style.display = 'none'
    this.embed.style.display = 'none'
    this.video.style.display = 'block'
  }

  showCanvas(): void {
    this.video.style.display = 'none'
    this.embed.style.display = 'none'
    this.canvas.style.display = 'block'
  }

  showEmbed(): void {
    this.canvas.style.display = 'none'
    this.video.style.display = 'none'
    this.embed.style.display = 'block'
  }

  destroy(): void {
    this.ro?.disconnect()
    this.ro = null
    if (this.reposTimer !== null) {
      this.view.clearInterval(this.reposTimer)
      this.reposTimer = null
    }
    try {
      this.video.pause()
    } catch {
      /* ignore */
    }
    this.video.removeAttribute('src')
    this.video.load()
    this.embed.removeAttribute('src')
    this.container.remove()
  }
}
