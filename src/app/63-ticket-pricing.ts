const ticketQuotes = new WeakMap<OdConnection, Promise<TicketFare | null>>();
const ticketAmount = (amount: unknown): amount is number => typeof amount === 'number' && Number.isFinite(amount) && amount >= 0;
const ticketMoney = (amount: number) => `CHF ${Number.isInteger(amount) ? amount : amount.toFixed(2)}`;
async function matchFareConnection(sections: FareSection[], signal?: AbortSignal) {
  const first = sections[0], last = sections[sections.length - 1];
  const parts = swissTicketTime(first.departure.departure!);
  const params = new URLSearchParams({
    from: first.departure.station!.id!,
    to: last.arrival.station!.id!,
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
    limit: '5',
  });
  const response = await fetch(`${OPENDATA}connections?${params}`, { signal });
  if (!response.ok) return null;
  const { connections }: OdConnectionsResponse = await response.json();
  const sameStopTime = (a: OdCheckpoint, b: OdCheckpoint, field: 'departure' | 'arrival') => String(a.station?.id) === String(b.station?.id)
    && Date.parse(a[field]!) === Date.parse(b[field]!);
  const matches = (connections || []).filter((candidate) => {
    const rides = candidate.sections.filter((section) => section.journey);
    return rides.length === sections.length && rides.every((ride, i) =>
      sameStopTime(ride.departure, sections[i].departure, 'departure')
      && sameStopTime(ride.arrival, sections[i].arrival, 'arrival')
      && (!sections[i].journey.category || ride.journey?.category === sections[i].journey.category));
  });
  return matches.length === 1 ? matches[0] : null;
}

function quoteTicket(conn: OdConnection) {
  if (!ticketQuotes.has(conn)) {
    // Send only the data needed to price the exact rides, excluding access walks and app metadata.
    const checkpoint = (stop: OdCheckpoint, time: 'departure' | 'arrival') => ({ station: { id: stop.station?.id }, [time]: stop[time] });
    const engineCheckpoint = (call: KanteStopCall, field: 'departure' | 'arrival', clock: 'dep' | 'arr') => {
      const id = call.quay?.stationId;
      const time = call[clock];
      return {
        station: { id: KANTE?.uicOf(id) || id },
        [field]: Number.isFinite(time) ? new Date(time! * 1000).toISOString() : null,
      };
    };
    const sections: FareSection[] = conn.sections.filter((section): section is RideSection => !!section.journey).flatMap<FareSection>(({ departure, arrival, journey, kanteLegs }) => {
      if (kanteLegs && kanteLegs.length > 1) return kanteLegs.map((leg) => ({
        departure: engineCheckpoint(leg.from, 'departure', 'dep'),
        arrival: engineCheckpoint(leg.to, 'arrival', 'arr'),
        journey: { category: leg.line.category },
      }));
      return [{
        departure: checkpoint(departure, 'departure'),
        arrival: checkpoint(arrival, 'arrival'),
        journey: { category: journey.category, operator: journey.operator, number: journey.number, name: journey.name },
      }];
    });
    const request = (async () => {
      if (!sections.length || !sections.every(({ departure, arrival }) => departure.station?.id && arrival.station?.id
        && Number.isFinite(Date.parse(departure.departure!)) && Number.isFinite(Date.parse(arrival.arrival!)))) return null;
      const signal = AbortSignal.timeout?.(10000);
      // Kante uses operator names from its own feed. Resolve its exact ride times and stops
      // to the fare provider's connection before asking for a price.
      const connection = conn.kante ? await matchFareConnection(sections, signal) : { sections };
      if (!connection) return null;
      const response = await fetch(`${OPENDATA}fare`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(connection),
        signal,
      });
      if (!response.ok) return null;
      const data = await response.json();
      const second = data.currency === 'CHF' && data.fares?.['2nd'];
      if (!second || (!ticketAmount(second.full) && !ticketAmount(second.halfFare))) return null;
      return { fare: second.full, halfFare: second.halfFare };
    })().catch(() => null);
    ticketQuotes.set(conn, request);
  }
  return ticketQuotes.get(conn)!;
}

