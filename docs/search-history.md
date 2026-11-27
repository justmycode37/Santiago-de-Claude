# Search history and remembered options

The app remembers what you search for, and a few choices you made last time, on the device only (localStorage).
Nothing is sent anywhere. Every read and write is guarded: with storage blocked or full, the search works as
before and simply remembers nothing.

## What you see

- **Empty search box**: "Recent" (the last 4) and "Frequent" (up to 3 more, those used more than once lately),
  above the categories. A tap opens the entry again: a place becomes that end of the trip, a category puts its
  places on the map, a trip plans both ends at once, leaving now. × forgets one entry; "Clear" (tapped twice)
  forgets all of them.
- **Where the trip starts** ("From") lists places only. Categories are offered only while no trip is on show
  (their places are not on the map during one).
- **While typing**: up to 2 of your entries the text matches (every typed word starts a word of the name, accents
  ignored) show with a clock above the results, unless the list already has them (the place among the results,
  the category the text names). Not a trip once you have picked a start: it would replace it. Enter opens the
  history row on top, the one drawn there; Enter works because the form has a hidden submit button (with two
  fields, HTML submits on Enter only through one).
- **Settings › Search history**: "Remember searches" (on by default) and "Clear search history". Off: nothing new is
  kept and the search shows none of it; what is kept stays until it is cleared. Another open tab follows the
  switch.

## What is kept

`search-history-v1` holds at most 40 entries, each with when it was last used and how much:

| Entry | Data |
| --- | --- |
| a place you picked from the search (also from its pins or a category's cards) | name, the grey line without distance, rating and "Open/Closed", its kind (for the icon), where the result came from, coordinates to ~1 m, the Kante engine's id if it has one |
| a category you opened | its key and name (a category named by a typed word, e.g. "dentist": also the words) |
| a trip | its two ends as above, when both are places you searched for (not your location, the map centre or a dropped pin) |

No icons (they are drawn from the kind), no photos, no times, no positions of yours. The same place from two
sources is one entry: the same engine id, or the same name within 150 m (addresses: 30 m) when one has no id.

## Ranking

Each use adds 1 to an entry's score, and the score halves every 30 days (`s · 0.5^(age / 30 days)`, worked out
when read). Picking the same thing again within 15 minutes only makes it recent (the score fades on). A trip or
place picked again from a source without the engine's id keeps the id it had. "Frequent" needs a score of 1.5:
two uses stay frequent for about 12 days, three for about a month. When there are more than 40 entries, the
lowest score goes, but never one of the 8 newest, so a run of new searches cannot be pushed out by old favourites.

## Remembered options

Settings already keep every journey preference (accessibility, walking speed, changes, transport types, map
layers, the satellite view). In addition:

- **Depart at / Arrive by**: the time sheet, opened from the "Leave now" chip, starts on the mode you last planned
  with (`timeMode`, a key of its own: writing the settings would save this tab's copy of all of them; "Now" sets
  it back to departing, "Reset all settings" removes it). Only the mode: a date or time from last time would be
  out of date.
- **Events and places** (the button in the menu): on again at the next visit if it was on (`eventsOn`), once the
  map has drawn.

Not remembered on purpose: the departure time itself, the public transport / walk tab (it follows the best
journey of each trip), and the category on the map (opening the app on a category you looked at yesterday would
be a surprise; it is under "Recent" instead).

## Code

- `src/search-history.ts`: storage, validation, ranking. Does nothing as it loads; `settings.ts` hands it the
  switch (`rememberWhen`). Tests: `tools/test_search_history.mts` (in `npm test`).
- `src/app/search-history-ui.ts`: the rows, and the `remember…` calls. Its hooks elsewhere are one line each:
  `render()` in `search-pins.ts` (empty and typed), `choose()`, `swapEnds()` and the form's Enter in
  `trip-ends.ts`, `enterCategory()` in `categories.ts`.
