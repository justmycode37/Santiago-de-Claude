// Libraries the page loads at run time from a CDN. Only their types come from node_modules.
import type * as MapLibre from 'maplibre-gl';
import type * as Three from 'three';

declare global {
  /** MapLibre GL JS 4.7.1, from the <script> tag in index.html. As a type: `maplibregl.Map`, `maplibregl.Marker`, … */
  export import maplibregl = MapLibre;
  /** Types of three.js 0.170 objects: `THREE.Mesh`, `THREE.Vector3`, … The module itself is loaded by station3d.ts. */
  export import THREE = Three;
  /** The three.js module object itself, as station3d.ts loads it and hands it on. */
  type ThreeModule = typeof import('three');
}
