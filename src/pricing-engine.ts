const offers = {
  tickets: 'https://www.sbb.ch/en/tickets-offers/tickets.html',
  halfFare: 'https://www.sbb.ch/en/offers/half-fare-travelcard',
  regularDay: 'https://www.sbb.ch/en/offers/day-pass-for-the-half-fare-travelcard',
  saverDay: 'https://www.sbb.ch/en/offers/saver-day-pass',
  friends: 'https://www.sbb.ch/en/offers/friends-day-pass-youth',
  month: 'https://www.sbb.ch/en/offers/ga-1-month',
  ga: 'https://www.sbb.ch/en/offers/ga-travelcard',
  seniorGA: 'https://www.sbb.ch/en/offers/ga-travelcard-senior',
};

const swissDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit',
});

function isFare(amount) {
  return Number.isFinite(amount) && amount >= 0;
}

function routeTicketFare(trip, halfFare) {
  if (!halfFare) return trip.fare;
  return isFare(trip.halfFare) ? trip.halfFare : trip.fare / 2;
}

function bestDailyFare(day, { age, covered, halfFare, saver, dayPassPrice }) {
  const ticketFare = routeTicketFare(day, halfFare);
  const choices = [{ cost: ticketFare, label: 'route tickets', url: offers.tickets }];

  if (covered) {
    if (halfFare && isFare(dayPassPrice)) {
      choices.push({ cost: dayPassPrice, label: 'Half Fare Day Pass', url: offers.regularDay });
    }

    const saverPrice = halfFare ? saver?.half : saver?.full;
    if (isFare(saverPrice) && saverPrice > 0) {
      choices.push({ cost: saverPrice, label: 'Saver Day Pass', url: offers.saverDay });
    }

    if (age < 25 && day.allUnder25 === true && [2, 3, 4].includes(day.groupSize)) {
      choices.push({
        cost: 80 / day.groupSize,
        label: 'Friends Day Pass for Youth (CHF 80 per group, shared equally)',
        url: offers.friends,
      });
    }
  }

  return choices.reduce((best, choice) => choice.cost < best.cost ? choice : best);
}

function compareTickets(days, months, options, cardCost = 0) {
  let total = 0;
  let usingEstimatedHalfFare = false;
  const counts = new Map();
  const links = new Set();
  for (const day of days) {
    const best = bestDailyFare(day, options);
    total += best.cost;
    counts.set(best.label, (counts.get(best.label) ?? 0) + 1);
    links.add(best.url);
    if (options.halfFare && best.url === offers.tickets && (!isFare(day.halfFare) || day.estimatedHalfFare)) {
      usingEstimatedHalfFare = true;
    }
  }

  const onlyOffer = counts.size === 1 ? [...counts.keys()][0] : null;
  const ticketLabel = onlyOffer?.startsWith('Friends Day Pass') ? 'Friends Day Pass for Youth'
    : onlyOffer === 'route tickets' ? 'Point-to-point tickets'
    : onlyOffer || 'A mix of tickets and day passes';
  const summary = Array.from(counts, ([label, count]) => `${count * months} × ${label}`).join(', ');
  const cardNote = cardCost ? ` Includes CHF ${cardCost} for the annual Half Fare Travelcard.` : '';
  const saverNote = links.has(offers.saverDay) ? ' Saver Day Pass prices assume the quoted fare is available each time.' : '';
  const estimationNote = usingEstimatedHalfFare ? ' Missing discounted fares are estimated at 50% of the full fare.' : '';
  return {
    id: cardCost ? 'buy-half-fare' : 'tickets',
    label: cardCost ? 'Half Fare Travelcard + tickets' : ticketLabel,
    cost: Math.round((total * months + cardCost) * 100) / 100,
    detail: `${summary}.${cardNote}${saverNote}${estimationNote}`,
    url: cardCost ? offers.halfFare : links.size === 1 ? links.values().next().value : offers.tickets,
  };
}

/**
 * Compare personal second-class costs in CHF for the supplied number of months.
 * Each entry represents one complete travel day in a typical month. Quoted
 * Saver Day Pass prices are used only as estimates for matching travel days.
 */
