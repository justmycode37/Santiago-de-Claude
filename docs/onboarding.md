# Introduction for a first visit (onboarding)

A device that has not used the app before sees a short introduction before the map:
a welcome page, a demo, two questions, then the map.

## Status (2026-11-21)

| Part | State |
|---|---|
| The introduction: welcome page, first-visit rule, the two questions, the way into the app, "Show the introduction again" | **Complete and tested** (Chromium at phone size, light and dark) |
| The demo walk it shows | **Not complete yet** |

**The demo walk is not finished.** What plays today is the 3D station view's first-person walk across
Hirschengraben in Bern (tram platform B to C, 38 m) as `station3d.js` draws and moves it now. The walk itself,
what you see on the way and how it moves, is still being worked on in a session of its own. Until that is done,
treat the demo as a placeholder for the final one.

The introduction does not have to change when the walk does, as long as the walk keeps to the contract under
[The demo](#the-demo). Nothing in the introduction waits on it: the demo can be skipped, and a demo that cannot
load leads on to the questions.

## Flow

1. **Welcome**: "Want to see what the app can do for you?" with "Yes, show me" and "Not now" (straight to the questions).
2. **Demo**: the 3D view fills the screen above a bottom bar. The bar's button reads "Skip the demo" and becomes
   "Continue" on arrival. The view's own close button and the back gesture also lead on.
3. **Question 1, walking speed**: the five speeds of Settings (`walkKmh`), plus "Adjust to how I walk" (`autoSpeed`).
4. **Question 2, access needs**: `wheelchair`, `stepFree`, `fewerStairs`, `noEscalators`, `lowVision`.
   A stricter need shows the milder ones as included, as in Settings.
5. **Open the map**: the location prompt comes only now.

Every answer is written straight into the settings (`SETTINGS.set`, `settings.js`); the introduction keeps nothing of its own.

## Files

| File | Role |
|---|---|
| `onboarding.js` | The pages and the demo seam (`startDemo`). Adds the row "Show the introduction again" to Settings. |
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

One function in `onboarding.js`, `startDemo(host, onState)`, is the only place that knows what the demo is. Today it calls

```js
Station3D.open({ key: 'bern', from: { stop: { uic: '8579896', ref: 'B' } }, to: { stop: { uic: '8579896', ref: 'C' } },
                 title: 'Bern, Hirschengraben', pov: true, play: true, prefs: SETTINGS.journey(), mount: host })
```

and listens to the viewer's events:

| Event | Meaning for the introduction |
|---|---|
| `arrived`, or `step` with the arriving step | The walk is at its end: the button becomes "Continue". |
| `error` | The view could not be shown. It says why and offers "Try again"; the button becomes "Continue". |
| `open` after an error | It runs after all: the button goes back to "Skip the demo". |
| `close` | The demo is over (its own close button, Done, the back gesture): on to the questions. |

A different demo only has to be started inside `host` and report the same four things.
With `prefers-reduced-motion` the walk does not move by itself; the view's own buttons step through it.
