import { recommendFromHistory } from './pricing-engine.js';

const money = new Intl.NumberFormat('en-CH', { style: 'currency', currency: 'CHF' });
const numeric = (input) => input.value === '' ? null : input.valueAsNumber;

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function button(text, action, className) {
  const node = el('button', text, className);
  node.type = action ? 'button' : 'submit';
  if (action) node.addEventListener('click', action);
  return node;
}

function personal(tag, text, className) {
  const node = el(tag, text, className);
  node.setAttribute('translate', 'no');
  return node;
}

function numberField(label, name, value, min, max, step = 1) {
  const field = el('label', label);
  const input = el('input');
  Object.assign(input, { name, type: 'number', min, step, inputMode: step === 1 ? 'numeric' : 'decimal' });
  if (max !== undefined) input.max = max;
  if (Number.isFinite(value)) input.value = value;
  field.append(input);
  return field;
}

function checkbox(text, name, checked) {
  const label = el('label', undefined, 'fare-check');
  const input = el('input');
  Object.assign(input, { name, type: 'checkbox', checked: Boolean(checked) });
  label.append(input, text);
  return label;
}

function disclosure(title) {
  const box = el('details');
  box.append(el('summary', title));
  return box;
}

function offerLink(offer) {
  const link = el('a', 'View on SBB');
  Object.assign(link, { href: offer.url, target: '_blank', rel: 'noopener noreferrer' });
  link.setAttribute('aria-label', `View ${offer.label} on SBB`);
  return link;
}

