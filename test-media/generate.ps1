# Generates test media in every format Ampwin cares about, using the
# project's own bundled ffmpeg. Output lands next to this script (gitignored).
# The tone is an audible upward chirp so seeking is verifiable by ear.
#
# Not generatable by ffmpeg (decode-only): ape, mpc, shn, dsf - cover those
# with real sample files if needed.

$ErrorActionPreference = 'Stop'
$ff = Join-Path $PSScriptRoot '..\node_modules\ffmpeg-static\ffmpeg.exe'
if (-not (Test-Path $ff)) { throw "ffmpeg-static not found at $ff - run npm install first" }
$out = $PSScriptRoot

$base = Join-Path $out 'base.wav'
& $ff -v error -y -f lavfi -i "aevalsrc='0.5*sin(2*PI*t*(220+25*t))':d=30:s=44100" $base

function Enc {
    param([string]$Name, [string[]]$CodecArgs, [string]$Title)
    $target = Join-Path $out $Name
    $meta = @('-metadata', "title=$Title", '-metadata', 'artist=Ampwin Test', '-metadata', 'album=Test Tones')
    & $ff -v error -y -i $base @CodecArgs @meta $target
    if ($LASTEXITCODE -ne 0) { Write-Warning "FAILED: $Name" } else { Write-Host "ok: $Name" }
}

# --- native set (Chromium decodes these directly) ---
Enc 'tone.mp3'      @('-c:a','libmp3lame','-b:a','192k') 'Chirp MP3'
Enc 'tone.flac'     @('-c:a','flac')                     'Chirp FLAC'
Enc 'tone.ogg'      @('-c:a','libvorbis','-q:a','5')     'Chirp Vorbis'
Enc 'tone.opus'     @('-c:a','libopus','-b:a','128k')    'Chirp Opus'
Enc 'tone_aac.m4a'  @('-c:a','aac','-b:a','160k')        'Chirp AAC'
Enc 'tone.wav'      @('-c:a','pcm_s16le')                'Chirp WAV'

# --- transcode set (needs the ffmpeg fallback path, M5) ---
Enc 'tone.wma'      @('-c:a','wmav2','-b:a','160k')      'Chirp WMA'
Enc 'tone_alac.m4a' @('-c:a','alac')                     'Chirp ALAC (extension trap)'
Enc 'tone.wv'       @('-c:a','wavpack')                  'Chirp WavPack'
Enc 'tone.tta'      @('-c:a','tta')                      'Chirp TTA'
Enc 'tone.aiff'     @('-c:a','pcm_s16be')                'Chirp AIFF'
Enc 'tone.mka'      @('-c:a','flac','-f','matroska')     'Chirp MKA'

# --- embedded cover art (mp3 + attached png) ---
$art = Join-Path $out 'art.png'
& $ff -v error -y -f lavfi -i 'testsrc2=size=300x300:rate=1:duration=1' -frames:v 1 $art
& $ff -v error -y -i $base -i $art -map 0:a -map 1:v -c:a libmp3lame -b:a 160k -c:v png `
    -disposition:v attached_pic -metadata title='Chirp With Art' -metadata artist='Ampwin Test' `
    (Join-Path $out 'tone_art.mp3')
Write-Host 'ok: tone_art.mp3'

# --- video: needs-ffmpeg cases ---
# h264 + AC3 in MKV = the classic WEBRip layout (video ok, audio+container not)
& $ff -v error -y -f lavfi -i 'testsrc2=duration=15:size=1280x720:rate=30' `
    -f lavfi -i 'sine=frequency=440:duration=15' `
    -c:v libx264 -pix_fmt yuv420p -c:a ac3 -b:a 192k -shortest (Join-Path $out 'test_ac3.mkv')
Write-Host 'ok: test_ac3.mkv'
# mpeg4 video = Chromium-incompatible video codec (full transcode path)
& $ff -v error -y -f lavfi -i 'testsrc2=duration=15:size=640x360:rate=30' `
    -f lavfi -i 'sine=frequency=440:duration=15' `
    -c:v mpeg4 -q:v 5 -c:a mp2 -shortest (Join-Path $out 'test_mpeg4.avi')
Write-Host 'ok: test_mpeg4.avi'
# 3-minute incompatible video: proves progressive streaming (starts in
# seconds even though full conversion takes much longer)
& $ff -v error -y -f lavfi -i 'testsrc2=duration=180:size=1280x720:rate=30' `
    -f lavfi -i 'sine=frequency=440:duration=180' `
    -c:v mpeg4 -q:v 5 -c:a mp2 -shortest (Join-Path $out 'test_long_mpeg4.avi')
Write-Host 'ok: test_long_mpeg4.avi'

# --- video (M7) ---
& $ff -v error -y -f lavfi -i 'testsrc2=duration=15:size=1280x720:rate=30' `
    -f lavfi -i 'sine=frequency=440:duration=15' `
    -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest (Join-Path $out 'test.mp4')
Write-Host 'ok: test.mp4'
& $ff -v error -y -f lavfi -i 'testsrc2=duration=15:size=1280x720:rate=30' `
    -f lavfi -i 'sine=frequency=440:duration=15' `
    -c:v libvpx-vp9 -deadline realtime -cpu-used 8 -c:a libopus -shortest (Join-Path $out 'test.webm')
Write-Host 'ok: test.webm'

Write-Host "`nAll test media written to $out"
