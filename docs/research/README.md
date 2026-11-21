# Research summary: what newcomers need and where the data is

Gathered 21 Nov 2026 by four research agents. Details, sources and VERIFIED/UNVERIFIED marks are in:
[user-needs.md](user-needs.md) · [amenities-sources.md](../amenities-sources.md) · [admin-services.md](admin-services.md) · [basic-needs.md](basic-needs.md)

## What to put on the map, and where it comes from

| Layer | Source | How | Notes |
|---|---|---|---|
| Stop edges, accessibility (PRM), station toilets | ATLAS (already in `data/`) | done | core "right side" feature |
| Toilets, drinking water, pharmacies, doctors, clinics, hospitals, libraries, free WiFi, ATMs, cheap supermarkets | OSM | one Overpass query → static GeoJSON | use `https://overpass.osm.ch/api/interpreter`; overpass-api.de timed out. ODbL credit in footer |
| Embassies (129), post offices (23), police (12) | OSM `office=diplomatic`, `amenity=post_office`, `amenity=police` | same query | Swiss Post open data portal is gone |
| ~20 key offices (MIDI, EMF, FMR, isa, asylum centre (BAZ), job centres (RAV), Sozialdienst, SVSA…) | hand-curated | `offices.json` | store a link to each office's hours page, not the hours |
| Shelters, free meals, showers, legal/migration help (~50) | hand-curated from 2 PDFs (city "uf dr Gass" 01.26, Kath. Kirche migration directory 2025) | `services.json` with `last_verified` | **no open dataset exists**; OSM has 3 shelters, 0 food banks. Ask the city about licence |
| Domestic violence | hotlines only | hard-coded | shelter addresses are secret, never map them |
| Bike sharing (Velospot, 295 stations) | GBFS v3 via mobidata-bw | live, optional | licence unconfirmed |
| Ticket machines, Libero zones | data.sbb.ch `billetautomat`, `tarifverbundkarte` | optional | zones are municipality polygons, need mapping to Libero zone numbers |
| Sports facilities | Stadt Bern Sportanlagen WFS | optional | needs browser User-Agent |

**Missing everywhere:** on-duty pharmacy (Notfallapotheke), opening hours, lift status, free events, phone charging. Link out to these instead.

## Pitch-ready evidence (verified)
- 1.17 million people were caught without a valid ticket in 2024. A first fine is **CHF 100**, not the old CHF 90.
- City of Bern has 37,004 foreign residents. Ukrainians are the 3rd-largest group, and Eritreans grew from 25 to 943 since 2000. Nationally, top asylum origins in 2025 were Afghanistan and Eritrea, and 71,762 people hold Status S.
- Neither official SEM newcomer app covers public transport.
- **Not backed by evidence yet:** the wrong-side, terminus-confusion and request-stop pain points. Validate them in morning interviews (questions in user-needs.md).

## Languages to support first
Tigrinya, Arabic, Dari/Farsi, Ukrainian, plus German, English, French. Bern.ch already publishes in 16 languages, which you can link to.
