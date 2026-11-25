// Libraries the page loads at run time from a CDN. Only their types come from node_modules.
/// <reference types="geojson" />
import type * as MapLibre from 'maplibre-gl';
import type * as Three from 'three';

declare global {
  /** Types of MapLibre GL JS 6 (`maplibregl.Map`, `maplibregl.Marker`, …). At run time a module imports it
      (`import * as maplibregl from 'maplibre-gl'`), through the import map in index.html. */
  export import maplibregl = MapLibre;
  /** Types of three.js 0.170 objects: `THREE.Mesh`, `THREE.Vector3`, … The module itself is imported by
      station3d-solid.ts, through the import map in index.html. */
  export import THREE = Three;
}
