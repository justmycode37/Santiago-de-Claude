// What src/onboarding.ts puts on window: the introduction for a first visit (docs/onboarding.md).

interface OnboardingApi {
  /** Shows the introduction (again). Does nothing while it is open. */
  open(): void;
  isOpen(): boolean;
}

/** Missing when onboarding.js could not be loaded: the app then starts without the introduction. */
declare var ONBOARDING: OnboardingApi | undefined;
