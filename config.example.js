// Copy this file to config.js (it is not committed) to switch the place search to Google Places.
// Without config.js the search uses OpenStreetMap, which needs no key.
//
// The key: Google Cloud console → enable "Places API (New)" → Credentials → API key. Restrict it to
// "Places API (New)" and to your site's address (HTTP referrers), because the page sends it from the browser.
window.APP_CONFIG = {
  googlePlacesKey: '',
};
