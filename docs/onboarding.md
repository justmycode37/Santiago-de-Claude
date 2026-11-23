# Introduction for a first visit (onboarding)

A device that has not used the app before sees a short introduction before the map:
a welcome page, a demo, two questions, then the map.

## Status (2026-11-23)

| Part | State |
|---|---|
| The introduction: welcome page, first-visit rule, the two questions, the way into the app, "Show the introduction again" | **Complete and tested** (Chromium at phone size, light and dark) |
| The demo it shows: a journey in three acts (walk, tram ride, walk) on a tilted map | **Built and tested** (Chromium at phone size: playing, skipped, back gesture, reduced motion, map not loading) |

Nothing in the introduction waits on the demo: it can be skipped, and a demo that cannot load leads on to the questions.

## Flow

1. **Welcome**: "Want to see what the app can do for you?" with "Yes, show me" and "Skip demo" (straight to the questions).
2. **Demo**: a short journey in Bern fills the screen above a bottom bar, on a tilted map: the walk across
   Hirschengraben to the tram, the ride of one stop, the walk to the main station. The bar shows which of the three
   acts is playing; its button reads "Skip the demo" and becomes "Continue" on arrival. The back gesture also leads on.
3. **Question 1, walking speed**: the five speeds of Settings (`walkKmh`), plus "Adjust to how I walk" (`autoSpeed`).
4. **Question 2, access needs**: `wheelchair`, `stepFree`, `fewerStairs`, `noEscalators`, `lowVision`.
   A stricter need shows the milder ones as included, as in Settings.
5. **Open the map**: the location prompt comes only now.

Every answer is written straight into the settings (`SETTINGS.set`, `settings.ts`); the introduction keeps nothing of its own.

## Files

| File | Role |
|---|---|
| `src/onboarding.ts` | The pages and the demo (`startDemo`): the three acts and their map. Adds the row "Show the introduction again" to Settings. |
| `onboarding.css` | Its styles, loaded only when the introduction shows. Rows, icons and switches are the settings page's own classes. |
| `index.html`, `<head>` | Decides whether it shows, covers the map until it is over (`:root[data-onboarding]`), and holds back the location prompt (`EARLY_GEO.start()`). |

## When it shows

`localStorage` key `onboarding`: `started` until the introduction has been finished, then `done`.

- A device with none of `app-settings`, `app-language`, `lastLocation`, `theme`, `event-preferences` is new and sees it.
  Any of them means the app was used before: it is marked `done` without showing.
- `?intro` shows it again (dropped from the address afterwards). `?intro=0` switches it off, for tests and screen recordings.
- Settings › "Show the introduction again".
- If `onboarding.css` cannot load, the app starts as usual.

## The demo

One function in `src/onboarding.ts`, `startDemo(host, onState)`, is the only place that knows what the demo is.
It plays a fixed journey (no timetable request, the same at any time of day) in three acts inside `host`, on one
MapLibre map of its own with the app's map style, tilted, with the houses standing up. A card at the top says what the
app tells you at that moment; the map follows you and turns with the way you go.

| Act | What you see |
|---|---|
| 1 | Your blue dot walks from stop C across Hirschengraben to tram platform B (40 m), along the yellow line of the walk. |
| 2 | "Waiting for tram 9", then the dot becomes the tram's badge, the card says the app noticed that you got on, and the badge glides along the red track to Bern, Bahnhof: "get off here". |
| 3 | The dot steps off and walks across Bahnhofplatz and under the Baldachin to the main entrance (100 m): "You have arrived". |

The two walks are the routes the station router finds in `stations3d/bern.js` (stop C → stop B of Hirschengraben;
stop B of Bern, Bahnhof → in front of the main entrance), and the track is the tram track of that model; all three
are written into `src/onboarding.ts` in the model's metres, so the demo loads nothing but the map.

Before act 1 a page with the trip at a glance (the three legs, coming in slowly one after the other) covers the map
until it is there, and for long enough to be read; then it fades and the walk sets off. The map counts as there once
its style has loaded and the first tile of the base map has come. If that has not happened within 12 seconds
(`LOAD_MS`: no network, no WebGL, no tiles), the page stays with a line saying so, the button becomes "Continue", and
nothing more is built or run (a style that answers later is ignored).

Until November 2026 acts 1 and 3 were first-person walks in a 3D street scene, drawn by the first 3D station viewer
(`station3d.js`). That viewer was removed; the station view that remains opens only as a full-screen overlay of its
own, so the walks moved onto the demo's map.

**Hold to go faster.** A touch on the picture does not stop or turn anything. While a finger is held down anywhere on
the picture, or on the button at its right edge where the thumb rests, the whole journey runs twice as fast (`FAST`):
the walks, the ride and the pauses between them. Without a finger on it, it already plays at three times the pace it
was made at (`PACE`), so held down it is six times that. Fades and the trip at a glance keep their own length.

`onState` hears:

| State | Meaning for the introduction |
|---|---|
| `1`, `2`, `3` | That act begins: the bar marks it. |
| `'arrived'` | The journey is at its end (the last picture stays): the button becomes "Continue". |
| `'error'` | The map could not be shown: the button becomes "Continue". |

`over` resolves when the demo has gone (`finished`, `skipped`, `unavailable`); `close()` ends it from outside, and so
does the back gesture: the demo adds a history entry while it runs and takes it away again when it ends. That entry's
address has no `?intro`, so going forward to it after the introduction does not bring the introduction back on a
reload. Taking it away (`history.back()`) arrives later as a `popstate`; a demo started again before it has arrived
waits for it before adding its own entry, so it cannot be ended by the earlier one's. `arrived` and `error` exclude
each other. A different demo only has to be started inside `host` and report the same things.

With `prefers-reduced-motion` nothing moves by itself: the button reads "Next" and each press shows the next act as a
still picture (`next()`), then "Continue". Until the map is there, "Next" does nothing: no act is shown or announced
before its picture can be.
