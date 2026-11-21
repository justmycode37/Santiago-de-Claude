import { recommendFares } from './pricing-engine.js';

const chf = new Intl.NumberFormat('en-CH', { style: 'currency', currency: 'CHF' });
const number = (input) => input.value === '' ? null : input.valueAsNumber;

function el(tag, text) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  return element;
}

function link(text, url) {
  const element = el('a', text);
  element.href = url;
  element.target = '_blank';
  element.rel = 'noopener noreferrer';
  return element;
}

function recentTravelDays(trips, dateKey, now) {
  const today = dateKey(now);
  const start = new Date(today + 'T12:00:00Z');
  start.setUTCDate(start.getUTCDate() - 29);
  const cutoff = dateKey(start);
  const byDate = new Map();
  for (const trip of trips) {
    if (trip.date < cutoff || trip.date > today) continue;
    if (!byDate.has(trip.date)) byDate.set(trip.date, []);
    byDate.get(trip.date).push(trip);
  }
  const fullyPriced = [...byDate.values()].filter((day) => day.every((trip) => Number.isFinite(trip.fare)));
  const days = fullyPriced.map((day) => ({
    fare: day.reduce((sum, trip) => sum + trip.fare, 0),
    halfFare: day.reduce((sum, trip) => sum + (trip.halfFare ?? trip.fare / 2), 0),
    estimatedHalfFare: day.some((trip) => !Number.isFinite(trip.halfFare)),
  }));
  return { days, incomplete: byDate.size - days.length };
}

function fareInput(text, value) {
  const label = el('label', text);
  const input = el('input');
  input.type = 'number';
  input.min = '0';
  input.step = '0.01';
  input.inputMode = 'decimal';
  if (Number.isFinite(value)) input.value = String(value);
  label.append(input);
  return { label, input };
}

