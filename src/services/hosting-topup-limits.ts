/** Repeat account top-up bounds in USD cents (the checkout-order ledger range). Shared by the Stripe and Lightning paths. */
export const TOPUP_MIN_CENTS = 500;
export const TOPUP_MAX_CENTS = 1_000_000;