let currentWindow;
export function openSuggestions({ history, trigger = document.activeElement, onChange }) {
  if (currentWindow?.dialog.open) return currentWindow.dialog;
  currentWindow?.cleanup();

  const dialog = el('dialog', undefined, 'fare-dialog');
  dialog.id = 'fare-suggestions';
  dialog.dataset.fareSuggestions = '';
  dialog.setAttribute('aria-labelledby', 'fare-title');
  const shell = el('div', undefined, 'fare-shell');
  const header = el('header', undefined, 'fare-header');
  const title = el('h2', 'Fare suggestions');
  title.id = 'fare-title';
  const close = button('×', dismiss, 'fare-close');
  close.setAttribute('aria-label', 'Close fare suggestions');
  close.autofocus = true;
  header.append(title, close);

  const body = el('div', undefined, 'fare-body');
  const results = el('section', undefined, 'fare-results');
  const status = el('p', '', 'fare-status');
  status.setAttribute('role', 'status');
  const profileBox = disclosure('Travel profile');
  const tripBox = disclosure('Trip history');
  const tripList = el('div', undefined, 'fare-trips');
  tripBox.append(tripList);
  body.append(results, profileBox, tripBox, status);
  shell.append(header, body);
  dialog.append(shell);

  function renderResults() {
    const profile = history.profile();
    const trips = history.list();
    const { ranked, dayCount, tripCount, missingCount, monthlySpend, repeatedRoute } =
      recommendFromHistory(trips, profile);
    const [best, ...alternatives] = ranked;
    const alternativesOpen = results.querySelector('details')?.open;
    results.replaceChildren();
    function appendCommuterSuggestion() {
      if (!repeatedRoute) return;
      const { from, to, dayCount } = repeatedRoute;
      const note = el('p', undefined, 'fare-note');
      const link = el('a', 'Check monthly or yearly point-to-point and regional travelcard prices on SBB');
      Object.assign(link, { href: 'https://www.sbb.ch/en/offers/point-to-point-modular-regional-travelcards', target: '_blank', rel: 'noopener noreferrer' });
      note.append(personal('span', `${from} ↔ ${to} on ${dayCount} of the last 30 days. `), link);
      results.append(note);
    }
    if (!best) {
      const card = el('div', undefined, 'fare-card');
      card.append(el('h3', tripCount ? 'Add fares to compare tickets' : 'No recent trips'),
        el('p', tripCount ? 'Enter ticket prices for your recent trips in Trip history.' :
          trips.length ? 'Suggestions use confirmed rides that departed within the last 30 days.' :
          'Tap the fare below Get ticket on a journey, then choose Confirm trip.'));
      if (tripCount && !profile.hasHalfFare && trips.some((trip) => trip.fare == null && trip.halfFare != null)) {
        card.append(el('p', 'If you already have Half Fare, select it in your travel profile to use saved reduced fares.'));
      }
      if (tripCount) card.append(button('Edit trip fares', () => {
        tripBox.open = true;
        tripBox.querySelector('summary').focus();
      }));
      results.append(card);
      appendCommuterSuggestion();
      return;
    }

    const months = profile.months ?? 1;
    const period = months === 1 ? '1 month' : `${months} months`;
    const card = el('div', undefined, 'fare-card');
    card.append(el('p', alternatives.length ? 'Suggested for your second-class trips' : 'Your second-class ticket estimate', 'fare-eyebrow'),
      el('h3', best.label), personal('p', `${money.format(best.cost)} · ${period}`, 'fare-price'),
      personal('p', best.detail), offerLink(best));
    const savings = Math.round((monthlySpend * months - best.cost) * 100) / 100;
    if (savings > 0) card.append(personal('p', `Estimated savings of ${money.format(savings)} over ${period} compared with buying the same route tickets.`, 'fare-note'));
    results.append(card);

    const basis = `Based on ${dayCount} priced travel ${dayCount === 1 ? 'day' : 'days'} in the last 30 days.`;
    const spend = Number.isFinite(monthlySpend) ? ` Estimated route ticket cost for those days is ${money.format(monthlySpend)}.` : '';
    const missing = missingCount ? ` ${missingCount} ${missingCount === 1 ? 'travel day has missing fares' : 'travel days have missing fares'}.` : '';
    const receipt = el('p', basis + spend + missing, 'fare-note');
    receipt.setAttribute('translate', 'no');
    results.append(receipt);
    if (profile.age === undefined || profile.covered === undefined) {
      const hint = el('div', undefined, 'fare-profile-hint');
      hint.append(el('p', 'Add your age and route coverage to compare eligible passes.', 'fare-note'),
        button('Set travel profile', () => {
          profileBox.open = true;
          profileBox.querySelector('summary').focus();
        }));
      results.append(hint);
    }

    if (alternatives.length) {
      const other = disclosure('Compare other options');
      other.open = Boolean(alternativesOpen);
      const list = el('ul', undefined, 'fare-alternatives');
      for (const offer of alternatives) {
        const item = el('li');
        const name = el('div', undefined, 'fare-offer');
        name.append(el('strong', offer.label), personal('span', money.format(offer.cost)));
        item.append(name, personal('p', offer.detail, 'fare-note'), offerLink(offer));
        list.append(item);
      }
      other.append(list);
      results.append(other);
    }
    results.append(el('p', 'Estimates repeat your recent travel pattern. Check fares and validity with SBB.', 'fare-note'));
    appendCommuterSuggestion();
  }

  function changed(message) {
    renderResults();
    status.textContent = message;
    onChange?.();
  }

  const profile = history.profile();
  const settings = el('form', undefined, 'fare-form');
  const fields = el('div', undefined, 'fare-fields');
  const group = numberField('Group size', 'groupSize', profile.groupSize ?? 1, 1, 4);
  fields.append(numberField('Age (16+)', 'age', profile.age, 16, 130),
    numberField('Months to compare', 'months', profile.months ?? 1, 1, 12), group);
  const youth = checkbox('Everyone is under 25 and travels together on every projected travel day', 'allUnder25', profile.allUnder25);
  const senior = el('label', 'Eligible for the GA Senior rate?');
  const seniorChoice = el('select');
  seniorChoice.name = 'seniorEligibility';
  for (const [value, text] of [['', 'Select eligibility'], ['true', 'Yes'], ['false', 'No']]) {
    const option = el('option', text);
    option.value = value;
    seniorChoice.append(option);
  }
  seniorChoice.value = profile.seniorEligibility === undefined ? '' : String(profile.seniorEligibility);
  senior.append(seniorChoice);
  const coverage = checkbox('All routes are within the GA validity area', 'covered', profile.covered);
  const saver = disclosure('Saver Day Pass quotes');
  const quotes = el('div', undefined, 'fare-form');
  const quoteFields = el('div', undefined, 'fare-fields');
  quoteFields.append(numberField('Full fare (CHF)', 'saverFull', profile.saver?.full, 0.01, undefined, 0.01),
    numberField('Half Fare (CHF)', 'saverHalf', profile.saver?.half, 0.01, undefined, 0.01));
  quotes.append(el('p', 'Optional. Enter quotes only if you expect those fares on the days you travel.', 'fare-note'), quoteFields);
  saver.append(quotes);
  const values = settings.elements;
  function showYouth() {
    const age = numeric(values.age);
    senior.hidden = age !== 64;
    group.hidden = !(age >= 16 && age < 25);
    values.groupSize.disabled = group.hidden;
    youth.hidden = group.hidden || !(numeric(values.groupSize) > 1);
  }
  settings.append(fields, senior,
    checkbox('I already have Half Fare for this period', 'hasHalfFare', profile.hasHalfFare),
    coverage, youth, saver, button('Save profile'));
  function showSaver() { saver.hidden = !values.covered.checked; }
  values.covered.addEventListener('change', showSaver);
  showSaver();
  values.age.addEventListener('input', showYouth);
  values.groupSize.addEventListener('input', showYouth);
  showYouth();
  settings.addEventListener('submit', (event) => {
    event.preventDefault();
    const groupSize = numeric(values.groupSize) ?? 1;
    const saved = history.setProfile({
      age: numeric(values.age),
      months: numeric(values.months) ?? 1,
      groupSize,
      allUnder25: !youth.hidden && values.allUnder25.checked,
      seniorEligibility: senior.hidden || seniorChoice.value === '' ? undefined : seniorChoice.value === 'true',
      saver: { full: numeric(values.saverFull), half: numeric(values.saverHalf) },
      covered: values.covered.checked,
      hasHalfFare: values.hasHalfFare.checked,
    });
    if (saved === false) status.textContent = 'Could not save your travel profile.';
    else changed('Travel profile saved.');
  });
  profileBox.append(settings);

  function renderTrips() {
    const trips = history.list();
    const summary = tripBox.querySelector('summary');
    summary.replaceChildren(el('span', 'Trip history'), personal('span', ` · ${trips.length}`));
    tripList.replaceChildren();
    if (!trips.length) {
      tripList.append(el('p', 'Confirmed journeys will appear here.', 'fare-note'));
      return;
    }
    for (const trip of trips) {
      const form = el('form', undefined, 'fare-form fare-trip');
      form.setAttribute('translate', 'no');
      const fares = el('div', undefined, 'fare-fields');
      fares.append(numberField('Full fare (CHF)', 'fare', trip.fare, 0, undefined, 0.01),
        numberField('Half Fare (CHF)', 'halfFare', trip.halfFare, 0, undefined, 0.01));
      const actions = el('div', undefined, 'fare-actions');
      const remove = button('Remove', () => {
        if (!history.remove(trip.id)) {
          status.textContent = 'Could not remove this trip.';
          return;
        }
        renderTrips();
        summary.focus();
        changed('Trip removed.');
      });
      remove.setAttribute('aria-label', `Remove ${trip.from} to ${trip.to} on ${trip.date}`);
      actions.append(button('Save fares'), remove);
      form.append(el('strong', `${trip.from} → ${trip.to}`), el('p', trip.date, 'fare-note'), fares, actions);
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const { fare, halfFare } = form.elements;
        if (!history.update(trip.id, { fare: numeric(fare), halfFare: numeric(halfFare) })) {
          status.textContent = 'Could not save fares.';
          return;
        }
        changed('Fares saved.');
      });
      tripList.append(form);
    }

    const confirmClear = el('div', undefined, 'fare-actions');
    confirmClear.hidden = true;
    const clear = button('Clear trip history', () => {
      clear.hidden = true;
      confirmClear.hidden = false;
      cancel.focus();
    });
    const cancel = button('Cancel', () => {
      clear.hidden = false;
      confirmClear.hidden = true;
      clear.focus();
    });
    confirmClear.append(el('p', 'Remove all confirmed trips from this browser?'), cancel,
      button('Clear all trips', () => {
        if (!history.clear()) {
          status.textContent = 'Could not clear trip history.';
          return;
        }
        renderTrips();
        summary.focus();
        changed('Trip history cleared.');
      }));
    tripList.append(clear, confirmClear);
  }

  let backdropPressed = false;
  dialog.addEventListener('pointerdown', (event) => { backdropPressed = event.target === dialog; });
  dialog.addEventListener('click', (event) => {
    if (backdropPressed && event.target === dialog) dismiss();
    backdropPressed = false;
  });
  function cleanup() {
    if (currentWindow?.dialog !== dialog) return;
    currentWindow = undefined;
    window.removeEventListener('hashchange', dismiss);
    dialog.remove();
    if (trigger?.isConnected && trigger.getClientRects().length && !trigger.closest('[inert]')) {
      trigger.focus({ preventScroll: true });
    }
  }

  function dismiss() {
    if (dialog.open) dialog.close();
    cleanup();
  }
  window.addEventListener('hashchange', dismiss);
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    dismiss();
  });
  dialog.addEventListener('close', cleanup, { once: true });
  currentWindow = { dialog, cleanup };
  renderResults();
  renderTrips();
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}