export function mountPricing(container, history) {
  container.classList.add('pricing-panel');
  container.innerHTML = `
    <style>
      .pricing-panel { display:grid; gap:12px; line-height:1.4; }
      .pricing-panel h3,.pricing-panel p,.pricing-panel ul { margin:0; }
      .pricing-panel a { color:inherit; text-decoration:underline; }
      .pricing-panel form,.pricing-panel fieldset,.pricing-panel [data-trips],
      .pricing-panel [data-results] { display:grid; gap:10px; min-width:0; }
      .pricing-panel [data-trips] form,.pricing-panel fieldset {
        padding:10px; border:1px solid currentColor; border-radius:10px;
      }
      .pricing-panel .pricing-fields { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; }
      .pricing-panel label { display:block; }
      .pricing-panel input[type=number] {
        display:block; width:100%; box-sizing:border-box; border:1px solid currentColor;
        color:inherit; background:transparent; padding:6px; border-radius:6px; font:inherit;
      }
      .pricing-panel button {
        color:inherit; background:transparent; border:1px solid currentColor; border-radius:8px;
        font:inherit; padding:6px 10px; cursor:pointer; justify-self:start;
      }
      .pricing-panel .pricing-actions { display:flex; gap:8px; flex-wrap:wrap; }
      .pricing-panel ul { padding-inline-start:1.25em; }
      .pricing-panel li + li { margin-top:8px; }
    </style>
    <h3>Confirmed trips</h3>
    <p>Saved in this browser. Add the SBB second-class fare for each trip to include it in your estimate.</p>
    <div data-trips></div>
    <p data-storage-status role="status" hidden></p>
    <button type="button" data-clear>Clear trip history</button>
    <h3>Compare tickets and travelcards</h3>
    <p>Estimate your personal cost using fully priced days from the last 30 days and any extra days you enter below.</p>
    <form data-model>
      <div class="pricing-fields">
        <label>Age (16+, needed for age-based offers)<input name="age" type="number" min="16" max="130"></label>
        <label>Months to compare<input name="months" type="number" min="1" max="12" value="12" required></label>
      </div>
      <label><input type="checkbox" name="hasHalfFare"> I already have Half Fare for this period</label>
      <label><input type="checkbox" name="covered"> All routes are within the <a href="https://www.sbb.ch/en/offers/ga-travelcard" target="_blank" rel="noopener noreferrer">GA validity area</a></label>
      <fieldset>
        <legend>Extra travel each month</legend>
        <div class="pricing-fields">
          <label>Extra days<input name="extraDays" type="number" min="0" max="31" value="0" required></label>
          <label>Full fare per day (CHF)<input name="full" type="number" min="0" step="0.01"></label>
          <label>Half Fare per day (CHF)<input name="half" type="number" min="0" step="0.01"></label>
          <label>Group size (including you)<input name="group" type="number" min="1" max="4" value="1"></label>
        </div>
        <label><input type="checkbox" name="youth"> Everyone in the group is under 25 and travels together</label>
      </fieldset>
      <fieldset>
        <legend>Available Saver Day Pass quotes (optional)</legend>
        <p>Enter quotes only if you expect these prices to be available on the travel days you are comparing.</p>
        <div class="pricing-fields">
          <label>Full fare (CHF)<input name="saverFull" type="number" min="1" step="0.01"></label>
          <label>With Half Fare (CHF)<input name="saverHalf" type="number" min="1" step="0.01"></label>
        </div>
      </fieldset>
      <button type="submit">Compare prices</button>
    </form>
    <div data-results aria-live="polite"></div>
    <p>Regular routes may also qualify for a <a href="https://www.sbb.ch/en/offers/find-travelcard" target="_blank" rel="noopener noreferrer">regional or point-to-point travelcard</a>. Check <a href="https://www.sbb.ch/en/offers/libero-fare-network" target="_blank" rel="noopener noreferrer">Libero fares</a> for travel around Bern.</p>`;

  const trips = container.querySelector('[data-trips]');
  const options = container.querySelector('[data-model]');
  const results = container.querySelector('[data-results]');
  const clear = container.querySelector('[data-clear]');
  const storageStatus = container.querySelector('[data-storage-status]');
  let compared = false;

  function compare() {
    const input = options.elements;
    const now = new Date();
    const { days, incomplete } = recentTravelDays(history.list(), history.dateKey, now);
    const extraDays = number(input.extraDays);
    const full = number(input.full);
    if (extraDays > 0 && full === null) {
      results.replaceChildren(el('p', 'Enter the full fare per day for the extra travel days.'));
      return;
    }
    if (days.length + extraDays > 31) {
      results.replaceChildren(el('p', 'Enter up to 31 travel days per month, including the days from your history.'));
      return;
    }
    const daysToCompare = days.concat(Array.from({ length: extraDays }, () => ({
      fare: full,
      halfFare: number(input.half),
      groupSize: number(input.group),
      allUnder25: input.youth.checked,
    })));
    const ranked = recommendFares({
      days: daysToCompare,
      months: number(input.months),
      age: number(input.age),
      hasHalfFare: input.hasHalfFare.checked,
      covered: input.covered.checked,
      saver: { full: number(input.saverFull), half: number(input.saverHalf) },
      date: history.dateKey(now),
    });
    const summary = el('p', `${days.length} fully priced days from the last 30 days + ${extraDays} extra days per month.${incomplete ? ` ${incomplete} days have missing fares.` : ''}`);
    results.replaceChildren(summary);
    if (ranked.length === 0) {
      results.append(el('p', 'Price your saved trips or enter extra travel days to get a comparison.'));
      return;
    }
    const list = el('ul');
    ranked.forEach((offer, i) => {
      const item = el('li');
      item.append(el('strong', `${i === 0 ? 'Lowest estimate: ' : ''}${offer.label} · ${chf.format(offer.cost)}`),
        el('p', offer.detail), link('View on SBB', offer.url));
      list.append(item);
    });
    results.append(list, el('p', 'Estimates repeat the travel pattern for each month and use rates available today. Confirm availability, coverage and prices with SBB.'));
  }

  function renderTrips() {
    const saved = history.list();
    trips.replaceChildren();
    clear.hidden = saved.length === 0;
    if (!saved.length) trips.append(el('p', 'Your confirmed routes will appear here.'));
    for (const trip of saved) {
      const form = el('form');
      const fields = el('div');
      fields.className = 'pricing-fields';
      const fare = fareInput('Full fare (CHF)', trip.fare);
      const half = fareInput('Half Fare (CHF)', trip.halfFare);
      fields.append(fare.label, half.label);
      const actions = el('div');
      actions.className = 'pricing-actions';
      const remove = el('button', 'Remove');
      remove.type = 'button';
      remove.setAttribute('aria-label', `Remove ${trip.from} to ${trip.to} on ${trip.date}`);
      remove.addEventListener('click', () => {
        if (!history.remove(trip.id)) {
          message.textContent = 'Could not remove this trip.';
          return;
        }
        renderTrips();
        if (compared && options.checkValidity()) compare();
      });
      actions.append(el('button', 'Save fares'), remove);
      const message = el('span');
      message.role = 'status';
      form.append(el('strong', `${trip.from} → ${trip.to}`), el('span', trip.date), fields, actions, message);
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const saved = history.update(trip.id, { fare: number(fare.input), halfFare: number(half.input) });
        message.textContent = saved ? 'Fares saved.' : 'Could not save fares.';
        if (compared && options.checkValidity()) compare();
      });
      trips.append(form);
    }
  }

  options.addEventListener('submit', (event) => {
    event.preventDefault();
    compared = true;
    compare();
  });
  clear.addEventListener('click', () => {
    if (!window.confirm('Clear all confirmed trips saved in this browser?')) return;
    const cleared = history.clear();
    storageStatus.hidden = false;
    storageStatus.textContent = cleared ? 'Trip history cleared.' : 'Could not clear trip history.';
    if (!cleared) return;
    renderTrips();
    if (compared && options.checkValidity()) compare();
  });
  function refresh() {
    renderTrips();
    if (compared && options.checkValidity()) compare();
  }

  refresh();
  return refresh;
}
