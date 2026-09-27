# Korean OCR Subtitler

A Chrome extension that watches burned-in ("hardsubbed") Korean captions on a
YouTube video and exports them as a timed `.srt` file — entirely locally,
using [Tesseract.js](https://github.com/naptha/tesseract.js) (WASM OCR). No
API key, no server, no cost.

Built for cases where a video has Korean text baked into the picture but no
real subtitle track to download (e.g. variety shows, reaction clips) — so you
can feed it into a normal subs2srs / Anki / translation pipeline afterward.

## How it works

1. You drag a box over the area of the video where the Korean captions
   appear (once per video — it's remembered).
2. The extension samples the video ~3×/second, and only runs OCR when the
   cropped region's pixels actually change (so it isn't OCR'ing every frame).
3. When the recognized text changes, it closes out the previous subtitle line
   and opens a new one, using the video's own playback clock
   (`video.currentTime`) for timestamps — so the exported `.srt` lines up with
   this same video file if you also download it (e.g. via `yt-dlp`).
4. "Export .srt" saves what's been captured so far as a normal SRT file.

## Install (unpacked / developer mode)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select the cloned `korean-ocr-subtitler/` folder.
4. Open any `https://www.youtube.com/watch?v=...` video. A small panel
   appears near the top-right of the page.

## Usage

1. Play the video until a caption is on screen.
2. Click **🎯 Set Subtitle Region** in the panel, then drag a box tightly
   around just the caption text (a little padding is fine; try to exclude
   unrelated on-screen graphics).
3. Pick a **Speed** (1x/2x/4x) — this sets the video's actual playback rate
   (bypassing YouTube's own 2x UI cap), so you don't have to sit through the
   video in real time. 2x is a safe default; 4x risks skipping very short
   captions since there's less wall-clock time to confirm a line is stable
   before OCR-ing it.
4. Click **▶ Start** — this also presses play for you. Watch the "Lines"
   counter and the live text preview at the bottom of the panel to
   sanity-check recognition quality as you go.
5. Capture stops automatically when the video ends (or click **⏹ Stop**
   any time).
6. Click **⬇ Export .srt** to download the file.

The toolbar icon's popup mirrors these controls if you want quick access
without scrolling to find the on-page panel.

### The "Enhance light-colored text" checkbox

On by default. It converts the cropped region into black text on a white
background by keeping only high-lightness pixels (catches white and yellow
caption styles, which cover most Korean variety/drama hardsubs) and
discarding everything else. Turn it off if your captions are a dark color on
a light background, or if you find OCR quality is worse with it on for a
particular video.

## Known limitations (v1)

- **YouTube only, and only the top-level `/watch` page** — not Shorts, not
  embeds.
- **The crop box is relative to the `<video>` element's rendered box**, not
  the actual video content. If YouTube is letterboxing/pillarboxing the video
  (black bars because the video's aspect ratio doesn't match the player), the
  box will be slightly off from the real pixels. Re-adjust the box if the
  live preview text looks wrong.
- **Seeking/scrubbing while capturing resets in-progress caption tracking**
  (to avoid corrupt timestamps). Already-captured lines are kept. For best
  results, start capture and let it play through linearly.
- **Only recognizes Korean** (`kor` traineddata). Mixed-language captions
  (e.g. Korean + English on screen at once) will have degraded accuracy on
  the non-Korean parts.
- OCR quality depends heavily on video resolution and font — expect to
  hand-correct some lines afterward, same as any OCR tool.
- First "Start" on a given browser session takes a moment to load the OCR
  engine (~1.7MB, bundled locally — no network request).

## Project layout

```
manifest.json              MV3 manifest
content/content.js         All the logic: region picker, sampling loop,
                            OCR pipeline, SRT export, floating panel UI
popup/                      Toolbar popup (thin remote control)
vendor/tesseract/           Tesseract.js + WASM core + kor.traineddata,
                            vendored locally so nothing is fetched at runtime
icons/                      Extension icons
```

## License

MIT for this extension's code. The bundled [Tesseract.js](https://github.com/naptha/tesseract.js)
files in `vendor/tesseract/` are Apache-2.0, and `kor.traineddata` comes from
[tesseract-ocr/tessdata](https://github.com/tesseract-ocr/tessdata) (Apache-2.0).
