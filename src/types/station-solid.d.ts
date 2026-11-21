// The continuous 3D view of a station's inside (station3d-solid.html, docs/station3d-solid.md): which stations have
// its companion file. stations3d/solid-index.js is written by tools/station3d_solid.py and loaded on demand.

/** stations3d/solid-index.js: model key → its companion file (stations3d/<key>.solid.js). */
declare var STATION3D_SOLID_INDEX: Record<string, { file: string }> | undefined;
