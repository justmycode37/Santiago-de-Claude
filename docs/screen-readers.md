# Screen readers: VoiceOver and TalkBack

The app is used on a phone. Blind people use a phone through its screen reader (VoiceOver on iPhone, TalkBack on Android). This page says what the app does for them, why it is built that way, and what it can't do.

## How the app talks

A screen reader reads what its user moves to, in their own voice, speed and language, and on a braille display if they have one. The app describes itself (this is a button, it is called "Start") and stays quiet.

The app speaks up by itself in only two ways:

- **It moves focus**, after something the user did: a journey opens, a dialog opens, a page closes.
- **It writes one sentence into a live region** when something happens that the user did not cause and can't see. There are two regions in `index.html`: `#srStatus` waits for the screen reader to finish, `#srAlert` interrupts. `A11Y.say()` in `src/a11y.ts` fills them.

The rules for those sentences:

- One sentence per real event. Never a countdown: "in 31 min, in 30 min" is noise.
- Only "get off", "platform changed", "off the route", "cancelled" and the like interrupt.
- Everything said is also on the page, to be read again at the user's pace.

**Read aloud** (Settings › Guidance) says the same sentences with the phone's own voice. It is for people who do not use a screen reader. It is off unless switched on, because it talks over a screen reader, ignores its voice and speed, and never reaches braille. A web page can't tell whether a screen reader is running, so this has to be a switch.

## What works without looking

| Task | How |
|---|---|
| Find a place, an address or a stop | Search. Results follow the search fields, each one is a button, and the number of results is announced. |
| Find a toilet, a pharmacy, drinking water | Search for the kind of place ("toilet"). The nearest are listed with their distance. |
| Find community events | Tap the empty destination field and pick **Events near you**, or search "events" ("free food events"). An event held on several dates is listed once, and its page offers the other dates. |
| Plan a journey | Pick a result. Focus moves to the journey sheet. With several journeys on offer, their number and the one on the map are announced, and each row of the list reads as one sentence. Picking one announces it, with what to do first. |
| Be guided | **Start** on a journey. From then on each new step and each change is said once. **Start** again says the current step once more. |
| Know where to stand | "Where to stand" in the journey gives platform, sector, side of the road and level in words. |
| Know which stop you are at | Menu › **Scan**. With location on, the nearest stop and its next departures are said in one sentence, without tapping anything. |

**Blind or low vision** (Settings › About you) also:

- opens journeys as a list instead of over the map,
- keeps the screen on during guidance,
- names tactile guidance and spoken information at the boarding point, and crossings with a sound signal on a walk, where these are mapped,
- narrows events down to those for blind and low-vision people.

## What is said during guidance

After **Start**, `guidePosition()` and `guideAlerts()` in `src/app/65-guidance.ts` turn the state of the trip into sentences. Each has a key, and a key is said once per journey.

| Event | Example | Interrupts |
|---|---|---|
| Walk to a stop | "Walk: 750 metres to Platform 2. IC 8 to Romanshorn leaves in 12 minutes." | no |
| At the boarding point | "You are at Bay C. Tram 9 to Wabern leaves in 4 minutes." | no |
| On board | "You are on Tram 9 towards Wabern. 5 stops to Bern, Bahnhof, arriving at 14:32." | no |
| Your stop is next, far away | "The next stop is Zürich HB, at 16:28. Get off there." | no |
| Your stop is next, close | "Next stop: Bern, Bahnhof. Get off there. Then change to IR 16 at Platform 12." | yes |
| Platform changed | "Platform change: IC 8 now leaves from platform 5, not 7." | yes |
| Delay of 3 minutes or more | "IC 8 is 5 minutes late. It now leaves at 14:55." | no |
| Cancelled, or a change that won't work | "IC 8 is cancelled. Replan finds another way." | yes |
| Off the route, or a missed ride | "You are off the route, about 270 metres away." | yes |
| Arrived | "You have arrived at Zytglogge." | no |

With GPS the position decides. Without it, the live timetable does, and the sentence says so ("By the timetable you are now on…"). A new position is only said once it has held for three seconds (ten for "off the route"), so one stray GPS fix says nothing.

Guidance is on while you are under way: from **Start** until the start or the destination is changed, or the journey is closed.

## Languages

The page is in English. Station, stop and street names are marked with the language spoken where they are (`lang="de"`, `"fr"`, `"it"`), so a screen reader says "Zürich Hauptbahnhof" with a German voice. `A11Y.placeLang()` decides by position, along a rough language border. Event titles and descriptions are marked by the words they use (`A11Y.textLang()`), and left alone when that is not clear.

Sentences in the live regions can't carry a language per word, so names inside them are read with the voice of the app's language.

**Another app language** (Settings › Language, `src/translate.ts`) translates the text on the screen through Google Translate. Announcements are translated before they are put into a live region, and the regions are marked `translate="no"`: put in English and translated afterwards, a sentence would be read out twice. If Google does not answer within 1.5 seconds, the sentence is said in English. Names keep `translate="no"` and their own language.

## Data for blind and low-vision travellers

| What | Source | Where |
|---|---|---|
| Tactile guide lines, tactile field at the boarding point, spoken announcements, departure display with speech | ATLAS accessibility data per stop edge (opentransportdata.swiss), via `data/bern-stop-accessibility.json` | `stop-access.js`, built by `node tools/build-stop-access.mjs` |
| Crossings with a sound signal | Stadt Bern, in `map-places.js` | counted within 12 m of a walk (`src/app/63-access-data.ts`) |

Both cover Bern only. The app says what is mapped and claims nothing where nothing is: no sentence means "not known", never "none".

## Limits

- **Phone in the pocket.** A browser stops a page whose screen is off or that is in the background. Guidance works while the app is open and the screen is on. In the blind or low-vision mode the app asks the phone to keep the screen on.
- **Turn-by-turn on foot.** Walking directions are a list to read. They are not spoken as you walk: phone GPS is not accurate enough between buildings to say "turn left now" reliably.
- **Aiming the camera.** Scan reads signs by itself every few seconds, but it gives no sound or vibration to help aim. With location on that matters less: the nearest stop is named without the camera.
- **Vibration** exists on Android only. iOS Safari has none, and the switch is hidden there.
- **The map** itself is a picture. Everything on it that matters is reachable through search, the journey sheet or Scan.

## Rebuilding the data

```bash
node tools/build-stop-access.mjs    # stop-access.js from data/bern-stop-accessibility.json
```

## Testing

```bash
npm test                            # includes tools/test_a11y.mjs: the language helpers
node tools/test_screen_reader.mjs   # the app in headless Chrome: roles, names, focus, announcements
```

The browser test builds `dist/` and serves it. It needs Chrome or Chromium and the internet, and takes a few minutes.

The browser test drives the real app through search, events, a journey, guidance with a simulated GPS position, the blind or low-vision mode and Scan. It checks what the app hands to a screen reader. It does not replace trying a change with VoiceOver and TalkBack on a phone.

When you change the journey sheet (`src/app/62-sheet-content.ts`): it is redrawn often, and a screen reader loses its place when the element it is on is replaced. `patch()` swaps in only the parts that changed and `keepFocus()` puts focus back on a replaced button. Keep using them, and keep markup that looks the same doing the same, because a part that is kept keeps its click handlers.
