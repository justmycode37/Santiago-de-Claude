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
const related = document.getElementById('evRelated') as HTMLSelectElement;
related.addEventListener('change', () => {
  history.replaceState(null, '', '#event/' + encodeURIComponent(related.value));
  routeFromHash();
});

function renderEventPage(f: EventFeature) {
  const p = f.properties;
  pageEvent = f;
  // every event at this pin, soonest end first: the list is the only way to reach the others
  const end = (e: EventFeature) => (e.properties.through ? Date.parse(e.properties.through) : Infinity);
  const choices = eventsAtPin.includes(f) ? eventsAtPin.slice().sort((a, b) => (end(a) - end(b)) || 0) : [];
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
  document.getElementById('evCat')!.textContent = p.category;
  document.getElementById('evTitle')!.textContent = p.title;
  document.getElementById('evWhen')!.textContent = p.when;
  document.getElementById('evCost')!.textContent = p.cost;
  document.getElementById('evAttendance')!.textContent = p.attendance;
  (document.getElementById('evOrganizer') as HTMLAnchorElement).href = p.url;
  document.getElementById('evVenue')!.textContent = p.venue;
  document.getElementById('evCity')!.textContent = p.venue.toLowerCase().includes(p.city.toLowerCase()) ? '' : p.city;
  document.getElementById('evAbout')!.textContent = p.about;
  document.getElementById('evAudience')!.textContent = p.audience;
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
    document.getElementById('evBack')!.focus();
  } else {
    evPage.classList.remove('open');
    evPage.setAttribute('aria-hidden', 'true');
  }
}

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
    eventJourneyStatus.textContent = !window.isSecureContext ? 'Open this page over HTTPS to use your location.' : 'This browser can’t share your location.';
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