export function recommendFares({
  days, months = 1, age, hasHalfFare = false, saver, date, covered = false, seniorEligibility,
} = {}) {
  if (!Array.isArray(days) || !Number.isInteger(months) || months < 1 || months > 12) return [];
  const pricedDays = days.filter((day) => day && (isFare(day.fare) || (hasHalfFare && isFare(day.halfFare))));
  if (pricedDays.length === 0) return [];

  const knownAge = Number.isInteger(age) && age >= 16 && age <= 130;
  const validAge = knownAge ? age : Infinity;
  const newTariff = typeof date === 'string' && date >= '2026-12-13';
  const options = { age: validAge, covered, halfFare: hasHalfFare, saver, dayPassPrice: newTariff ? 81 : 78 };
  const results = [compareTickets(pricedDays, months, options)];
  if (!hasHalfFare && knownAge) {
    const price = age < 25 ? 120 : newTariff ? 195 : 190;
    results.push(compareTickets(pricedDays, months, { ...options, halfFare: true }, price));
  }

  if (covered && knownAge) {
    const monthPrice = age < 25 ? (newTariff ? 310 : 295) : (newTariff ? 465 : 440);
    results.push({
      id: 'one-month-ga',
      label: '1-month GA Travelcard',
      cost: monthPrice * months,
      detail: `CHF ${monthPrice} per month of travel, purchased separately for each month.`,
      url: offers.month,
    });

    if (age !== 64 || typeof seniorEligibility === 'boolean') {
      const senior = age >= 65 || (age === 64 && seniorEligibility);
      const gaPrices = newTariff ? {
        youth: [2875, 265], age25: [3535, 315], adult: [4095, 365], senior: [3260, 295],
      } : {
        youth: [2780, 260], age25: [3495, 310], adult: [3995, 355], senior: [3040, 275],
      };
      const [yearPrice, monthlyPrice] = gaPrices[senior ? 'senior' : age < 25 ? 'youth' : age === 25 ? 'age25' : 'adult'];
      const gaName = senior ? 'GA Travelcard for Seniors' : 'GA Travelcard';
      const gaUrl = senior ? offers.seniorGA : offers.ga;
      results.push({
        id: 'annual-ga',
        label: `${gaName}, annual payment`,
        cost: yearPrice,
        detail: `Full year paid upfront, including the ${months === 1 ? 'one month' : `${months} months`} of travel compared here.`,
        url: gaUrl,
      });

      const billedMonths = Math.max(6, months);
      results.push({
        id: 'monthly-ga',
        label: `${gaName}, monthly payment`,
        cost: monthlyPrice * billedMonths,
        detail: `CHF ${monthlyPrice} per month for ${billedMonths} months. Six-month minimum term. Check SBB’s cancellation deadline.`,
        url: gaUrl,
      });
    }
  }

  return results.sort((a, b) => a.cost - b.cost);
}

/** Compare costs using complete travel days from the last 30 Swiss calendar dates. */
export function recommendFromHistory(trips, profile = {}, now = new Date()) {
  const { year, month, day } = Object.fromEntries(
    swissDate.formatToParts(now).map(({ type, value }) => [type, value]),
  );
  const today = `${year}-${month}-${day}`;
  const cutoff = new Date(`${today}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - 29);
  const recentDates = new Set();
  for (let i = 0; i < 30; i++) {
    recentDates.add(cutoff.toISOString().slice(0, 10));
    cutoff.setUTCDate(cutoff.getUTCDate() + 1);
  }

  const byDate = new Map();
  const routeDays = new Map();
  let repeatedRoute = null;
  const seen = new Set();
  let tripCount = 0;
  for (const trip of trips ?? []) {
    if (!trip || trip.confirmed === false || !recentDates.has(trip.date) || Date.parse(trip.departure) > now.getTime()) continue;
    if (typeof trip.id === 'string') {
      if (seen.has(trip.id)) continue;
      seen.add(trip.id);
    }
    tripCount++;
    if (!byDate.has(trip.date)) byDate.set(trip.date, []);
    byDate.get(trip.date).push(trip);
    if (typeof trip.from !== 'string' || typeof trip.to !== 'string') continue;
    const stops = [trip.from, trip.to].map(name => name.trim().normalize().toLocaleLowerCase('de-CH')).sort();
    if (!stops[0] || stops[0] === stops[1]) continue;
    const key = JSON.stringify(stops);
    if (!routeDays.has(key)) routeDays.set(key, new Set());
    const dates = routeDays.get(key);
    dates.add(trip.date);
    if (dates.size > (repeatedRoute?.dayCount ?? 1)) {
      repeatedRoute = { from: trip.from, to: trip.to, dayCount: dates.size };
    }
  }

  const days = [];
  for (const routes of byDate.values()) {
    if (!routes.every((trip) => isFare(trip.fare) || (profile.hasHalfFare && isFare(trip.halfFare)))) continue;
    days.push({
      fare: routes.every((trip) => isFare(trip.fare)) ? routes.reduce((sum, trip) => sum + trip.fare, 0) : null,
      halfFare: routes.reduce((sum, trip) => sum + routeTicketFare(trip, true), 0),
      estimatedHalfFare: routes.some((trip) => !isFare(trip.halfFare)),
      groupSize: profile.groupSize,
      allUnder25: profile.allUnder25,
    });
  }

  const routeSpend = days.reduce((sum, day) => sum + routeTicketFare(day, profile.hasHalfFare), 0);
  return {
    ranked: recommendFares({ ...profile, days, date: today }),
    dayCount: days.length,
    tripCount,
    repeatedRoute,
    missingCount: byDate.size - days.length,
    monthlySpend: Math.round(routeSpend * 100) / 100,
  };
}
