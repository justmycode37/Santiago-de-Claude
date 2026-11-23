# Working on the app

The app is written in TypeScript, as ES modules. esbuild bundles them: the page loads `main.js` and the few files
it imports, and what is used only now and then (the 3D station view, Scan, the fare suggestions) is in files of its
own that are fetched the first time they are needed. Source maps come with every file.

```bash
npm install     # once; needs Node.js 22.18 or newer
npm run dev     # builds dist/, serves http://localhost:8000, rebuilds when you save a file
npm run check   # check the types
npm test        # the tests
npm run build   # dist/ once, without the dev server
```

`npm run dev -- 8000 0.0.0.0` makes the dev server reachable from other devices. For a phone,
`python3 tools/serve.py` serves the same `dist/` gzipped and cached.

`?dev` in the address shows the "Developer options" switch at the bottom of Settings (tools to test
"Adjust to how I walk"). Once switched on, it stays visible without the flag.

## Where things are

| Source | Becomes |
| --- | --- |
| `src/main.ts` and what it imports | `main.js` and `chunks/`: the page's script (`index.html` loads it with `<script type="module">`) |
| `src/pages/scan-bench.ts`, `src/pages/station3d-solid.page.ts` | `pages/*.js`: the scripts of `scan-bench.html` and `station3d-solid.html`, bundled the same way |
| `src/translate.ts` | `translate.js`, a plain script (it runs before maplibre has downloaded) |
| `src/inline/*.ts`, the other `src/pages/*.ts` | written into the pages as plain `<script>`s (theme, first visit, early location and map style; the demo pages) |
| `src/types/*.d.ts` | nothing: the global types that belong to no module (see below) |
| `*.html` | copied, with each line `<!-- build: src/… -->` replaced by that script |
| `*.css`, the `.js` files in the repository root (generated data, `config.js`) | copied as they are |
| `event-images/`, `stop-images/`, `stations3d/`, `demo-media/`, `walkgraph/` | copied as they are |

`scripts/build.mts` does this; its `ENTRIES` are the modules a page loads, its `SCRIPTS` the plain scripts. Add
`--release` for exactly what is published: without the `*-dev.html` pages and a local `config.js`. The Pages workflow
runs that on every push to `main`.

## Modules

- A module imports what it uses from the module that has it, with the file's extension
  (`import { SETTINGS } from './settings.ts'`), and types the same way (`import type { Journey } from
  './engine-journey.ts'`). A module's API is what it exports; its type is the type of that export
  (`typeof SETTINGS`), not a second copy.
- What is loaded on first use is loaded with `import()` (`import('./station-view.ts')`), so it stays out of `main.js`.
- Only type syntax that can be erased: annotations, `interface`, `type`, `as`, `!`, generics. No `enum`, no
  `namespace`, no parameter properties (`erasableSyntaxOnly` in `tsconfig.json` reports them). Node runs the
  modules as they are for the tests.

### The order things start in

`src/main.ts` imports the modules beside the page's own (settings, the introduction, the engine's client, …) in the
order the page has always run them. Each does its work as it loads (the settings page builds itself, the
introduction opens on a first visit), so each imports only modules above it in that list, or modules that do
nothing as they load (`toast.ts`, `theme.ts`, `map-style.ts`). A module that needs something of the page's own
parts gets it handed over instead: `settings.ts` gives `pricing-history.ts` its fare-tracking switch
(`keepTripsWhen()`), the map's style follows the theme through `onThemeChange()`.

The page's own parts, `src/app/`, import from each other both ways (the sheet draws the journey, the journey redraws
the sheet), so the order they load in follows their imports and is not fixed. That is why none of them does anything
as it loads beyond making its own elements and objects: what each does when the page starts (listeners, the first
requests) is in its `start()`, and `main.ts` calls those one after the other. A new listener or first call goes into
its part's `start()`; a new part with one gets its `start()` called in `main.ts`, where it has to run. `map.ts`, which
imports nothing of the page, makes the map as it loads.

### State that several parts change

A module's `let` can only be assigned inside that module. What more than one part of the page sets is in
`src/app/state.ts`, as properties of a few objects: `journey` (the journey on show and its plan), `sheet`,
`tracking`, `searchState`, `popup`. `journey.conn = …` works from anywhere. State that only one part sets stays in
that part, exported when others read it. `state.ts` touches nothing of the page, so the tests import it as it is.

## Globals

`window` holds only what is used from outside the bundle:

- the generated data files and `config.js`, plain scripts that put themselves on `window` (`PLATFORM_DATA`,
  `MAP_PLACES`, `BERN_EVENTS`, `STATION3D`, …), and the two callbacks the data tiles call when they load
  (`WALKGRAPH_TILE`, `STOP_IMAGES_TILE`);
- `APP_LANG` from `translate.js`, which runs before the bundle;
- `EARLY_GEO` and `EARLY_STYLE` from the script in the `<head>` of `index.html` (the location and the map style,
  started before anything else has loaded), and `SOLID_READY` on `station3d-solid.html`;
- `map` and `showDestinationJourney`, which the screen recordings in `demo/pitch-video/capture/` call.

`src/types/` holds the types of those globals and the ones no module owns: the engine's JSON (`kante.d.ts`), the
generated data's format, the libraries the pages load from a CDN (maplibre, three.js, tesseract.js, onnxruntime) and
what the browser's own types lack (`browser.d.ts`).

A type error never blocks a build or a deploy; `npm run check` and the Check workflow report it.

## Outside the site

- `tools/*.mts` are the data builders and the tests, `livemap/server.mts` the live map's server. Node runs them as
  they are: `node tools/build-map-places.mts`. They import the app's modules directly
  (`import { StationRoute } from '../src/station-route.ts'`). `tools/test_walkrefine.mts` imports
  `src/app/routing.ts` with the parts of the page it imports stubbed (`node --experimental-test-module-mocks`,
  as `npm test` runs it).
- They have their own type checks: `tools/tsconfig.json`, and `tools/tsconfig.page.json` for the few that import a
  module of the page that uses the DOM (with the DOM's types, which clash with Node's elsewhere); `livemap/`'s own.
- `livemap/page.ts` and `page-old.ts` are the scripts of the live map's two pages; its server writes them into
  the HTML when it serves a page.
- `npm run check` checks all of it: the app, the other pages, `scripts/`, `tools/` and `livemap/`.

Still JavaScript, on purpose: the generated data files, `config.example.js` (a template for `config.js`, which the
page loads as it is), the engine's playground page (`kante/engine/playground/`, served by the Rust server without
a build) and the iPhone app's `rightside/` (its `domain.js` is bundled into the app by Xcode).

## Moving a branch from before the modules

- A change to a file of `src/app/` merges into the file without the number (`src/app/66-pill.ts` →
  `src/app/pill.ts`). A top-level statement that does something (a listener, a first call) goes into that file's
  `start()`.
- A variable of `state.ts` is now a property: `journeyConn` → `journey.conn`, `jFocus` → `sheet.focus`,
  `activeField` → `searchState.field` (`state.ts` has them all).
- What came from `window` or another file's top level is imported now: the type checker names what is missing.
- A new script: a module imported where it is used (`import()` if it is needed only now and then), not a
  `<script>` tag.
