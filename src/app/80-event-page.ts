// ---------- Event page (URL: #event/<id>, so the back gesture/button works) ----------
const evPage = document.getElementById('evPage')!;
const evHero = document.getElementById('evHero')!;
const evContent = document.getElementById('evContent')!;
let pageEvent: EventFeature | null = null;
let pushedHash = false;

const findEvent = (id: string) => EVENTS.features.find((f) => f.properties.id === id);

function openEvent(id: string) {
  pushedHash = true;
  location.hash = 'event/' + encodeURIComponent(id);
}

let eventsAtPin: EventFeature[] = [];
let eventBack: (() => HTMLElement | null) | null = null; // → the card or the search result an event was opened from, for the way back
const related = document.getElementById('evRelated') as HTMLSelectElement;
related.addEventListener('change', () => {
  history.replaceState(null, '', '#event/' + encodeURIComponent(related.value));
  routeFromHash();
});

function renderEventPage(f: EventFeature) {
  const p = f.properties;
  pageEvent = f;
  const choices = eventsAtPin.includes(f) ? eventsAtPin : [];
  related.replaceChildren();
  related.parentElement!.hidden = choices.length < 2;
  if (choices.length > 1) {
    for (const { properties } of choices) {
      related.add(new Option(properties.title + ' · ' + properties.when, properties.id));
    }
    related.value = p.id;
  }
  evHero.style.setProperty('--c', p.color);
  evHero.style.setProperty('--cf', p.ink || '');
  evContent.style.setProperty('--c', p.color);
  [...evHero.children].forEach((n) => { if (n.id !== 'evBack') n.remove(); });
  evHero.insertAdjacentHTML('beforeend', `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${EVENTS.GLYPHS[p.cat]}"/></svg>`);
  if (p.image) {
    const img = document.createElement('img');
    img.src = p.image;
    img.alt = '';
    img.onerror = () => img.remove();
    evHero.appendChild(img);
  }
  // Titles are often German (or French) and the descriptions English: while the app is in English each is
  // marked with its own language, so a screen reader reads each with the right voice. (In another app language
  // these texts are translated, and read in that language.) The venue and town are names: they stay as they are.
  const fill = (id: string, text: string) => A11Y.inLang(Object.assign(document.getElementById(id)!, { textContent: text }), A11Y.textLang(text));
  document.getElementById('evCat')!.textContent = p.category;
  fill('evTitle', p.title);
  // (dates, prices and how to register are a few words with numbers and addresses: no language is read from them)
  for (const [id, text] of [['evWhen', p.when], ['evCost', p.cost], ['evAttendance', p.attendance]]) A11Y.setLang(Object.assign(document.getElementById(id)!, { textContent: text }), '');
  (document.getElementById('evOrganizer') as HTMLAnchorElement).href = p.url;
  const venue = document.getElementById('evVenue')!, city = document.getElementById('evCity')!;
  venue.textContent = p.venue;
  city.textContent = p.city;
  if (/confirm meeting point/i.test(p.venue || '')) { venue.removeAttribute('lang'); venue.removeAttribute('translate'); } // a sentence, not a name
  else named(venue, f.geometry.coordinates);
  named(city, f.geometry.coordinates);
  fill('evAbout', p.about);
  fill('evAudience', p.audience);
  evPage.scrollTop = 0;
}

const eventJourneyButton = document.getElementById('evShowJourney') as HTMLButtonElement;
const eventJourneyStatus = document.getElementById('evJourneyStatus')!;
let eventLocationRequest = 0;

function routeFromHash() {
  eventLocationRequest++;
  eventJourneyButton.disabled = false;
  eventJourneyStatus.textContent = '';
  const m = location.hash.match(/^#event\/(.+)$/);
  const f = m && findEvent(decodeURIComponent(m[1]));
  if (f) {
    renderEventPage(f);
    blurSearch();
    setMenu(false);
    evPage.classList.add('open');
    evPage.setAttribute('aria-hidden', 'false');
    // a page of its own: what is behind it is out of reach, and Back returns to where you came from
    A11Y.openDialog(evPage, { focus: document.getElementById('evBack'), returnTo: () => (eventBack ? eventBack() : null) });
    document.getElementById('evBack')!.focus({ preventScroll: true }); // also when another event is chosen on the open page
  } else {
    if (evPage.classList.contains('open')) {
      evPage.classList.remove('open');
      evPage.setAttribute('aria-hidden', 'true');
      A11Y.closeDialog(evPage, { fallback: document.body.classList.contains('journey-mode') ? journeyEl : menuBtn });
      eventBack = null;
    }
    evPage.inert = true;
  }
}
evPage.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeEvent(); });

function closeEvent() {
  if (pushedHash) { pushedHash = false; history.back(); }
  else history.replaceState(null, '', location.pathname + location.search);
  routeFromHash();
}

window.addEventListener('hashchange', () => { if (!location.hash) pushedHash = false; routeFromHash(); });
document.getElementById('evBack')!.addEventListener('click', closeEvent);
eventJourneyButton.addEventListener('click', () => {
  const event = pageEvent;
  if (!event) return;
  if (!window.isSecureContext || !navigator.geolocation) {
    eventJourneyStatus.textContent = 'Location is unavailable. Open this page over HTTPS in a browser with location access.';
    return;
  }
  const request = ++eventLocationRequest;
  eventJourneyButton.disabled = true;
  eventJourneyStatus.textContent = 'Finding your current location…';
  navigator.geolocation.getCurrentPosition(position => {
    if (request !== eventLocationRequest) return;
    eventJourneyButton.disabled = false;
    if (!inSwitzerland([position.coords.longitude, position.coords.latitude])) {
      eventJourneyStatus.textContent = 'Journeys are available from locations in Switzerland.';
      return;
    }
    onPosition(position);
    const destination = event.properties.areaOnly
      ? event.properties.title + ' (' + event.properties.city + ' area)'
      : event.properties.title;
    pushedHash = false;
    history.replaceState(null, '', location.pathname + location.search);
    routeFromHash();
    showDestinationJourney({ title: destination, lngLat: event.geometry.coordinates });
  }, error => {
    if (request !== eventLocationRequest) return;
    eventJourneyButton.disabled = false;
    eventJourneyStatus.textContent = error.code === 1
      ? 'Allow location access in your browser, then tap Show journey again.'
      : 'Your location could not be found. Tap Show journey to try again.';
  }, { enableHighAccuracy: true, maximumAge: 30000, timeout: 15000 });
});
routeFromHash(); // a shared #event/… link opens straight on the page
