// Cent rounding for billing figures.
//
// Every invoice freezes its money at issue time as
// `amount = round2(baseAmount * percent / 100)`, so a target billed in
// instalments can miss its contract value by up to half a rappen per invoice
// (33.33% + 33.33% + 33.34% of CHF 4'095.00 adds up to CHF 4'094.99).
//
// Once the invoiced share reaches 100% that leftover is NOT an open balance —
// it is rounding dust. It can never be worked off either: the create path
// refuses anything under 0.005% and every amount it writes is cent-rounded.
// A fully billed target therefore closes at exactly 0.00, never at 0.01
// (Vorgabe 19.08.2026).
//
// The franc slack is deliberately tight. A gap wider than a few rappen is a
// REAL remainder — the order total grew after the invoices were issued — and
// must stay visible instead of being swallowed here.
//
// Frontend mirror: offitec-frontend/src/lib/orderBillingTotals.ts — keep in sync.

/** Percentage points below 100 that still count as "fully billed". */
export const FULLY_BILLED_EPSILON = 0.005;

/**
 * Franc gap that can only be cent-rounding dust: half a rappen per invoice,
 * across ten instalments (MAX_PAYMENT_STAGES is 12, free-form billing rarely
 * goes past a handful).
 */
export const CENT_ROUNDING_SLACK = 0.05;

export const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

/**
 * True when the invoiced share has reached 100% and the francs are within
 * rounding dust of the contract value.
 *
 * `billedPercent` is required: without it a small order (base CHF 0.08, half
 * of it invoiced) would look "fully billed" purely because its franc gap is
 * small.
 */
export const isFullyBilled = (billedPercent: number, baseAmount: number, billedAmount: number) =>
    Number.isFinite(billedPercent)
    && round2(billedPercent) >= 100 - FULLY_BILLED_EPSILON
    && Math.abs(round2(baseAmount - billedAmount)) <= CENT_ROUNDING_SLACK;

/**
 * The open balance of a target — 0 once it is fully billed, otherwise the
 * plain franc difference. Not clamped at zero for over-invoiced targets: the
 * excess belongs on screen, not swallowed.
 */
export const openAmount = (billedPercent: number, baseAmount: number, billedAmount: number) =>
    isFullyBilled(billedPercent, baseAmount, billedAmount) ? 0 : round2(baseAmount - billedAmount);
