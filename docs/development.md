# Working on the app

The app is written in TypeScript. The browser still gets plain scripts with the names it always had: the build
only takes the types out, so `dist/live.js` is `src/live.ts` line for line and no source maps are needed.

```bash
npm install     # once; needs Node.js 22.18 or newer
npm run dev     # builds dist/, serves http://localhost:8000, rebuilds when you save a file
npm run check   # check the types
npm test        # the station router's tests
npm run build   # dist/ once, without the dev server
```

`npm run dev -- 8000 0.0.0.0` makes the dev server reachable from other devices. For a phone,
`python3 tools/serve.py` serves the same `dist/` gzipped and cached.

## Where things are

| Source | Becomes |
| --- | --- |
| `src/<name>.ts` | `<name>.js`, a script the page loads (`src/live.ts` → `live.js`) |
| `src/app/*.ts` | the page's own script, joined in file name order and put into `index.html` |
| `src/types/*.d.ts` | nothing: the types the scripts share |
| `index.html`, `*.css`, the `.js` files in the repository root (generated data, `config.js`) | copied as they are |
| `event-images/`, `stop-images/`, `stations3d/`, `demo-media/` | copied as they are |

`scripts/build.mts` does this. Add `--release` for exactly what is published: without the `*-dev.html` pages and a
local `config.js`. The Pages workflow runs that on every push to `main`.

## Scripts, not modules

Every file in `src/` is a plain script, loaded with a `<script>` tag as before. So:

- No `import` or `export` at the top level of a file in `src/`. A new script needs its `<script src="name.js">`
  tag in `index.html`.
- What a script gives the others, it puts on `window` (`window.SETTINGS = …`), and its type is declared in
  `src/types/` with `declare var SETTINGS: SettingsApi;`. Types only one script needs live inside that script.
- The files in `src/app` are the parts of one script: they share one scope, and the number in a file's name is
  its place in that script. Whatever one of them declares at its top level, all of them see. A new section can be
  a new file; pick a number that puts it where it has to run.
- Only type syntax that can be erased: annotations, `interface`, `type`, `as`, `!`, generics. No `enum`,
  no `namespace`, no parameter properties (`erasableSyntaxOnly` in `tsconfig.json` reports them).

A type error never blocks a build or a deploy; `npm run check` and the Check workflow report it.

## Moving a branch from before the move to TypeScript

- A change to a script that moved (`settings.js` → `src/settings.ts`) merges by itself.
- A change to the `<script>` at the end of `index.html` conflicts: move it into the matching `src/app/` file.
- A new plain `.js` file in the repository root still works: it is copied as before. Move it to `src/<name>.ts`
  when you want it type-checked.
