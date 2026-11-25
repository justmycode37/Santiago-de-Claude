# Proposal: learning from walked GPS tracks

Status: proposal only. Nothing is collected; nothing will be built without the owner's go-ahead.

## Why

The reference walks (`kante/tools/refwalks`) are checked on aerial images, which cannot show a closed gate, a
kerb, a footpath under trees or where people actually cross. The app already follows a walker's GPS during a
trip (to say when they have arrived). Where many walkers leave the drawn walk the same way, the map or the
router is probably wrong there.

## What would be collected

Only from people who opt in, separately from the app's other settings, and can withdraw at any time:

- the walk the engine drew (its edges, not coordinates), and where the walker left it and joined it again;
- in between, the walked line snapped to the network, never raw fixes; no times of day finer than the hour, no
  trip ends: the first and last 150 m of every walk are cut (they would point at a home or a workplace);
- no account, no device id: a per-walk random id only.

## How it would be used

Aggregated per network edge and junction: how often walkers take an edge the router avoided, or avoid one it took
(at least k = 20 different walks before anything counts; nothing below that is stored past a week). The output
is a list of places for a person to look at (a missing footway, a crossing used that is not mapped, a gate shut at
night), fixed in OpenStreetMap or as a rule, and checked against the reference walks. Never per-person profiles.

## What it needs before anything is built

- a privacy review (Swiss revDSG / GDPR): purpose, consent text, retention (raw deviations deleted after the
  weekly aggregate), the hosting location, a data protection impact assessment;
- the app's consent screen and a setting to withdraw (and delete what was sent);
- a decision on who may see the aggregates.

Question for the owner: go ahead with a privacy design along these lines, or not at all?
