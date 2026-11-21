# Detail scenes

A detail scene is a short stretch (tens of metres) of a station model drawn with everything you would
recognise on the spot: trees, benches, street lamps, kerbs and ledges, the houses at their real size.
It is extra data for the first-person view of `station3d.js`, for places where the plain model is too bare.

Two pieces share this format:

| Piece | File | Role |
| --- | --- | --- |
| Data | `stations3d/<key>.detail.js` | sets `window.STATION3D_DETAIL["<key>"] = detail` (loaded on demand, like the model) |
| Renderer | `station3d-detail.js` (`window.Station3DDetail`) | turns a `detail` object into three.js objects |

## Coordinates

Same local frame as the station model (`SCHEMA.md`): metres around the model's `origin`, **x = east, y = north**.
Heights are **z in metres relative to the model's level 0** (real heights; a sloping street has different z along it).
`heading` is a compass bearing in degrees (0 = north, 90 = east): the way the object faces.

## detail

```js
{
  key: "bern", name: "Hirschengraben", built: "2026-11-21",
  attribution: ["© OpenStreetMap contributors", "Geodaten Stadt Bern", "© swisstopo"],
  area: [[x, y], ...],                 // outline of the detailed stretch (the renderer may fade towards its edge)
  path: [[x, y, z], ...],              // the showcase walk itself, for framing and tests

  // Ground. Drawn in order; later ones lie on top. z is the surface height (flat) or omit and give `zs` per ring point.
  surfaces: [{ kind: "asphalt" | "paving" | "cobble" | "gravel" | "grass" | "soil" | "tram-track" | "crossing" | "water",
               ring: [[x, y], ...], holes: [...], z: 0.2, zs: [...] }],

  // Linear things with a height you could trip over or sit on.
  edges: [{ kind: "kerb" | "ledge" | "wall" | "fence" | "railing" | "hedge" | "steps",
            line: [[x, y], ...], z: 0.2, height: 0.12, width: 0.15, closed: false }],

  trees: [{ xy: [x, y], z: 0.2, height: 14, crown: 4.5, trunk: 0.3,          // crown = radius, trunk = radius, metres
            crownBase: 3.5, kind: "broadleaf" | "conifer" | "columnar", species: "Aesculus hippocastanum",
            leaves: true }],                                                    // false: bare (winter)

  props: [{ kind: "bench" | "lamp" | "bollard" | "bin" | "bike-stand" | "fountain" | "planter" | "hydrant" |
                  "sign-post" | "pole" | "shelter" | "clock" | "statue",
            xy: [x, y], z: 0.2, heading: 90,
            height: 4.5, length: 1.8, width: 0.5,                               // what is known; the renderer has defaults
            variant: "", name: "" },
          // a glass roof on columns (no xy): its outline, the underside of its edge above the ground, how much
          // higher its middle is, and where the columns stand (left out: every 12 m, 1.5 m inside the edge)
          { kind: "canopy", ring: [[x, y], ...], z: 0.2, height: 9.5, rise: 3, columns: [[x, y], ...], name: "" }],

  // Houses at their real size. Either a prism (ring + heights) or a mesh; `faces` describes what the walls look like.
  buildings: [{ name: "", ring: [[x, y], ...], holes: [...], base: 0.2, eaves: 16.5, ridge: 21,
                roof: "flat" | "gabled" | "hipped" | "mansard", ridgeDir: 75,   // ridgeDir: bearing of the ridge line
                mesh: { positions: [x, y, z, ...], indices: [...] },            // optional: real geometry instead of the prism
                floors: 5, groundFloor: "shop" | "arcade" | "plain",
                color: "#d9d2c3", roofColor: "#8a6a55",
                faces: [{ a: [x, y], b: [x, y], bays: 7, floors: 5, groundFloor: "arcade", color: "#e3dccd" }] }],
}
```

Every field except `kind` and the position is optional: the renderer fills in sensible defaults, and data that is
not known is left out rather than invented. A `source` string on any item says where it comes from
(`"osm:node/123"`, `"baumkataster:4711"`, `"lidar"`, `"estimate"`).

## Renderer: `window.Station3DDetail`

```js
Station3DDetail.build(THREE, detail, { theme: "light" | "dark", toScene, palette, quality }) → { group, dispose(), stats }
```

- `toScene(x, y, z) → [X, Y, Z]`: the viewer's mapping from model coordinates to scene coordinates (the viewer is
  Y-up; without it the renderer uses `[x, z, -y]`).
- `palette`: colours to match the viewer's theme (ground, building, green …); the renderer has its own defaults in the
  Apple-Maps-like palette of the viewer.
- `group`: one `THREE.Group`, few draw calls (instancing, merged geometry), no textures loaded from the network.
- Things that move: `h.addVehicle({ kind: "tram", line: "9", path: [[x, y], ...] })` puts a tram on a track centre
  line (model coordinates, in driving direction) and returns `{ length, at, place(s), run({ from, to, seconds, ease }),
  doors(open), show(visible), remove() }`; `s`, `from` and `to` are metres along the path to the tram's front, `ease`
  is `"arrive"`, `"depart"` or `"linear"`, and `run` returns a promise. Call `h.tick(performance.now())` every frame
  and draw while it returns true. `h.tracks()` gives the centre lines of the scene's `tram-track` surfaces.
