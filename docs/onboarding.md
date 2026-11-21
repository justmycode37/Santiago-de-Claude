# Introduction for a first visit (onboarding)

A device that has not used the app before sees a short introduction before the map:
a welcome page, a demo, two questions, then the map.

## Status (2026-11-21)

| Part | State |
|---|---|
| The introduction: welcome page, first-visit rule, the two questions, the way into the app, "Show the introduction again" | **Complete and tested** (Chromium at phone size, light and dark) |
| The demo it shows: a journey in three acts (walk, tram ride, walk) | **Built; being polished** (see [The demo](#the-demo) for what each act draws today) |

Nothing in the introduction waits on the demo: it can be skipped, and a demo that cannot load leads on to the questions.

## Flow

1. **Welcome**: "Want to see what the app can do for you?" with "Yes, show me" and "Not now" (straight to the questions).
2. **Demo**: a short journey in Bern fills the screen above a bottom bar: a first-person walk across Hirschengraben
   to the tram, the ride of one stop on a tilted map, a first-person walk to the main station. The bar shows which of
   the three acts is playing; its button reads "Skip the demo" and becomes "Continue" on arrival. The back gesture
   also leads on.
3. **Question 1, walking speed**: the five speeds of Settings (`walkKmh`), plus "Adjust to how I walk" (`autoSpeed`).
4. **Question 2, access needs**: `wheelchair`, `stepFree`, `fewerStairs`, `noEscalators`, `lowVision`.
   A stricter need shows the milder ones as included, as in Settings.
5. **Open the map**: the location prompt comes only now.

Every answer is written straight into the settings (`SETTINGS.set`, `settings.js`); the introduction keeps nothing of its own.

## Files

| File | Role |
|---|---|
| `src/onboarding.ts` | The pages and the demo (`startDemo`): the three acts and the ride's map. Adds the row "Show the introduction again" to Settings. |
| `onboarding.css` | Its styles, loaded only when the introduction shows. Rows, icons and switches are the settings page's own classes. |
| `index.html`, `<head>` | Decides whether it shows, covers the map until it is over (`:root[data-onboarding]`), and holds back the location prompt (`EARLY_GEO.start()`). |

## When it shows

`localStorage` key `onboarding`: `started` until the introduction has been finished, then `done`.

- A device with none of `app-settings`, `app-language`, `lastLocation`, `theme`, `event-preferences` is new and sees it.
  Any of them means the app was used before: it is marked `done` without showing.
- `?intro` shows it again (dropped from the address afterwards). `?intro=0` switches it off, for tests and screen recordings.
- Settings › "Show the introduction again".
- If `onboarding.js` or `onboarding.css` cannot load, the app starts as usual.

## The demo

One function in `src/onboarding.ts`, `startDemo(host, onState)`, is the only place that knows what the demo is.
It plays a fixed journey (no timetable request, the same at any time of day) in three acts inside `host`:

| Act | What you see | Drawn by |
|---|---|---|
| 1 | A first-person walk from the east side of Hirschengraben across the roadway and past the Bubenberg monument to tram platform B. As you reach the platform, tram 9 pulls in and opens its doors. | `Station3D.open({ key: 'bern', from: stop C, to: stop B, pov: true, play, chrome: 'demo', arrive: { look }, mount: host })`, the Hirschengraben detail scene, the renderer's tram (`Station3D.detail().addVehicle`) |
| 2 | The picture fades to a tilted map. Your blue dot becomes the tram's badge, a card says the app noticed that you got on, and the badge glides along the track to Bern, Bahnhof. | A MapLibre map of its own in the demo's box, with the app's map style; the track is the one of `stations3d/bern.js` |
| 3 | Back in first person: from tram platform B at the station to the main entrance. The tram you came on drives off. | `Station3D.open({ key: 'bern', from: stop B of Bern, Bahnhof, to: a point in front of the main entrance, ... })`, the Bahnhofplatz detail scene where it is built, else the plain station model |

Nothing is shown while it loads. Before act 1 a page with the trip at a glance (the three legs, coming in slowly one
after the other) covers the 3D view until the street is built behind it; then it fades and the walk sets off. The
second walk is opened, waiting, while the map covers it, and the map does not start to move before that scene is built.

**Hold to go faster.** A touch on the picture does not stop or turn anything. While a finger is held down anywhere on
the picture, or on the button at its right edge where the thumb rests, the whole journey runs three times as fast
(`FAST`): the walks, the ride and the pauses between them.

`onState` hears:

| State | Meaning for the introduction |
|---|---|
| `1`, `2`, `3` | That act begins: the bar marks it. |
| `'arrived'` | The journey is at its end (the last view stays open): the button becomes "Continue". |
| `'error'` | The 3D view could not be shown. It says why and offers "Try again"; the button becomes "Continue". |
| `'playing'` | It runs after all: the button goes back to "Skip the demo". |

`over` resolves when the demo has gone (`finished`, `skipped`, `unavailable`); `close()` ends it from outside.
A different demo only has to be started inside `host` and report the same things.

With `prefers-reduced-motion` nothing moves by itself: the button reads "Next" and each press shows the next act as a
still picture (`next()`), then "Continue".
