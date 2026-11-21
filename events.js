// Community listings sourced from the organizers below.
(function () {
  const CATEGORIES = {
    language:  { color: '#5856d6', label: 'Language' },
    food:      { color: '#ff9500', label: 'Community meal' },
    legal:     { color: '#007aff', label: 'Advice' },
    jobs:      { color: '#30b0c7', label: 'Work & training' },
    workshop:  { color: '#8c557d', label: 'Creative workshop' },
    community: { color: '#ff2d55', label: 'Meetup' },
    sport:     { color: '#34c759', label: 'Sport' },
    kids:      { color: '#e6a800', label: 'Kids & learning' },
    health:    { color: '#ff3b30', label: 'Health' },
  };

  // Stroke glyphs on a 24×24 grid, drawn white on the coloured circle
  const GLYPHS = {
    workshop: 'M4 16l-1 5 5-1L20 8l-4-4zM13 7l4 4',
    language:  'M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8l-4 3.5V17H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z',
    food:      'M7 3v7a2 2 0 0 0 4 0V3M9 10v11M16 21V3c-2 1.5-3 4-3 7h3',
    legal:     'M12 4v16M7 20h10M5 7h14M5 7l-2.5 6a2.5 2.5 0 0 0 5 0zM19 7l-2.5 6a2.5 2.5 0 0 0 5 0z',
    jobs:      'M4 8h16v11H4zM9 8V5.5h6V8M4 13h16',
    community: 'M12 20s-7.5-4.6-7.5-10.2A4.2 4.2 0 0 1 12 7.3a4.2 4.2 0 0 1 7.5 2.5C19.5 15.4 12 20 12 20z',
    sport:     'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM12 8l3.8 2.8-1.5 4.5H9.7L8.2 10.8z',
    kids:      'M3 6h6a3 3 0 0 1 3 3v11a2.5 2.5 0 0 0-2.5-2.5H3zM21 6h-6a3 3 0 0 0-3 3v11a2.5 2.5 0 0 1 2.5-2.5H21z',
    health:    'M12 5v14M5 12h14',
  };

  const listings = [
    {
      id: 'speak-out-dinner', cat: 'food', title: 'Free dinner at Speak-Out',
      coordinates: [8.544008, 47.374928], city: 'Zürich',
      venue: 'Gassenküche Speak-Out, Häringstrasse 3',
      when: 'Weekdays from 20:00', cost: 'Free meal', attendance: 'Drop in',
      about: 'A warm meal is served from 20:00. Check the visitor page for seasonal Wednesday closures.',
      audience: 'Open to everyone', tags: ['free-food'],
      url: 'https://www.speakout-zueri.ch/besuchen',
    },
    {
      id: 'aoz-german-oerlikon', cat: 'language', title: 'Beginner German at PBZ Oerlikon',
      coordinates: [8.545239, 47.411751], city: 'Zürich',
      venue: 'PBZ Oerlikon, Hofwiesenstrasse 379',
      when: 'Tuesdays, 09:30–11:30', cost: 'Free', attendance: 'No registration needed',
      about: 'Practise German for everyday situations. See AOZ’s course page for holiday closures.',
      audience: 'Adults in the city of Zürich who speak little or no German', tags: ['language', 'newcomers'],
      url: 'https://aoz.ch/de/kurse-und-angebote/deutsch-der-bibliothek',
    },
    {
      id: 'witikon-language-cafe', cat: 'language', title: 'German conversation café in Witikon',
      coordinates: [8.594219, 47.360008], city: 'Zürich',
      venue: 'GZ Witikon, Witikonerstrasse 405',
      when: 'Tuesdays in even-numbered weeks, 11:30–12:30', cost: 'Free', attendance: 'No registration needed',
      about: 'Practise speaking German in an informal group. The café takes a break during city school holidays.',
      audience: 'Anyone who wants to practise German', tags: ['language'],
      url: 'https://gz-zh.ch/gz-witikon/programm/',
    },
    {
      id: 'bbz-advent-2026', cat: 'community', title: 'Advent gathering at BBZ Zürich',
      coordinates: [8.395218, 47.418839], city: 'Dietikon',
      venue: 'BBZ Zürich, Moosmattstrasse 30',
      when: '10 December 2026 from 14:30', through: '2026-12-10T23:59:59+01:00',
      cost: 'Ask the organizer about cost', attendance: 'Advance registration required',
      about: 'An Advent afternoon gathering at the Swiss Federation of the Blind and Visually Impaired’s community centre. Contact the centre to register.',
      audience: 'Blind and low-vision people', tags: ['blind-low-vision'],
      url: 'https://sbv-fsa.ch/bbz/zuerich/',
    },
    {
      id: 'bbz-ceramics', cat: 'community', title: 'Clay workshop at BBZ Zürich',
      coordinates: [8.395218, 47.418839], city: 'Dietikon',
      venue: 'BBZ Zürich, Moosmattstrasse 30',
      when: 'Usually Tuesdays', cost: 'Ask about course and materials fees', attendance: 'Contact the organizer',
      about: 'Work with clay at the BBZ. Contact the centre for the next workshop time and availability.',
      audience: 'Blind and low-vision people', tags: ['blind-low-vision'],
      url: 'https://sbv-fsa.ch/bbz/zuerich/',
    },
  ];

  const scheduledEvents = window.SWISS_EVENT_SERIES.flatMap(({ sessions, ...series }) =>
    sessions.map((session) => ({ ...series, ...session })));
  listings.push(...window.SWISS_WORKSHOPS, ...scheduledEvents, ...window.COMMUNITY_PROGRAMMES, ...window.BERN_EVENTS);
  const features = listings.map(({ coordinates, ...listing }) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates },
    properties: {
      cost: 'Check fees with the organizer',
      attendance: 'Contact the organizer for registration details',
      ...listing,
      color: CATEGORIES[listing.cat].color,
      category: CATEGORIES[listing.cat].label,
    },
  }));

  function matches(event, preferences, now = Date.now()) {
    const { through, tags } = event.properties;
    return (!through || Date.parse(through) >= now)
      && (!preferences.length || preferences.some((preference) => tags.includes(preference)));
  }

  window.EVENTS = { GLYPHS, features, matches };
})();
