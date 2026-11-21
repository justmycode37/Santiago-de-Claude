// Tests for the pure helpers in src/a11y.ts: which language a text is in, and which language is spoken where.
//   node tools/test_a11y.mjs
import { createRequire } from 'node:module';
const A = createRequire(import.meta.url)('../src/a11y.ts');
let failed = 0;
const eq = (what, got, want) => { if (got !== want) { failed++; console.log(`FAIL ${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); } };

// Texts: only a clear answer is given ('' = leave it in the page's language). It takes two hits and a clear
// lead: a wrong voice is worse than the page's own.
for (const [text, lang] of [
  ['Chor für Menschen mit und ohne Demenz', 'de'],
  ['Schenk mir eine Geschichte auf Albanisch', 'de'],
  ['Offene Beratung für Migrantinnen', 'de'],
  ['Volunteers help you read German letters, understand forms and write applications.', 'en'],
  ['Café des langues pour les nouveaux arrivants', 'fr'],
  ['Corso di italiano per principianti', 'it'],
  // one hit, or none, is not enough
  ['Schreibdienst', ''],
  ['Free dinner at Speak-Out', ''],
  ['Yoga', ''],
  ['Berner Generationenhaus, Bahnhofplatz 2, 3011 Bern', ''],
  ['', ''],
  // codes, short forms and addresses that look like a word of another language (all from the app's own events)
  ['Alpha lecture 1 - AL0051', ''],
  ['Alpha francophone - AL 006', ''],
  ['Di. 17.30-18.30', ''],
  ['CHF 2 per visit', ''],
  ['Schwimmen Kinder Obere Au · BTV Behindertensport Chur', ''],
  ['Natation adultes, Non-nageurs · PluSport Sport Handicap Yverdon', ''],
  ['Register via gesellschaft@gl.ch', ''],
]) eq(`textLang(${text})`, A.textLang(text), lang);

// Places: along the language border, and outside Switzerland
for (const [name, ll, lang] of [
  ['Bern', [7.44, 46.948], 'de'], ['Zürich', [8.54, 47.378], 'de'], ['Basel', [7.59, 47.55], 'de'], ['Chur', [9.53, 46.85], 'de'],
  ['Biel/Bienne', [7.25, 47.14], 'de'], ['Murten', [7.12, 46.93], 'de'], ['Grenchen', [7.39, 47.19], 'de'], ['Laufen', [7.5, 47.42], 'de'],
  ['Gstaad', [7.286, 46.47], 'de'], ['Visp', [7.88, 46.29], 'de'], ['Zermatt', [7.75, 46.02], 'de'], ['Andermatt', [8.59, 46.63], 'de'],
  ['St. Moritz', [9.84, 46.49], 'de'],
  ['Genève', [6.14, 46.21], 'fr'], ['Lausanne', [6.63, 46.52], 'fr'], ['Neuchâtel', [6.93, 46.99], 'fr'], ['Fribourg', [7.151, 46.803], 'fr'],
  ['Delémont', [7.34, 47.36], 'fr'], ['Moutier', [7.37, 47.28], 'fr'], ['Sion', [7.36, 46.23], 'fr'], ['Sierre', [7.53, 46.29], 'fr'],
  ['Lugano', [8.95, 46.0], 'it'], ['Bellinzona', [9.03, 46.19], 'it'], ['Airolo', [8.61, 46.53], 'it'], ['Mesocco', [9.23, 46.39], 'it'],
  ['Poschiavo', [10.06, 46.32], 'it'],
  ['Paris', [2.35, 48.85], ''], ['nowhere', null, ''],
]) eq(`placeLang(${name})`, A.placeLang(ll), lang);

eq('minutes(1)', A.minutes(1), '1 minute');
eq('minutes(12)', A.minutes(12), '12 minutes');
eq('metres(748)', A.metres(748), '750 metres');
eq('metres(4)', A.metres(4), '10 metres');
eq('metres(1240)', A.metres(1240), '1.2 kilometres');

console.log(failed ? `${failed} failed` : 'a11y.js: all tests passed');
process.exit(failed ? 1 : 0);
