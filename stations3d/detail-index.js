// Which station models have a detail scene (stations3d/DETAIL.md), and where it lies (bbox of its area, model metres).
// Tiny, loaded with the model; the scene itself is loaded only when a walk or the eye comes near.
window.STATION3D_DETAIL_INDEX = { bern: [
  { id: "bern", file: "stations3d/bern.detail.js", bbox: [-150,-338,-38,-160] },
  { id: "bern.bahnhofplatz", file: "stations3d/bern.bahnhofplatz.detail.js", bbox: [30,-175,170,-33] }
] };
