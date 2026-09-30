# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- **Start production:** `npm start` (runs `node index.js`)
- **Start development:** `npm run dev` (runs `nodemon index.js` — auto-reloads on file changes)
- **Access app:** http://localhost:8080 (or `PORT` env var)

## Architecture

This is a Node.js/Express web app designed to run on a Raspberry Pi as an on-stage lyrics/setlist display, controlled by 3 physical foot-switch buttons.

### Server ([index.js](index.js))

- Express on port 8080 with Pug templates and Showdown Markdown
- Scans both local `setlists/setlist-*/` directories and USB drives (via `drivelist` + `glob`) for `setlist.json` manifests
- Persists the selected setlist via `node-persist`
- Custom Showdown extensions transform `~refrain~...~/refrain~` and `~bridge~...~/bridge~` tags into colored `<span>` elements, and insert `<br>` after each lyric line

### Routes

| Route | Purpose |
|-------|---------|
| `GET /` | Setlist view — lists all songs in selected setlist |
| `GET /:filename` | Song view — renders a `.md` lyrics file as HTML |
| `GET /setlists` | Setlists view — select active setlist |
| `POST /setlists` | Save selected setlist to persistent storage |

### Frontend Button System ([views/layout.pug](views/layout.pug))

All pages share a 3-button footer (left/middle/right). Keyboard keycodes are configurable via env vars (`KEYCODE_LEFT`, `KEYCODE_MIDDLE`, `KEYCODE_RIGHT`). Each button supports:
- **Short press**: navigate up/down, select, scroll. On a button that also has a long press, only releases under 250 ms count; releasing between 250 ms and 1.6 s is a canceled long press and does nothing
- **Long press** (≥ 1.6s): open the options overlay (shared code in `views/modal.pug`, options per page in `views/setlist_modal.pug` / `views/setlists_modal.pug`). On the setlist page, "Add song" (opened directly on an empty setlist) lists every song file in `setlists/` (`getSongLibrary()`); SELECT checks songs, and "Add songs" copies their files into the active setlist's directory if needed and inserts them, in the order they were checked, after the highlighted entry (`POST /api/setlist/song/add-from-library`). Its "Move" option marks the highlighted song or pause, so UP/DOWN move it and a short press unmarks it and saves the order to `setlist.json` (`POST /api/setlist/order`)
- **Hold to scroll** (opt-in per page via `window.repeatButtons`): holding UP/DOWN fires `repeatPress` after 400 ms, then every 150 ms, instead of a short or long press. Used on the setlist and setlists pages and in their overlays (incl. "Add Song"); stops at the ends of the list. `repeatStart` / `repeatEnd` bracket the hold; the song page uses them to scroll the lyrics smoothly (`holdScrollSpeed`, pixels per second) while UP/DOWN is held
- **Double press** (opt-in per page via `window.doublePressButtons`): middle = back (song → setlist → setlists page), left/right on the song page = prev/next song

Page-specific logic is injected via Pug `block scripts` and uses `window.shortPressAction` / `window.longPressAction` callbacks.

### Data Format

**Setlist manifest** (`setlists/setlist-*/setlist.json`):
```json
{ "songs": [{ "name": "Song Title", "filename": "song-file.md" }] }
```
The setlist's display name is its directory name (e.g. `setlist-2026`).
Songs removed from a setlist ("Remove song" in the setlist page's overlay, `POST /api/setlist/entry/remove`) are moved to `setlists/deleted/<filename>.md`, with their names in `setlists/deleted/songs.json`; they stay in the "Add song" list. Whole deleted setlists live in `setlists/deleted/<setlist>/` and are not in that list.
An entry `{ "pause": true }` in `songs` is a pause: shown as an empty, unnumbered block on the setlist page and skipped by prev/next song navigation.

**Song lyrics** (`setlists/setlist-*/*.md`): Standard Markdown with custom tags:
- `~refrain~...~/refrain~` — colored refrain block
- `~bridge~...~/bridge~` — colored bridge block

### Environment Variables (`.env`)

```
PORT=8080
FONT_SIZE=30px
REFRAIN_COLOR=yellow
BRIDGE_COLOR=orange
HIGHLIGHT_COLOR=yellow
KEYCODE_LEFT=37
KEYCODE_MIDDLE=40
KEYCODE_RIGHT=39
```

## Raspberry Pi Deployment

Auto-start via cron (`@reboot node /usr/src/raspberry-text-monitor/index.js &`), display rotated via `xrandr`, Chromium launched in kiosk mode pointing to localhost:8080.
