// What the events button can show on the map besides community events: public toilets, drinking water,
// health, help, shops… (data/*.json, compacted into map-places.js by tools/build-map-places.mts).
// GROUPS are the switches under "On the map" in Settings; classify() sorts every data category into one.
(function () {
  // Palette: navy #344D77 · rose #C55A82 · sun #FFD34B (navy glyph) · tang #FF7241
  const COLORS = {
    navy: { fill: '#344D77', ink: '#FFFFFF', css: 'var(--navy)' },
    rose: { fill: '#C55A82', ink: '#FFFFFF', css: 'var(--rose)' },
    sun:  { fill: '#FFD34B', ink: '#344D77', css: 'var(--sun)' },
    tang: { fill: '#FF7241', ink: '#FFFFFF', css: 'var(--tang)' },
  };

  // Stroke glyphs on a 24×24 grid (same style as the event and settings icons)
  const GLYPHS = {
    calendar: 'M6.5 5h11a3 3 0 0 1 3 3v9.5a3 3 0 0 1-3 3h-11a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3zM3.5 10h17M8 3v4M16 3v4',
    wc: 'M2.5 8l2.2 8 2.3-5.5 2.3 5.5 2.2-8M20.5 8.8A4 4 0 1 0 20.5 15.2',
    drop: 'M12 3.5s-6 6.6-6 11a6 6 0 0 0 12 0c0-4.4-6-11-6-11z',
    cross: 'M12 5v14M5 12h14',
    hospital: 'M7 5v14M17 5v14M7 12h10',
    aed: 'M12 20s-7.5-4.6-7.5-10.2A4.2 4.2 0 0 1 12 7.3a4.2 4.2 0 0 1 7.5 2.5C19.5 15.4 12 20 12 20zM12.8 9.5l-2.3 3.2h3l-2.3 3.3',
    tooth: 'M7.5 4.5c-2.5 0-3.5 2.2-3 4.5.6 2.6 1.5 4 1.9 7 .3 2.3 1.1 3.5 2 3.5 1.4 0 1.3-4.5 3.6-4.5s2.2 4.5 3.6 4.5c.9 0 1.7-1.2 2-3.5.4-3 1.3-4.4 1.9-7 .5-2.3-.5-4.5-3-4.5-1.9 0-2.6 1.1-4.5 1.1S9.4 4.5 7.5 4.5z',
    phone: 'M5 4h3.5l1.5 4.5-2.2 1.3a11 11 0 0 0 6.4 6.4l1.3-2.2L20 15.5V19a1.5 1.5 0 0 1-1.6 1.5A16 16 0 0 1 3.5 5.6 1.5 1.5 0 0 1 5 4z',
    shield: 'M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6z',
    info: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM12 11v5.5M12 7.5h.01',
    people: 'M9 11a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4zM3 20a6 6 0 0 1 12 0M16 11a3 3 0 1 0 0-6M18.5 20a6 6 0 0 0-3-5.2',
    heart: 'M12 20s-7.5-4.6-7.5-10.2A4.2 4.2 0 0 1 12 7.3a4.2 4.2 0 0 1 7.5 2.5C19.5 15.4 12 20 12 20z',
    building: 'M3 20h18M5 20V10M9.5 20V10M14.5 20V10M19 20V10M3 10h18L12 4z',
    book: 'M3 6h6a3 3 0 0 1 3 3v11a2.5 2.5 0 0 0-2.5-2.5H3zM21 6h-6a3 3 0 0 0-3 3v11a2.5 2.5 0 0 1 2.5-2.5H21z',
    wifi: 'M4.5 9.5a10.5 10.5 0 0 1 15 0M7.5 12.6a6.3 6.3 0 0 1 9 0M10.4 15.6a2.3 2.3 0 0 1 3.2 0M12 19h.01',
    mail: 'M3.5 6.5h17v11h-17zM3.5 7l8.5 6.5L20.5 7',
    plug: 'M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4',
    lock: 'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3',
    fork: 'M7 3v7a2 2 0 0 0 4 0V3M9 10v11M16 21V3c-2 1.5-3 4-3 7h3',
    cup: 'M4 9h12v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5zM16 10.5h1.5a2.5 2.5 0 0 1 0 5H16M8 3.5V6M12 3.5V6',
    glass: 'M6 4h12l-6 8zM12 12v8M8 20h8',
    icecream: 'M7.5 10a4.5 4.5 0 0 1 9 0zM7.5 10L12 21l4.5-11',
    bag: 'M5 8h14l-1 12.5H6zM9 8V6.5a3 3 0 0 1 6 0V8',
    cart: 'M3 4h2.5l2.2 10.5h10.6L20 7.5H6.5M9.5 19.5h.01M17 19.5h.01',
    stall: 'M3 9l2-5h14l2 5zM3 9a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0M5 12v8h14v-8',
    cash: 'M3 7h18v10H3zM9.5 12a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0M6.5 12h.01M17.5 12h.01',
    bench: 'M4 9h16M3 13h18M6 13v6M18 13v6M6 9v4M18 9v4',
    shelter: 'M3 10l9-6 9 6M6 8V20M18 8V20M9 15h6',
    wheelchair: 'M8.4 4.5a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0-3.2 0M10 8v6h5.5l2.5 5M10 10.8h4.5M7.3 12.2a5 5 0 1 0 5.9 7',
    elevator: 'M5 3.5h14v17H5zM9 9l3-3 3 3M9 15l3 3 3-3',
    tactile: 'M4 4h16v16H4zM9 9h.01M15 9h.01M9 15h.01M15 15h.01',
    sound: 'M4 9.5h3.5L12 5.5v13l-4.5-4H4zM15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11',
    ticket: 'M4 7h16v3.2a1.8 1.8 0 0 0 0 3.6V17H4v-3.2a1.8 1.8 0 0 0 0-3.6zM14.5 7v10',
    bus: 'M6.5 4h11A2.5 2.5 0 0 1 20 6.5v9a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 15.5v-9A2.5 2.5 0 0 1 6.5 4zM4 11h16M7.5 18v2.5M16.5 18v2.5',
    train: 'M8 3h8a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3zM5 10h14M8.5 21l2-4M15.5 21l-2-4',
    sign: 'M12 3v18M6 5h11l2.5 2.5L17 10H6z',
    bike: 'M2 16.5a3.5 3.5 0 1 0 7 0a3.5 3.5 0 1 0-7 0M15 16.5a3.5 3.5 0 1 0 7 0a3.5 3.5 0 1 0-7 0M5.5 16.5L9 9h6.5l3 7.5M12 16.5L9 9M7.5 6h3M15.5 9l-1-3h2',
    wrench: 'M14.5 4a5 5 0 0 0-4.6 6.9L4 16.8 7.2 20l5.9-5.9A5 5 0 0 0 20 9.5l-3 3-3.5-1-1-3.5 3-3c-.3 0-.6-.1-1-.1z',
    car: 'M5 16v-4l2-5h10l2 5v4zM3.5 16h17M7.5 16v2.5M16.5 16v2.5M7.5 12.5h.01M16.5 12.5h.01',
    parking: 'M5 3.5h14a1.5 1.5 0 0 1 1.5 1.5v14a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19V5A1.5 1.5 0 0 1 5 3.5zM9.5 17V7h3.5a3 3 0 0 1 0 6H9.5',
    bolt: 'M13 3L5 13.5h6L10 21l8-10.5h-6z',
    swing: 'M3 20L7 4h10l4 16M9.5 4v9M14.5 4v9M8 13h3M13 13h3',
    child: 'M9.5 6a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0M7 11l5-1.5 5 1.5M12 9.5V15M9 21l3-6 3 6',
    school: 'M2.5 9.5L12 5l9.5 4.5L12 14zM6.5 11.5V16c3 2.5 8 2.5 11 0v-4.5M21.5 9.5v5',
    ball: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM12 8l3.8 2.8-1.5 4.5H9.7L8.2 10.8z',
    tree: 'M12 3l6 8h-3.5l4 5.5h-13l4-5.5H6zM12 16.5V21',
    swim: 'M3 17c1.5 1.2 3 1.2 4.5 0s3-1.2 4.5 0 3 1.2 4.5 0 3-1.2 4.5 0M8 14V5.5a2 2 0 0 1 4 0M16 14V5.5a2 2 0 0 0-2-2M8 8.5h8M8 11.5h8',
    star: 'M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z',
    brush: 'M4 16l-1 5 5-1L20 8l-4-4zM13 7l4 4',
    bed: 'M3 19V6M3 14h18v5M21 14v-1.5A2.5 2.5 0 0 0 18.5 10H11v4M5.2 11.5a1.8 1.8 0 1 0 3.6 0a1.8 1.8 0 1 0-3.6 0',
    worship: 'M12 3l5 5v13M12 3L7 8v13M4 21h16M10.5 21v-4a1.5 1.5 0 0 1 3 0v4M12 11h.01',
    bin: 'M5 7h14M9 7V4.5h6V7M6.5 7l1 13.5h9l1-13.5M10 11v6M14 11v6',
    briefcase: 'M4 8h16v11H4zM9 8V5.5h6V8M4 13h16',
  };

  // The switches under "On the map", in this order. Earlier groups win where icons would overlap.
  const GROUPS: MapGroup[] = [
    { key: 'events', label: 'Community events', color: 'rose', glyph: 'calendar', note: 'Filtered by About you and Events below' },
    { key: 'toilets', label: 'Toilets', color: 'navy', glyph: 'wc' },
    { key: 'water', label: 'Drinking water', color: 'navy', glyph: 'drop', note: 'Fountains, taps and showers' },
    { key: 'health', label: 'Health & emergency', color: 'tang', glyph: 'cross', note: 'Pharmacies, doctors, hospitals, defibrillators' },
    { key: 'help', label: 'Help & public services', color: 'navy', glyph: 'info', note: 'Social services, libraries, Wi-Fi, post, offices' },
    { key: 'food', label: 'Food & drink', color: 'tang', glyph: 'fork', note: 'Restaurants, cafés, food sharing' },
    { key: 'shops', label: 'Shops & markets', color: 'rose', glyph: 'bag' },
    { key: 'money', label: 'Money', color: 'sun', glyph: 'cash', note: 'Cash machines, banks, money transfer' },
    { key: 'rest', label: 'Benches & shelter', color: 'sun', glyph: 'bench' },
    { key: 'access', label: 'Accessibility', color: 'navy', glyph: 'wheelchair', note: 'Lifts, disabled parking, tactile paving, sound signals' },
    { key: 'transit', label: 'Tickets & stops', color: 'navy', glyph: 'ticket' },
    { key: 'mobility', label: 'Bikes, cars & taxis', color: 'rose', glyph: 'bike', note: 'Bike share, parking, repair, car sharing, charging' },
    { key: 'kids', label: 'Kids & families', color: 'sun', glyph: 'swing', note: 'Playgrounds, daycare, kindergartens' },
    { key: 'learn', label: 'Schools & learning', color: 'navy', glyph: 'school' },
    { key: 'sport', label: 'Sport & parks', color: 'sun', glyph: 'ball' },
    { key: 'culture', label: 'Sights & culture', color: 'rose', glyph: 'star', note: 'Museums, theatres, public art' },
    { key: 'stay', label: 'Places to stay', color: 'rose', glyph: 'bed' },
    { key: 'faith', label: 'Places of worship', color: 'navy', glyph: 'worship' },
    { key: 'recycling', label: 'Recycling', color: 'tang', glyph: 'bin' },
    { key: 'business', label: 'Other businesses', color: 'navy', glyph: 'briefcase' },
  ];

  // category → [group, glyph, rank, label]. Rank 1 (hospitals, stations) to 5 (benches, bike racks): the map keeps the same
  // spacing between icons at every zoom, so where they would crowd the lower ranks wait until you zoom in.
  const CATS: Record<string, PlaceClass> = {
    toilets: ['toilets', 'wc', 2, 'Public toilet'],
    toilets_nette: ['toilets', 'wc', 3, 'Public toilet (Nette Toilette)'], // a restaurant or shop that lets everyone use its toilet
    toilets_customers: ['toilets', 'wc', 4, 'Customer toilet'],
    drinking_water: ['water', 'drop', 3, 'Drinking water'],
    water_point: ['water', 'drop', 3, 'Water point'],
    shower: ['water', 'drop', 4, 'Shower'],
    pharmacy: ['health', 'cross', 2, 'Pharmacy'],
    hospital: ['health', 'hospital', 1, 'Hospital'],
    clinic: ['health', 'cross', 2, 'Clinic'],
    doctors: ['health', 'cross', 3, 'Doctor'],
    doctor: ['health', 'cross', 3, 'Doctor'],
    dentist: ['health', 'tooth', 4, 'Dentist'],
    veterinary: ['health', 'cross', 4, 'Vet'],
    aed: ['health', 'aed', 4, 'Defibrillator (AED)'],
    emergency_phone: ['health', 'phone', 4, 'Emergency phone'],
    blood_donation: ['health', 'heart', 3, 'Blood donation'],
    police: ['help', 'shield', 2, 'Police'],
    library: ['help', 'book', 2, 'Library'],
    wifi: ['help', 'wifi', 3, 'Free Wi-Fi'],
    community_centre: ['help', 'people', 2, 'Community centre'],
    social_facility: ['help', 'people', 3, 'Social services'],
    social_centre: ['help', 'people', 3, 'Social centre'],
    tourist_info: ['help', 'info', 1, 'Tourist information'],
    tourist_information: ['help', 'info', 1, 'Tourist information'],
    employment_agency: ['help', 'briefcase', 3, 'Job centre'],
    ngo: ['help', 'people', 4, 'NGO'],
    charity: ['help', 'heart', 4, 'Charity'],
    give_box: ['help', 'heart', 4, 'Give box'],
    child_protection: ['help', 'people', 3, 'Child and family protection'],
    youth_services: ['help', 'people', 3, 'Youth services'],
    elderly_care: ['help', 'people', 4, 'Elderly care'],
    townhall: ['help', 'building', 2, 'Town hall'],
    embassy: ['help', 'building', 4, 'Embassy'],
    government: ['help', 'building', 3, 'Government office'],
    city_office: ['help', 'building', 3, 'City office'],
    cantonal_office: ['help', 'building', 4, 'Cantonal office'],
    federal_office: ['help', 'building', 4, 'Federal office'],
    courthouse: ['help', 'building', 4, 'Courthouse'],
    polling_station: ['help', 'building', 4, 'Polling station'],
    post_office: ['help', 'mail', 2, 'Post office'],
    post_box: ['help', 'mail', 5, 'Post box'],
    public_bookcase: ['help', 'book', 4, 'Public bookcase'],
    internet_cafe: ['help', 'wifi', 3, 'Internet café'],
    phone_charging: ['help', 'plug', 3, 'Phone charging'],
    telephone: ['help', 'phone', 5, 'Public phone'],
    lockers: ['help', 'lock', 4, 'Lockers'],
    fire_station: ['help', 'building', 4, 'Fire station'],
    food_sharing: ['food', 'heart', 2, 'Food sharing'],
    bench: ['rest', 'bench', 5, 'Bench'],
    shelter: ['rest', 'shelter', 5, 'Shelter'],
    waiting_room: ['rest', 'shelter', 4, 'Waiting room'],
    atm: ['money', 'cash', 3, 'Cash machine (ATM)'],
    bank: ['money', 'cash', 3, 'Bank'],
    bureau_de_change: ['money', 'cash', 3, 'Currency exchange'],
    money_transfer: ['money', 'cash', 3, 'Money transfer'],
    supermarket: ['shops', 'cart', 2, 'Supermarket'],
    convenience: ['shops', 'cart', 3, 'Convenience store'],
    grocery: ['shops', 'cart', 3, 'Grocery'],
    marketplace: ['shops', 'stall', 3, 'Market'],
    market: ['shops', 'stall', 3, 'Market'],
    info_stand_kiosk: ['shops', 'stall', 5, 'Info stand / kiosk'],
    place_of_worship: ['faith', 'worship', 3, 'Place of worship'],
    cemetery: ['faith', 'worship', 3, 'Cemetery'],
    crematorium: ['faith', 'worship', 4, 'Crematorium'],
    playground: ['kids', 'swing', 3, 'Playground'],
    baby_changing: ['kids', 'child', 4, 'Baby changing'],
    kindergarten: ['kids', 'child', 4, 'Kindergarten'],
    childcare: ['kids', 'child', 4, 'Daycare'],
    children_services: ['kids', 'child', 3, 'Children’s services'],
    school: ['learn', 'school', 3, 'School'],
    secondary_school: ['learn', 'school', 3, 'Secondary school'],
    vocational_school: ['learn', 'school', 3, 'Vocational school'],
    university: ['learn', 'school', 2, 'University'],
    college: ['learn', 'school', 3, 'College'],
    language_school: ['learn', 'school', 3, 'Language school'],
    bicycle_parking: ['mobility', 'bike', 5, 'Bike parking'],
    bicycle_rental: ['mobility', 'bike', 4, 'Bike rental'],
    bike_share: ['mobility', 'bike', 4, 'Bike share (Velospot)'],
    bicycle_station: ['mobility', 'bike', 3, 'Bike station'],
    bicycle_repair_station: ['mobility', 'wrench', 5, 'Bike repair station'],
    bicycle_pump: ['mobility', 'wrench', 5, 'Bike pump'],
    bicycle_tube_vending: ['mobility', 'wrench', 5, 'Bike tube vending machine'],
    car_sharing: ['mobility', 'car', 5, 'Car sharing'],
    car_rental: ['mobility', 'car', 4, 'Car rental'],
    taxi: ['mobility', 'car', 4, 'Taxi rank'],
    parking: ['mobility', 'parking', 4, 'Parking'],
    parking_garage: ['mobility', 'parking', 3, 'Car park'],
    fuel: ['mobility', 'car', 4, 'Petrol station'],
    ev_charging: ['mobility', 'bolt', 5, 'EV charging'],
    charging_station: ['mobility', 'bolt', 5, 'EV charging'],
    ev_parking: ['mobility', 'bolt', 5, 'EV parking'],
    ticket_machine: ['transit', 'ticket', 5, 'Ticket machine'],
    ticket_validator: ['transit', 'ticket', 5, 'Ticket validator'],
    transit_stop: ['transit', 'bus', 5, 'Bus or tram stop'],
    railway_station: ['transit', 'train', 1, 'Railway station'],
    platform_sector_sign: ['transit', 'sign', 5, 'Platform sector sign'],
    station_inventory: ['transit', 'sign', 5, 'Station facilities'],
    recycling: ['recycling', 'bin', 5, 'Recycling'],
    recycling_mobile: ['recycling', 'bin', 5, 'Mobile recycling point'],
    recycling_centre: ['recycling', 'bin', 3, 'Recycling centre'],
    disabled_parking: ['access', 'wheelchair', 5, 'Disabled parking'],
    disability_services: ['access', 'wheelchair', 3, 'Disability services'],
    elevator: ['access', 'elevator', 4, 'Lift'],
    tactile_paving: ['access', 'tactile', 5, 'Tactile paving'],
    tactile_safety_line: ['access', 'tactile', 5, 'Tactile safety line'],
    acoustic_crossing_signal: ['access', 'sound', 5, 'Acoustic crossing signal'],
    acoustic_info_box: ['access', 'sound', 5, 'Talking information point'],
    sports: ['sport', 'ball', 3, 'Sports facility'],
    sports_centre: ['sport', 'ball', 3, 'Sports centre'],
    swimming_pool: ['sport', 'swim', 2, 'Swimming pool'],
    water_park: ['sport', 'swim', 2, 'Water park'],
    ice_rink: ['sport', 'ball', 2, 'Ice rink'],
    park: ['sport', 'tree', 3, 'Park'],
    garden: ['sport', 'tree', 4, 'Garden'],
    nature_reserve: ['sport', 'tree', 3, 'Nature reserve'],
    allotments: ['sport', 'tree', 5, 'Allotment gardens'],
    pitch: ['sport', 'ball', 5, 'Sports pitch'],
    public_art: ['culture', 'brush', 5, 'Public art'],
    artwork: ['culture', 'brush', 5, 'Artwork'],
    memorial: ['culture', 'star', 5, 'Memorial'],
    milestone: ['culture', 'star', 5, 'Milestone'],
    attraction: ['culture', 'star', 2, 'Sight'],
    exhibition_centre: ['culture', 'star', 3, 'Exhibition centre'],
    coworking: ['business', 'briefcase', 4, 'Coworking space'],
  };
  // Raw categories that read better with another label
  const LABELS: Record<string, string> = {
    fast_food: 'Fast food', ice_cream: 'Ice cream', arts_centre: 'Arts centre', events_venue: 'Event venue',
    guest_house: 'Guest house', camp_site: 'Campsite', caravan_site: 'Caravan site', second_hand: 'Second-hand shop',
    doityourself: 'DIY store', department_store: 'Department store', dry_cleaning: 'Dry cleaner', it: 'IT services',
    fitness_centre: 'Gym', sports_hall: 'Sports hall', estate_agent: 'Estate agent', yes: 'Place',
  };
  const PLACE_GROUP: Record<string, [MapGroupKey, string, PlaceRank]> = { // places.json "group" → map group, glyph, rank
    food_drink: ['food', 'fork', 4], shopping: ['shops', 'bag', 5], lodging: ['stay', 'bed', 3],
    attractions_culture: ['culture', 'star', 4], leisure_sport: ['sport', 'ball', 4],
    services: ['business', 'briefcase', 5], health: ['health', 'cross', 4], worship: ['faith', 'worship', 3],
  };
  const humanize = (c: string) => {
    const s = String(c).split(/[;,]/)[0].replace(/_/g, ' ').trim();
    return s.charAt(0).toUpperCase() + s.slice(1);
  };

  // → [group, glyph, rank, label]
  function classify(category: string, placeGroup?: string): PlaceClass {
    if (CATS[category]) return CATS[category];
    const label = LABELS[category] || humanize(category);
    if (placeGroup === 'food_drink') {
      const glyph = /^(cafe|coffee|tea)$/.test(category) ? 'cup'
        : /^(bar|pub|nightclub|wine|alcohol|beverages|brewery)$/.test(category) ? 'glass'
        : category === 'ice_cream' ? 'icecream' : 'fork';
      return ['food', glyph, 4, label];
    }
    if (placeGroup === 'shopping') {
      const everyday = /^(chemist|second_hand|charity|kiosk|bakery|department_store|mall|mobile_phone|newsagent)$/.test(category);
      return ['shops', 'bag', everyday ? 4 : 5, label];
    }
    if (placeGroup === 'attractions_culture') {
      const major = /^(museum|theatre|cinema|castle|zoo|gallery|arts_centre|viewpoint|events_venue|conference_centre)$/.test(category);
      const minor = /^(building|monument|citywalls|bridge|tomb|locomotive|ruins|archaeological_site|city_gate|yes)$/.test(category);
      return ['culture', 'star', major ? 3 : minor ? 5 : 4, label];
    }
    if (placeGroup === 'leisure_sport') {
      return ['sport', /pool|water|sauna/.test(category) ? 'swim' : 'ball', 4, label];
    }
    if (placeGroup === 'services') {
      if (/school|educational|university|college/.test(category)) return ['learn', 'school', 3, label];
      if (/^(administrative|administration|quango|government)$/.test(category)) return ['help', 'building', 3, label];
      if (/^(association|foundation|union|religion|cooperative|organization)$/.test(category)) return ['help', 'people', 5, label];
      if (/^(financial|financial_services|financial_advisor)$/.test(category)) return ['money', 'cash', 5, label];
    }
    const g = PLACE_GROUP[placeGroup!] || PLACE_GROUP.services;
    return [g[0], g[1], g[2], label];
  }

  // Search words (German, French, everyday English) → the words in the labels above, so "apotheke", "wc" or
  // "brunnen" find the nearest pharmacy, toilet or drinking fountain
  const SEARCH_ALIASES = {
    wc: 'toilet', loo: 'toilet', bathroom: 'toilet', restroom: 'toilet', washroom: 'toilet', lavatory: 'toilet',
    toilette: 'toilet', toiletten: 'toilet', klo: 'toilet', toilettes: 'toilet',
    apotheke: 'pharmacy', pharmacie: 'pharmacy', farmacia: 'pharmacy', drugstore: 'pharmacy', drogerie: 'chemist',
    spital: 'hospital', krankenhaus: 'hospital', hopital: 'hospital', ospedale: 'hospital', notfall: 'emergency',
    arzt: 'doctor', arztin: 'doctor', doktor: 'doctor', gp: 'doctor', medecin: 'doctor', zahnarzt: 'dentist',
    defi: 'defibrillator', defibrillator: 'defibrillator',
    brunnen: 'drinking water', trinkwasser: 'drinking water', fountain: 'drinking water', fontaine: 'drinking water',
    wasser: 'water', dusche: 'shower',
    bancomat: 'atm', geldautomat: 'atm', cashpoint: 'atm', geld: 'money',
    polizei: 'police', bibliothek: 'library', bibliotheque: 'library', postamt: 'post office', briefkasten: 'post box',
    wlan: 'wi fi', wifi: 'wi fi', internet: 'wi fi',
    supermarkt: 'supermarket', lebensmittel: 'grocery', einkaufen: 'shop',
    kirche: 'worship', church: 'worship', mosque: 'worship', moschee: 'worship', synagogue: 'worship', synagoge: 'worship',
    temple: 'worship', tempel: 'worship',
    spielplatz: 'playground', kita: 'daycare', krippe: 'daycare',
    velo: 'bike', fahrrad: 'bike', bicycle: 'bike', cycle: 'bike',
    parkplatz: 'parking', parkhaus: 'car park', ladestation: 'charging', charger: 'charging',
    aufzug: 'lift', elevator: 'lift', sitzbank: 'bench',
    essen: 'food', kaffee: 'cafe', coffee: 'cafe', beiz: 'restaurant', foodsharing: 'food sharing', unterkunft: 'stay',
    billet: 'ticket', billett: 'ticket', fahrkarte: 'ticket', entsorgung: 'recycling', altglas: 'recycling',
    hilfe: 'help', beratung: 'social', sozial: 'social', schliessfach: 'lockers',
  };

  window.MAP_LAYERS = { COLORS, GLYPHS, GROUPS, SEARCH_ALIASES, classify };
})();
