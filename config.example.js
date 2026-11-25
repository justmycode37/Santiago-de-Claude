// Copy this file to config.js (it is not committed) to change the settings below.
// Without config.js the search uses OpenStreetMap, which needs no key, and live data comes from the hosted engine.
//
// googlePlacesKey: switches the place search to Google Places.
// The key: Google Cloud console → enable "Places API (New)" → Credentials → API key. Restrict it to
// "Places API (New)" and to your site's address (HTTP referrers), because the page sends it from the browser.
//
// kanteUrl: the Kante engine journeys, departure boards and live data come from (see docs/journeys.md). Leave it
// out for the hosted engine (https://kante.omniroute.app), set e.g. 'http://127.0.0.1:8080' for one on this
// machine, or '' to switch it off (the app then says that journeys and departures are unavailable; the map,
// search, events and places keep working).
// For a quick test without config.js, add ?kante=http://127.0.0.1:8080 to the page address (only an engine on this
// machine is accepted that way; any other ?kante=<url> is ignored); ?kante=off or ?engine=off switches it off.
// engine.js, the engine's one client, reads it.
//
// formationKey: an opentransportdata.swiss key for the Train Formation Service, only for a test on your own machine:
// the 3D station view then asks the service itself for a train's coaches, instead of the engine (which keeps its
// key on the server). Never on a public site: the page sends it from the browser. docs/train-formation.md
window.APP_CONFIG = {
  googlePlacesKey: '',
  // kanteUrl: 'http://127.0.0.1:8080',
};