function ticketPricing(hasTicket: boolean) {
  const conn = journeyConn;
  const rides = journeySteps.filter((step) => step.type === 'ride').map((step) => step.s);
  const tracking = SETTINGS.prefs().fareTracking;
  if (!conn || !rides.length || (!tracking && !hasTicket)) return null;
  const trip = {
    from: rides[0].departure.station?.name ?? '',
    to: rides[rides.length - 1].arrival.station?.name ?? '',
    departure: rides[0].departure.departure,
    rides: rides.map((ride) => [
      lineLabel(ride.journey), ride.departure.station?.name ?? '', ride.arrival.station?.name ?? '', ride.departure.departure,
    ]),
  };
  let quote: TicketFare | null = null;
  const fare = h('input'), halfFare = h('input');
  const fullField = h('label', null, 'Full fare (CHF)', fare);
  const reducedField = h('label', null, 'Half Fare (CHF)', halfFare);
  const edited = new Set<HTMLInputElement>();
  const submit = h('button', 'pill-btn ticket-fare-save');
  submit.type = 'submit';
  for (const input of [fare, halfFare]) {
    input.type = 'number';
    input.inputMode = 'decimal';
    input.min = '0';
    input.step = '0.01';
    input.addEventListener('input', () => edited.add(input));
  }
  const summary = h('span', 'ticket-fare-summary');
  summary.id = 'journeyFareSummary';
  const detail = h('p', 'ticket-fare-context');
  function showFare() {
    const saved = tracking ? PRICING_HISTORY.findConfirmed(trip) : null;
    submit.textContent = saved ? 'Save fares' : 'Confirm trip';
    for (const [input, field] of [[fare, 'fare'], [halfFare, 'halfFare']] as const) {
      const value = saved ? saved[field] : quote?.[field];
      if (!edited.has(input)) input.value = ticketAmount(value) ? value.toFixed(2) : '';
    }
    const previous = tracking ? PRICING_HISTORY.routeFare(trip.from, trip.to) : null;
    const reduced = PRICING_HISTORY.profile().hasHalfFare === true;
    fullField.hidden = fare.disabled = reduced;
    reducedField.hidden = halfFare.disabled = !reduced;
    const field = reduced ? 'halfFare' : 'fare';
    const rate = reduced ? 'Half Fare' : 'Full fare';
    const live = ticketAmount(quote?.[field]);
    const amount = live ? quote?.[field] : previous?.[field];
    const priceKnown = ticketAmount(amount);
    const caption = live ? '2nd class' : 'Saved price';
    summary.replaceChildren(...(priceKnown ? [
      h('span', 'ticket-fare-price', ticketMoney(amount)),
      h('span', 'ticket-fare-rate', rate, h('span', live ? 'ticket-fare-class' : null, ' · ' + caption)),
    ] : tracking ? [hasTicket ? 'Check fare on SBB' : 'Trip fares'] : [])); // no fare known: the ticket button is enough
    summary.title = live ? 'Standard second-class fare' : '';
    detail.textContent = live ? 'If you paid a different price, enter it here.'
      : priceKnown ? `Saved on ${previous?.date}. Enter the price for this trip.`
        : 'Enter the price you paid, if known.';
  }
  showFare();
  const pendingQuote = hasTicket ? quoteTicket(conn) : Promise.resolve(null);
  pendingQuote.then((result) => {
    quote = result;
    if (result && summary.isConnected) showFare();
  });
  if (!tracking) return { row: h('div', 'ticket-fare-row aside', summary), refresh: showFare };

  const form = h('form', 'ticket-fare-form', detail);
  form.id = 'journeyFareForm';
  form.hidden = true;
  const arrow = h('span', 'ticket-fare-chevron');
  arrow.setAttribute('aria-hidden', 'true');
  const toggle = kBtn('ticket-fare-row ticket-fare-toggle', 'Fare options', () => {
    form.hidden = !form.hidden;
    toggle.setAttribute('aria-expanded', String(!form.hidden));
  }, summary, arrow);
  toggle.setAttribute('aria-controls', form.id);
  toggle.setAttribute('aria-describedby', summary.id);
  toggle.setAttribute('aria-expanded', 'false');
  const status = h('p', 'ticket-fare-status');
  status.setAttribute('role', 'status');
  const suggestions = kBtn('ticket-fare-suggestions', null, () => {
    window.openFareSuggestions(suggestions);
  }, 'Fare suggestions');
  form.append(h('div', 'ticket-fare-fields', fullField, reducedField),
    h('div', 'ticket-fare-actions', submit, suggestions), status);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    submit.disabled = true;
    try {
      // A quick confirmation can precede the price response. Use the quote for
      // unanswered fields, while preserving every amount the rider entered.
      const saved = PRICING_HISTORY.findConfirmed(trip);
      const needsQuote = !saved && !quote && [fare, halfFare].some((input) => !input.value && !edited.has(input));
      if (needsQuote) status.textContent = 'Checking the fare…';
      const result = needsQuote ? await pendingQuote : quote;
      const amount = (input: HTMLInputElement, field: keyof TicketFare) => input.value || edited.has(input) || saved ? input.valueAsNumber : result?.[field];
      const outcome = PRICING_HISTORY.confirm({ ...trip, fare: amount(fare, 'fare'), halfFare: amount(halfFare, 'halfFare') });
      const messages = {
        saved: 'Trip saved to your trip history',
        duplicate: 'Trip already saved',
        updated: 'Saved fares updated',
        unavailable: 'Could not save this trip in the browser',
      };
      status.textContent = messages[outcome];
      if (outcome !== 'unavailable') {
        edited.clear();
        showFare();
      }
    } finally {
      submit.disabled = false;
    }
  });
  return { row: toggle, form, refresh: showFare };
}
