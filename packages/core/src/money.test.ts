import { describe, expect, it } from "vitest";
import {
  currencyExponent,
  formatMoney,
  isMinorUnits,
  isSupportedCurrency,
  parsePayPalValue,
  percentOfMinor,
  toPayPalValue,
} from "./money.js";

describe("currencies", () => {
  it("knows PayPal-supported currencies and rejects others", () => {
    for (const c of ["USD", "GBP", "CAD", "EUR", "JPY"]) expect(isSupportedCurrency(c)).toBe(true);
    // NGN is not a PayPal transaction currency: Nigerian players pay in the plan currency.
    for (const c of ["NGN", "usd", "XXX", ""]) expect(isSupportedCurrency(c)).toBe(false);
  });

  it("uses PayPal's decimal rules, not plain ISO ones", () => {
    expect(currencyExponent("USD")).toBe(2);
    expect(currencyExponent("JPY")).toBe(0);
    // ISO says 2 decimals, PayPal accepts none.
    expect(currencyExponent("HUF")).toBe(0);
    expect(currencyExponent("TWD")).toBe(0);
  });
});

describe("isMinorUnits", () => {
  it("accepts non-negative safe integers only", () => {
    expect(isMinorUnits(0)).toBe(true);
    expect(isMinorUnits(500)).toBe(true);
    expect(isMinorUnits(5.5)).toBe(false);
    expect(isMinorUnits(-1)).toBe(false);
    expect(isMinorUnits(Number.NaN)).toBe(false);
    expect(isMinorUnits(2 ** 53)).toBe(false);
  });
});

describe("toPayPalValue", () => {
  it("formats minor units as PayPal amount strings", () => {
    expect(toPayPalValue(500, "USD")).toBe("5.00");
    expect(toPayPalValue(5, "USD")).toBe("0.05");
    expect(toPayPalValue(0, "USD")).toBe("0.00");
    expect(toPayPalValue(123456, "GBP")).toBe("1234.56");
    expect(toPayPalValue(500, "JPY")).toBe("500");
  });

  it("throws on floats, negatives and unsupported currencies", () => {
    expect(() => toPayPalValue(5.5, "USD")).toThrow(RangeError);
    expect(() => toPayPalValue(-1, "USD")).toThrow(RangeError);
    expect(() => toPayPalValue(500, "NGN")).toThrow(RangeError);
  });
});

describe("parsePayPalValue", () => {
  it("parses PayPal amount strings without using floats", () => {
    expect(parsePayPalValue("5.00", "USD")).toBe(500);
    expect(parsePayPalValue("0.05", "USD")).toBe(5);
    expect(parsePayPalValue("5", "USD")).toBe(500);
    expect(parsePayPalValue("5.1", "USD")).toBe(510);
    expect(parsePayPalValue("1234.56", "GBP")).toBe(123456);
    expect(parsePayPalValue("500", "JPY")).toBe(500);
    // 0.1 + 0.2 style float errors must not happen
    expect(parsePayPalValue("0.29", "USD")).toBe(29);
  });

  it("rejects malformed values", () => {
    for (const v of ["", "abc", "5.001", "-5.00", "5.", ".5", "1e3", " 5.00"]) {
      expect(parsePayPalValue(v, "USD")).toBeNull();
    }
    expect(parsePayPalValue("5.00", "JPY")).toBeNull();
    expect(parsePayPalValue("5.00", "NGN")).toBeNull();
  });

  it("round-trips with toPayPalValue", () => {
    for (const n of [0, 1, 9, 10, 99, 100, 101, 999999]) {
      expect(parsePayPalValue(toPayPalValue(n, "USD"), "USD")).toBe(n);
    }
  });
});

describe("percentOfMinor", () => {
  it("rounds down so nobody is charged more than the rule says", () => {
    expect(percentOfMinor(500, 50)).toBe(250);
    expect(percentOfMinor(333, 50)).toBe(166);
    expect(percentOfMinor(999, 33)).toBe(329);
    expect(percentOfMinor(500, 100)).toBe(500);
  });

  it("throws on invalid input", () => {
    expect(() => percentOfMinor(500, 0)).toThrow(RangeError);
    expect(() => percentOfMinor(500, 101)).toThrow(RangeError);
    expect(() => percentOfMinor(500, 12.5)).toThrow(RangeError);
    expect(() => percentOfMinor(5.5, 50)).toThrow(RangeError);
  });
});

describe("formatMoney", () => {
  it("formats for display in the given locale", () => {
    expect(formatMoney(500, "USD", "en-US")).toBe("$5.00");
    expect(formatMoney(1250, "GBP", "en-GB")).toBe("£12.50");
    expect(formatMoney(500, "JPY", "en-US")).toBe("¥500");
  });
});
