# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Gym Tracker — a mobile-first, offline-capable workout tracker (exercise library, templates, live workout logging, rest timer, history, personal records). Installable as a home-screen PWA on iOS via GitHub Pages.

Vanilla JS throughout: no framework, no bundler, no npm dependencies, no build step. `js/*.js` are loaded as native ES modules straight from `index.html` (`<script type="module" src="js/app.js">`). Edit a file, refresh the browser.

## Commands

Run the dev server (a zero-dependency static file server, `server.js`):

```bash
node server.js
```

Serves on `http://localhost:8000`. (Also runnable via the `.claude/launch.json` "Gym Tracker" preview config.)

Regenerate the PWA icons (a from-scratch PNG encoder using only Node's built-in `zlib` — no image library):

```bash
node tools/make-icons.js
```

Writes `icons/icon-{180,192,512}.png`. Re-run this if you change the icon artwork in `tools/make-icons.js`.

There is no test suite, linter, or build step in this repo.

## Deployment

Static hosting on GitHub Pages; see `DEPLOY.md` for the full walkthrough. The important constraint for any code change: **every asset reference must stay relative** (`js/app.js`, not `/js/app.js`) because Pages serves the site from a repo subpath (`/repo-name/`), not the domain root. This applies to script/link tags in `index.html`, paths inside `sw.js`, and the manifest's icon paths.

## Architecture

### Data layer: `db.js` + `store.js`

`js/db.js` wraps IndexedDB (`GymTrackerDB`) behind a single `Database` class (singleton export `database`). It owns the schema and version migrations (`DB_VERSION`, bumped in `onupgradeneeded`) across five object stores: `exercises`, `templates`, `workouts`, `media` (blobs kept separate from exercise records so listing the library never drags video into memory), and `settings`.

`js/store.js` holds an in-memory mirror of the DB in a plain `state` object (`exercises`, `templates`, `workouts`, `activeWorkout`). There is **no reactivity** — after any mutation via `db.js`, the calling code must explicitly re-run the matching `loadX()` in `store.js` to refresh `state`, then call the relevant module's `renderX()` to redraw. `bootstrap()` in `store.js` is the top-level data init, called once from `app.js`.

### Module shape

Every feature area (`library.js`, `templates.js`, `workout.js`, `history.js`, `records.js`, `settings.js`) follows the same pair of exports: `initX()` wires event listeners once at boot, `renderX()` tears down and rebuilds that tab's DOM from current `state`. `app.js` is the single entry point — it calls every `initX()` then does the first render pass.

`js/workout.js` is the largest module: it owns the active-workout session state machine (start/finish/discard), the elapsed-time stopwatch (pauses automatically once every set is ticked, driven by a deadline timestamp rather than a decrementing counter so it survives backgrounded-tab throttling), a hand-rolled drag-to-reorder for exercises (pointer events, FLIP-style animation, no library), and timing the "exercise added" entrance animation to when the exercise picker sheet actually closes rather than when the DOM node is inserted (the picker is full-screen, so animating on insertion would play invisibly behind it).

### Shared UI primitives (`dom.js`, `stepper.js`, `sfx.js`)

`dom.js` provides `el()` (builds an element from a props+children object, always via `textContent`, never `innerHTML`), a **modal stack** (`openModal`/`closeModal`/`onModalClosed`), `toast()`, and `confirmSheet()` — a promise-based confirm dialog. Every modal in the app is static markup already present in `index.html`, shown/hidden via the stack rather than created dynamically. `confirmSheet()` resolves exactly once no matter how the sheet closes (Confirm, Cancel, backdrop tap, or Escape) — always reuse it for destructive-action confirmation rather than wiring up ad-hoc confirm logic.

`stepper.js` is the shared −/+ numeric input used everywhere (reps, weight, sets, rest seconds): live keystroke filtering plus min/max clamping. `sfx.js` owns one shared `AudioContext` (unlocked on first tap, since iOS blocks audio before a user gesture) for all sound effects — reuse it rather than creating a second context.

### Units convention

Weight is **always stored in kg** in the database. Conversion to/from the user's chosen display unit (`units.js`: `toDisplay`/`fromDisplay`, `kg`↔`lb`) happens only at the display/input boundary. Never persist a `lb` value.

### PWA / offline layer

`sw.js` is a versioned, cache-first service worker. `CACHE_VERSION` **must be bumped whenever any file in `APP_SHELL` changes** (including adding a new `js/*.js` module to that list) — otherwise the service worker keeps serving the previous cached version indefinitely, both to yourself in local testing and to real installs after a deploy. Precaching fetches each `APP_SHELL` file independently (not `cache.addAll`, which is all-or-nothing and one flaky fetch fails the entire precache) — a single miss during install still lets the rest cache normally.

`manifest.webmanifest` and the icons in `icons/` support "Add to Home Screen" on iOS. Media (exercise demo photos/clips) is excluded from the JSON export/import backup in `settings.js` — blobs can run into the hundreds of megabytes.
