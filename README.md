# YM Collector

Browser console script that collects tracks from a Yandex Music page (liked tracks, a playlist, a chart) into a downloadable text, CSV or JSON file.

## What it does

- Scrolls through the track list and extracts every track
- Reads track and album IDs from the track link, so duplicates are dropped as it goes
- Collects artist(s), title, version (Remix, Live, ...) and duration
- Keeps tracks that are unavailable on Yandex Music and flags them, instead of dropping them
- Shows live progress with a track count and a progress bar when the page shows a total
- Downloads results as `.txt`, `.csv` or `.json`

## Usage

1. Open [Yandex Music](https://music.yandex.ru/) and go to your liked tracks or any playlist
2. Open browser DevTools (`F12` or `Ctrl+Shift+J`)
3. Paste the contents of `ym-collector.js` into the Console tab
4. Press **Start auto-scroll** in the floating panel
5. When the panel shows **Done!**, press one of the download buttons

You can also scroll by hand: the script collects tracks on every scroll.

## Controls

| Button | Action |
|--------|--------|
| **Start / Resume auto-scroll** | Begin or continue auto-scrolling |
| **Pause** | Stop auto-scroll, switch to manual mode |
| **Finalize + download** | Stop and finalize immediately |
| **Download .txt** | `Artist - Title` per line (for Soulseek/Nicotine+/sldl) |
| **Download .csv** | `Artist,Title` |
| **Download .json** | Full data: IDs, duration, link, availability |

## Output format

**TXT**: one track per line, ready for a Soulseek wishlist:
```
VILLIAN, madk1d - ДИНАСТИЯ
MATRANG - Но забудь
Баста - Кинолента
```

**JSON**: full metadata:
```json
{
  "source": "yandex",
  "page": "https://music.yandex.ru/chart",
  "exported_at": "2026-11-23T10:00:00.000Z",
  "tracks": [
    {
      "id": "48591617",
      "album_id": "61945",
      "artist": "Баста",
      "title": "Кинолента",
      "duration": 263,
      "url": "https://music.yandex.ru/album/61945/track/48591617",
      "unavailable": false
    }
  ]
}
```

`duration` is in seconds. Rows without a track link get an `id` of `noid:<artist> - <title>`, and `url: null`.

## How it works

- Targets `CommonTrack_root` rows inside the virtualized (react-virtuoso) list
- Scrolls step by step, waits for the next batch to render, extracts, repeats
- Detects the total track count from the page header for progress
- Stops when the total is reached, or after 15 stale rounds with no scroll movement

Yandex Music changes its markup from time to time. If the counter stays at 0, the selectors in `SEL` at the top of the script need updating.

## Config

Tune timing constants at the top of the script if needed:

```js
const CFG = {
  scrollStep: 400,       // px per auto-scroll step
  waitAfterScroll: 600,  // ms after scroll before extracting
  waitForBatch: 2000,    // ms to wait when no new tracks appear
  maxStaleRounds: 15,    // consecutive empty rounds before stopping
  settlePasses: 5,       // final extraction passes
  settleTickMs: 400,     // ms between settle passes
  debounceMs: 200,       // manual-scroll debounce
};
```

Set `LANG = "ru"` for a Russian UI.

## License

MIT
