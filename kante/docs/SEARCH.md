# Search (`/api/search`)

`GET /api/search?q=&lat=&lon=&limit=` searches one index (`kante-search`, built into `data/built/search.bin`)
for stations and stops, streets and house numbers, and places from OpenStreetMap. A place can be a town, a
restaurant, a shop, a museum, a mountain or something similar. `lat`/`lon` rank nearer results first among equal matches; `limit` is 1–30
(default 10). How matching and ranking work is described at the top of `engine/crates/search/src/lib.rs`.

## Finding places

- **By name**: "Einstein", "Migros", "Zytglogge". Alternative names, short names and names in other
  languages count too.
- **By kind**: "restaurant", "Apotheke", "Glace", "Baumarkt". Every category also answers to the words people
  type for it in German, French, Italian and English (`cats::keywords`).
- **By what it serves**: "pizza", "sushi", "thai", "kebab", "vegan". These come from the `cuisine` and `diet:*`
  tags, with the common cuisines also in other languages: "italienisch", "japanisch", "pizzeria"
  (`cats::cuisine_keywords`).
- Kind and cuisine words count only when typed (nearly) in full, so "pi" does not list every pizzeria. They
  combine with a town: "pizza zürich", "apotheke thun".
- A business that has a website, opening hours or a photo on OpenStreetMap ranks slightly above a bare name. A
  Wikidata link ranks it higher still. This stands in for ratings, which OpenStreetMap does not have.

## What a result carries

```jsonc
{
  "id": "poi:3299207088", "kind": "poi", "name": "Cavallo Star",
  "detail": "Restaurant · Bubenbergplatz 8, Bern",
  "lat": 46.9475754, "lon": 7.4382717, "distM": 149,
  "icon": "restaurant",          // what to draw (below)
  "category": "Restaurant",      // places: the first part of `detail`
  "info": {                      // places: only what is mapped; left out when nothing is
    "cuisine": "Italian, Pizza",
    "diet": "Vegan options, Vegetarian options",
    "openingHours": "Mo-Sa 08:30-23:00; Su 10:00-22:00",   // OpenStreetMap's opening_hours, as mapped
    "website": "https://www.cavallostar.ch/",
    "phone": "+41 31 3117679",
    "image": "https://commons.wikimedia.org/wiki/Special:FilePath/….jpg?width=400",
    "wikidata": "Q246105",       // its photo is property P18 there, when `image` is missing
    "brandWikidata": "Q680727",  // its brand's logo is property P154 there (Migros, Coop …)
    "stars": "4"                 // hotels
  }
}
```

`image` is a Wikimedia Commons file (`image=File:…`, `wikimedia_commons=File:…` or a Commons page URL), scaled to
400 px, or a direct `https` link to a `.jpg`/`.png`/`.webp`. Links to pages that only show a picture (Flickr,
Mapillary, a Commons category) are left out. The engine does not call Wikidata. The app looks up the
`wikidata` photo, or else the `brandWikidata` logo, after it shows the list (`fillPhotos` in
`src/app/search-places.ts`).

### Icon keys

`station`, `address`, and for places:

| Key | For |
|---|---|
| `restaurant`, `fast_food`, `cafe`, `bar`, `ice_cream`, `bakery` | food and drink |
| `grocery`, `mall`, `shop`, `hairdresser` | shops |
| `pharmacy`, `hospital`, `doctor`, `dentist` | health |
| `hotel`, `hut`, `camping` | places to stay |
| `museum`, `theatre`, `zoo`, `castle`, `sight`, `viewpoint` | culture and sights |
| `worship`, `school`, `library`, `civic`, `police`, `post`, `bank`, `office`, `info` | services |
| `parking`, `car`, `bike`, `taxi`, `airport` | getting around |
| `sport`, `swim`, `park` | sport and leisure |
| `city`, `village`, `mountain`, `water`, `nature` | towns and landscape |
| `place` | anything else |

New keys may be added; a client should draw an unknown key as `place`.

## Rebuilding

The index format is `search-v2`. `kante build` rebuilds `search.bin` when it finds an older one (a few seconds
with the Swiss extract), and the hosted engine does so on its next deploy. Until then the server answers from
stations only.
