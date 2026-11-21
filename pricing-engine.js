const offers = {
  tickets: 'https://www.sbb.ch/en/tickets-offers/tickets.html',
  halfFare: 'https://www.sbb.ch/en/offers/half-fare-travelcard',
  regularDay: 'https://www.sbb.ch/en/offers/day-pass-for-the-half-fare-travelcard',
  saverDay: 'https://www.sbb.ch/en/offers/saver-day-pass',
  friends: 'https://www.sbb.ch/en/offers/friends-day-pass-youth',
  month: 'https://www.sbb.ch/en/offers/ga-1-month',
  ga: 'https://www.sbb.ch/en/offers/ga-travelcard',
};

function isFare(amount) {
  return Number.isFinite(amount) && amount >= 0;
}

function bestDailyFare(day, { age, covered, halfFare, saver, dayPassPrice }) {
  const ticketFare = halfFare
    ? (isFare(day.halfFare) ? day.halfFare : day.fare / 2)
    : day.fare;
  const choices = [{ cost: ticketFare, label: 'route tickets', url: offers.tickets }];

  if (covered) {
    if (halfFare && isFare(dayPassPrice)) {
      choices.push({ cost: dayPassPrice, label: 'Half Fare Day Pass', url: offers.regularDay });
    }

    const saverPrice = halfFare ? saver?.half : saver?.full;
    if (isFare(saverPrice)) {
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

  const summary = Array.from(counts, ([label, count]) => `${count * months} × ${label}`).join(', ');
  const cardNote = cardCost ? ` Includes CHF ${cardCost} for the annual Half Fare Travelcard.` : '';
  const estimationNote = usingEstimatedHalfFare ? ' Missing discounted fares are estimated at 50% of the full fare.' : '';
  return {
    id: cardCost ? 'buy-half-fare' : 'tickets',
    label: cardCost ? 'Buy Half Fare + daily tickets' : 'Buy tickets as needed',
    cost: Math.round((total * months + cardCost) * 100) / 100,
    detail: `${summary}.${cardNote}${estimationNote}`,
    url: cardCost ? offers.halfFare : links.size === 1 ? links.values().next().value : offers.tickets,
  };
}

/**
 * Compare personal second-class costs in CHF for the supplied number of months.
 * Each entry represents one complete travel day in a typical month. Quoted
 * Saver Day Pass prices are used only as estimates for matching travel days.
 */
export function recommendFares({
  days, months = 1, age, hasHalfFare = false, saver, date, covered = false,
} = {}) {
  if (!Array.isArray(days) || !Number.isInteger(months) || months < 1 || months > 12) return [];
  const pricedDays = days.filter((day) => day && isFare(day.fare));
  if (pricedDays.length === 0) return [];

  const knownAge = Number.isInteger(age) && age >= 16;
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

    // Senior eligibility starts at 64 or 65. The input does not distinguish it.
    if (age < 64) {
      const gaPrices = newTariff ? {
        youth: [2875, 265], age25: [3535, 315], adult: [4095, 365],
      } : {
        youth: [2780, 260], age25: [3495, 310], adult: [3995, 355],
      };
      const [yearPrice, monthlyPrice] = gaPrices[age < 25 ? 'youth' : age === 25 ? 'age25' : 'adult'];
      results.push({
        id: 'annual-ga',
        label: 'GA Travelcard, annual payment',
        cost: yearPrice,
        detail: `Full year paid upfront, including the ${months === 1 ? 'one month' : `${months} months`} of travel compared here.`,
        url: offers.ga,
      });

      const billedMonths = Math.max(6, months);
      results.push({
        id: 'monthly-ga',
        label: 'GA Travelcard, monthly payment',
        cost: monthlyPrice * billedMonths,
        detail: `CHF ${monthlyPrice} per month for ${billedMonths} months. Six-month minimum term. Check SBB’s cancellation deadline.`,
        url: offers.ga,
      });
    }
  }

  return results.sort((a, b) => a.cost - b.cost);
}
