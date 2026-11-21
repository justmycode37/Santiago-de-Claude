// Globals that have no real type yet. Whoever types the script that makes one moves its declaration into
// that script's own file in src/types/ with the real type, and deletes the line here.

declare var EARLY_GEO: any;       // the first <script> in index.html
declare var EARLY_STYLE: any;
declare var BUILD: any;           // version.js, written when the site is published
/** CommonJS `module`, when a script is loaded by Node for a test (never in the browser). */
declare var module: { exports: unknown } | undefined;
