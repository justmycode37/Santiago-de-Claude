# TODO

## Move the Google Places key behind a proxy

Today the Google Places key sits in `config.js` and the browser sends it straight to Google
(`places.js`, header `X-Goog-Api-Key`), so anyone using the site can read it.

- Add a Vercel function `api/places.js`. It reads the key from the `GOOGLE_PLACES_KEY`
  environment variable (Vercel → Project → Settings → Environment Variables) and passes the
  Text Search request on to Google.
- Change `places.js` to call `/api/places` instead of Google, and drop `googlePlacesKey`
  from `config.example.js`.
- Limit what the function accepts: only Text Search, only the field mask we use, and a cap
  on how many requests it answers.
- Keep the OpenStreetMap search as the fallback when the variable is not set.
- In Google Cloud, restrict the key to "Places API (New)" and set a daily quota.

The other keys stay where they are: the opentransportdata.swiss keys belong to the Kante
engine (`kante/data/secrets/otd.json` or `KANTE_OTD_KEY`), and the Mapillary token is only
read by `tools/build_stop_images.py`. Neither is used by the Vercel deploy, so they do not need
GitHub secrets.
