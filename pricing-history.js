(function () {
  const KEY = 'pricing-trip-history-v1';
  const PROFILE_KEY = 'pricing-profile-v1';
  const swissDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit',
  });

  function dateKey(date) {
    const fields = Object.fromEntries(swissDate.formatToParts(date).map(({ type, value }) => [type, value]));
    return `${fields.year}-${fields.month}-${fields.day}`;
  }
  const fareValue = (value) => Number.isFinite(value) && value >= 0 ? value : null;

  function cleanProfile(value = {}) {
    const result = {};
    if (Number.isInteger(value.age) && value.age >= 16 && value.age <= 130) result.age = value.age;
    if (Number.isInteger(value.months) && value.months >= 1 && value.months <= 12) result.months = value.months;
    if (Number.isInteger(value.groupSize) && value.groupSize >= 1 && value.groupSize <= 4) result.groupSize = value.groupSize;
    for (const field of ['hasHalfFare', 'covered', 'allUnder25', 'seniorEligibility']) {
      if (typeof value[field] === 'boolean') result[field] = value[field];
    }
    const full = fareValue(value.saver?.full);
    const half = fareValue(value.saver?.half);
    if (full > 0 || half > 0) result.saver = { full: full > 0 ? full : null, half: half > 0 ? half : null };
    return result;
  }

  function profile() {
    try {
      return cleanProfile(JSON.parse(localStorage.getItem(PROFILE_KEY)) ?? {});
    } catch {
      return {};
    }
  }

  function setProfile(patch) {
    if (window.SETTINGS?.prefs().fareTracking !== true || !patch || typeof patch !== 'object') return false;
    return saveProfile(patch);
  }

  function setHalfFare(confirmed) {
    return typeof confirmed === 'boolean' && saveProfile({ hasHalfFare: confirmed });
  }

  function saveProfile(patch) {
    try {
      const existing = profile();
      const next = cleanProfile({ ...existing, ...patch });
      if (Object.keys(next).length) localStorage.setItem(PROFILE_KEY, JSON.stringify(next));
      else localStorage.removeItem(PROFILE_KEY);
      return true;
    } catch {
      return false;
    }
  }

  function list() {
    try {
      const trips = JSON.parse(localStorage.getItem(KEY));
      if (Array.isArray(trips)) {
        return trips.filter((trip) => trip && trip.confirmed !== false && typeof trip.id === 'string'
          && typeof trip.from === 'string' && typeof trip.to === 'string'
          && typeof trip.date === 'string').map((trip) => {
          if (trip.departure) return trip;
          // The original trip key included the departure before it was saved separately.
          try {
            const departure = JSON.parse(trip.id)[2];
            if (Number.isFinite(Date.parse(departure))) return { ...trip, departure };
          } catch { /* A date-only record can still be used. */ }
          return trip;
        });
      }
    } catch { /* The browser may block access to local storage. */ }
    return [];
  }

  function save(trips) {
    try {
      if (trips.length) localStorage.setItem(KEY, JSON.stringify(trips));
      else localStorage.removeItem(KEY);
      return true;
    } catch {
      return false;
    }
  }

  function tripId({ from, to, departure, rides }) {
    if (typeof from !== 'string' || !from.trim() || typeof to !== 'string' || !to.trim()
      || departure == null || !Array.isArray(rides) || !rides.length) return null;
    const date = new Date(departure);
    return Number.isFinite(date.getTime()) ? JSON.stringify([from, to, date.toISOString(), rides]) : null;
  }

  function findConfirmed(trip) {
    if (!window.SETTINGS?.prefs().fareTracking) return null;
    const id = tripId(trip);
    return list().find((item) => item.id === id) || null;
  }

  function confirm(trip = {}) {
    if (!window.SETTINGS?.prefs().fareTracking) return 'unavailable';
    const id = tripId(trip);
    if (!id) return 'unavailable';
    const trips = list();
    const existing = trips.find((item) => item.id === id);
    const fare = fareValue(trip.fare);
    const halfFare = fareValue(trip.halfFare);
    if (existing) {
      if (existing.fare === fare && existing.halfFare === halfFare) return 'duplicate';
      existing.fare = fare;
      existing.halfFare = halfFare;
      return save(trips) ? 'updated' : 'unavailable';
    }
    const date = dateKey(new Date(trip.departure));
    const departure = new Date(trip.departure).toISOString();
    return save([{ id, from: trip.from, to: trip.to, date, departure, fare, halfFare }, ...trips]) ? 'saved' : 'unavailable';
  }

  function routeFare(from, to) {
    if (typeof from !== 'string' || typeof to !== 'string') return null;
    const routeKey = (name) => name.trim().normalize().toLocaleLowerCase('de-CH');
    if (window.SETTINGS?.prefs().fareTracking !== true) return null;
    const today = dateKey(new Date());
    const origin = routeKey(from);
    const destination = routeKey(to);
    let best = null;
    let bestDeparture = -Infinity;
    for (const trip of list()) {
      if (trip.date > today || Date.parse(trip.departure) > Date.now()) continue;
      if (routeKey(trip.from) !== origin || routeKey(trip.to) !== destination) continue;
      const departure = Date.parse(trip.departure);
      const departureTime = Number.isFinite(departure) ? departure : -Infinity;
      if (best && (best.date > trip.date || (best.date === trip.date && bestDeparture >= departureTime))) continue;
      const fare = fareValue(trip.fare);
      const halfFare = fareValue(trip.halfFare);
      if (fare !== null || halfFare !== null) {
        best = { fare, halfFare, date: trip.date };
        bestDeparture = departureTime;
      }
    }
    return best;
  }

  // Developer options: weekday Bern ↔ Zürich commutes on the past four weeks, marked dummy so they can be removed again
  function dummyTrips() {
    const trips = [];
    for (let back = 1; back <= 28; back++) {
      const day = new Date();
      day.setDate(day.getDate() - back);
      if (day.getDay() === 0 || day.getDay() === 6) continue;
      for (const [hour, from, to] of [[17, 'Zürich HB', 'Bern'], [7, 'Bern', 'Zürich HB']]) {
        day.setHours(hour, 32, 0, 0);
        const departure = day.toISOString();
        trips.push({ id: JSON.stringify([from, to, departure, [['dummy']]]), from, to,
          date: dateKey(day), departure, fare: 56, halfFare: 28, dummy: true });
      }
    }
    return trips;
  }

  function setDummy(on) {
    const own = list().filter((trip) => !trip.dummy);
    const trips = on ? [...own, ...dummyTrips()] : own;
    return save(trips.sort((a, b) => String(b.departure).localeCompare(String(a.departure))));
  }

  window.PRICING_HISTORY = {
    setDummy,
    hasDummy: () => list().some((trip) => trip.dummy),
    list,
    dateKey,
    confirm,
    findConfirmed,
    profile,
    setProfile,
    setHalfFare,
    routeFare,
    update(id, { fare, halfFare }) {
      if (window.SETTINGS?.prefs().fareTracking !== true) return false;
      const trips = list();
      if (!trips.some((trip) => trip.id === id)) return false;
      return save(trips.map((trip) => trip.id === id
        ? { ...trip, fare: fareValue(fare), halfFare: fareValue(halfFare) } : trip));
    },
    remove: (id) => save(list().filter((trip) => trip.id !== id)),
    clear: () => save([]),
  };
})();
