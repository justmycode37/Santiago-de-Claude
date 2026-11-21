(function () {
  const KEY = 'pricing-trip-history-v1';
  const swissDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit',
  });

  function dateKey(date) {
    const fields = Object.fromEntries(swissDate.formatToParts(date).map(({ type, value }) => [type, value]));
    return `${fields.year}-${fields.month}-${fields.day}`;
  }
  const fareValue = (value) => Number.isFinite(value) && value >= 0 ? value : null;

  function list() {
    try {
      const trips = JSON.parse(localStorage.getItem(KEY));
      if (Array.isArray(trips)) {
        return trips.filter((trip) => trip && typeof trip.id === 'string'
          && typeof trip.from === 'string' && typeof trip.to === 'string'
          && typeof trip.date === 'string');
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

  function confirm({ from, to, departure, rides }) {
    const date = new Date(departure);
    if (!from || !to || !rides.length || !Number.isFinite(date.getTime())) return 'unavailable';
    const id = JSON.stringify([from, to, date.toISOString(), rides]);
    const trips = list();
    if (trips.some((trip) => trip.id === id)) return 'duplicate';
    const localDate = dateKey(date);
    return save([{ id, from, to, date: localDate, fare: null, halfFare: null }, ...trips])
      ? 'saved' : 'unavailable';
  }

  window.PRICING_HISTORY = {
    list,
    dateKey,
    confirm,
    update(id, { fare, halfFare }) {
      return save(list().map((trip) => trip.id === id
        ? { ...trip, fare: fareValue(fare), halfFare: fareValue(halfFare) } : trip));
    },
    remove: (id) => save(list().filter((trip) => trip.id !== id)),
    clear: () => save([]),
  };
})();
