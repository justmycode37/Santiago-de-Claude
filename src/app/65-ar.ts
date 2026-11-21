// ---- AR camera (arview.js, loaded on first use): on the next step of a journey, look around with the camera to find
//      the stop and its boarding edge, the vehicle, and the way there. Its decisions are in arcore.js (src/arcore.ts).
//      The button sits next to "3D view" in the step's `step-views` row (walk and change steps) and in the "Where to
//      stand" card of a ride. ----

/** The AR button for a journey step, or null. None yet: the camera screen comes in a later change. */
function arStepButton(_st: JourneyStep): HTMLElement | null {
  return null;
}
