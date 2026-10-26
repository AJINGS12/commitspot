/**
 * Money helpers. Amounts are integer minor units everywhere in CommitSpot (rule 9);
 * PayPal's decimal strings exist only at the API boundary.
 *
 * These functions throw RangeError on invalid input: a bad amount here is a
 * programming error, not a user error, and must never be silently "fixed".
 */
import type { CurrencyCode } from "./types.js";

/**
 * Currencies PayPal accepts for payments, with PayPal's decimal places.
 * HUF and TWD have 2 decimals in ISO 4217 but PayPal accepts no decimals for them.
 */
export const PAYPAL_CURRENCIES: Readonly<Record<string, number>> = Object.freeze({
  AUD: 2, BRL: 2, CAD: 2, CHF: 2, CNY: 2, CZK: 2, DKK: 2, EUR: 2, GBP: 2, HKD: 2,
  HUF: 0, ILS: 2, JPY: 0, MXN: 2, MYR: 2, NOK: 2, NZD: 2, PHP: 2, PLN: 2, SEK: 2,
  SGD: 2, THB: 2, TWD: 0, USD: 2,
});

export function isSupportedCurrency(code: string): code is CurrencyCode {
  return Object.hasOwn(PAYPAL_CURRENCIES, code);
}

export function currencyExponent(currency: CurrencyCode): number {
  const exp = PAYPAL_CURRENCIES[currency];
  if (exp === undefined) throw new RangeError(`Currency not supported by PayPal: ${currency}`);
  return exp;
}

export function isMinorUnits(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function assertMinorUnits(value: number): void {
  if (!isMinorUnits(value)) throw new RangeError(`Not an integer amount of minor units: ${value}`);
}

/** 500 USD-cents → "5.00". */
export function toPayPalValue(amountMinor: number, currency: CurrencyCode): string {
  assertMinorUnits(amountMinor);
  const exp = currencyExponent(currency);
  if (exp === 0) return String(amountMinor);
  const digits = String(amountMinor).padStart(exp + 1, "0");
  return `${digits.slice(0, -exp)}.${digits.slice(-exp)}`;
}

/** "5.00" USD → 500. Returns null for anything that is not a plain non-negative decimal. */
export function parsePayPalValue(value: string, currency: CurrencyCode): number | null {
  if (!isSupportedCurrency(currency)) return null;
  const exp = currencyExponent(currency);
  const pattern = exp === 0 ? /^(\d+)$/ : new RegExp(`^(\\d+)(?:\\.(\\d{1,${exp}}))?$`);
  const match = pattern.exec(value);
  if (!match) return null;
  const whole = match[1] ?? "0";
  const fraction = (match[2] ?? "").padEnd(exp, "0");
  const minor = Number(whole + fraction);
  return isMinorUnits(minor) ? minor : null;
}

/** `percent` (integer 1–100) of an amount, rounded down so nobody is overcharged. */
export function percentOfMinor(amountMinor: number, percent: number): number {
  assertMinorUnits(amountMinor);
  if (!Number.isInteger(percent) || percent < 1 || percent > 100) {
    throw new RangeError(`percent must be an integer from 1 to 100, got ${percent}`);
  }
  return Math.floor((amountMinor * percent) / 100);
}

/** Display only, e.g. "$5.00" or "£12.50". Never parse this back. */
export function formatMoney(amountMinor: number, currency: CurrencyCode, locale = "en-US"): string {
  const exp = currencyExponent(currency);
  const formatter = new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: exp,
    maximumFractionDigits: exp,
  });
  // A decimal string, not a number, so the amount never passes through a float.
  return formatter.format(toPayPalValue(amountMinor, currency) as `${number}`);
}
