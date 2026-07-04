import { describe, expect, it } from 'vitest'
import { parseM3u, parsePls, serializeM3u } from './playlistFormats'

const BASE = 'C:\\Music\\Playlists'

describe('parseM3u', () => {
  it('parses extended m3u with EXTINF', () => {
    const text = [
      '#EXTM3U',
      '#EXTINF:213,Daft Punk - Harder Better Faster Stronger',
      'C:\\Music\\Discovery\\04 Harder.mp3',
      '#EXTINF:180,Other',
      '..\\Albums\\other.flac'
    ].join('\n')
    const { entries, skippedUrls } = parseM3u(text, BASE)
    expect(skippedUrls).toEqual([])
    expect(entries).toHaveLength(2)
    expect(entries[0]).toEqual({
      path: 'C:\\Music\\Discovery\\04 Harder.mp3',
      title: 'Daft Punk - Harder Better Faster Stronger',
      durationSec: 213
    })
    expect(entries[1].path).toBe('C:\\Music\\Albums\\other.flac')
  })

  it('handles plain m3u without directives and forward slashes', () => {
    const { entries } = parseM3u('sub/track.mp3\r\nC:/direct/abs.flac\r\n', BASE)
    expect(entries[0].path).toBe('C:\\Music\\Playlists\\sub\\track.mp3')
    expect(entries[0].title).toBeUndefined()
    expect(entries[1].path).toBe('C:\\direct\\abs.flac')
  })

  it('skips URLs but reports them', () => {
    const { entries, skippedUrls } = parseM3u(
      '#EXTINF:-1,Radio\nhttp://stream.example.com/live\nlocal.mp3',
      BASE
    )
    expect(skippedUrls).toEqual(['http://stream.example.com/live'])
    expect(entries).toHaveLength(1)
    // EXTINF belonging to the skipped URL must not leak onto the next entry
    expect(entries[0].title).toBeUndefined()
  })

  it('handles EXTINF with negative duration and empty title', () => {
    const { entries } = parseM3u('#EXTINF:-1,\ntrack.mp3', BASE)
    expect(entries[0].durationSec).toBeUndefined()
    expect(entries[0].title).toBeUndefined()
  })
})

describe('parsePls', () => {
  it('parses a well-formed pls with out-of-order keys', () => {
    const text = [
      '[playlist]',
      'Title2=Second',
      'File1=C:\\a\\one.mp3',
      'File2=two.ogg',
      'Length1=120',
      'Title1=First',
      'NumberOfEntries=2'
    ].join('\n')
    const { entries } = parsePls(text, BASE)
    expect(entries).toHaveLength(2)
    expect(entries[0]).toEqual({ path: 'C:\\a\\one.mp3', title: 'First', durationSec: 120 })
    expect(entries[1]).toEqual({
      path: 'C:\\Music\\Playlists\\two.ogg',
      title: 'Second',
      durationSec: undefined
    })
  })

  it('survives malformed lines and missing section header', () => {
    const { entries } = parsePls('garbage\nFile1=ok.mp3\nFileX=broken\nLength1=abc', BASE)
    expect(entries).toHaveLength(1)
    expect(entries[0].durationSec).toBeUndefined()
  })

  it('skips stream URLs', () => {
    const { entries, skippedUrls } = parsePls('File1=https://radio.example/live\nFile2=ok.mp3', BASE)
    expect(skippedUrls).toEqual(['https://radio.example/live'])
    expect(entries).toHaveLength(1)
  })
})

describe('serializeM3u', () => {
  const tracks = [
    { path: 'C:\\Music\\Discovery\\04 Harder.mp3', title: 'Harder', artist: 'Daft Punk', durationSec: 212.6 },
    { path: 'D:\\other\\b.flac', title: 'NoArtist', artist: '', durationSec: 60 }
  ]

  it('writes extended m3u with absolute paths', () => {
    const out = serializeM3u(tracks)
    expect(out).toContain('#EXTM3U')
    expect(out).toContain('#EXTINF:213,Daft Punk - Harder')
    expect(out).toContain('C:\\Music\\Discovery\\04 Harder.mp3')
    expect(out).toContain('#EXTINF:60,NoArtist')
  })

  it('writes relative paths when possible, absolute across drives', () => {
    const out = serializeM3u(tracks, { relativeTo: 'C:\\Music\\Playlists\\mix.m3u8' })
    expect(out).toContain('..\\Discovery\\04 Harder.mp3')
    expect(out).toContain('D:\\other\\b.flac')
  })

  it('round-trips through parseM3u', () => {
    const out = serializeM3u(tracks, { relativeTo: 'C:\\Music\\Playlists\\mix.m3u8' })
    const { entries } = parseM3u(out, 'C:\\Music\\Playlists')
    expect(entries.map((e) => e.path)).toEqual(tracks.map((t) => t.path))
    expect(entries[0].title).toBe('Daft Punk - Harder')
    expect(entries[0].durationSec).toBe(213)
  })
})
