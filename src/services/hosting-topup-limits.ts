/** Repeat account top-up bounds in USD cents. The minimum is the approved funding floor (US$21, equal to ONBOARDING_MIN_FUNDING_CENTS);
 * no smaller offer exists. The maximum is only the processor/ledger technical bound, not a promised product tier. */
export const TOPUP_MIN_CENTS = 2100;
export const TOPUP_MAX_CENTS = 1_000_000;
