// What src/onboarding.ts puts on window: the introduction for a first visit (docs/onboarding.md).

interface OnboardingApi {
  /** Shows the introduction (again). Does nothing while it is open. */
  open(): void;
  isOpen(): boolean;
}

