/**
 * Exact Monetary & Quantity Arithmetic Engine (Zero JavaScript Floating-Point Drift)
 *
 * All base accounting currency amounts in Holo Apex Offline AI are stored in integer
 * Iranian Rials (IRR). Foreign currencies and inventory weights use scaled fixed-point
 * integer math (`Math.round(x * scale)`) and BigInt intermediates so arithmetic never
 * suffers IEEE-754 drift (e.g. 0.1 + 0.2 !== 0.3 or large 15-digit Rial multiplications).
 */

const QTY_SCALE = 10_000; // 4 decimal places for weighbridge kg accuracy

export function toExactIrr(value: number | string | null | undefined): number {
  if (value === null || value === undefined || value === '') return 0;
  const n =
    typeof value === 'string'
      ? Number(
          value
            .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 1776))
            .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 1632))
            .replace(/٫/g, '.')
            .replace(/[,٬،\s]/g, '')
            .trim()
        )
      : Number(value);
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? -Math.round(-n) : Math.round(n);
}

export function addIrr(...values: number[]): number {
  let acc = 0n;
  for (const v of values) {
    acc += BigInt(toExactIrr(v));
  }
  return Number(acc);
}

export function subIrr(a: number, b: number): number {
  return Number(BigInt(toExactIrr(a)) - BigInt(toExactIrr(b)));
}

export function sumIrr(values: readonly number[]): number {
  let acc = 0n;
  for (const v of values) {
    acc += BigInt(toExactIrr(v));
  }
  return Number(acc);
}

/**
 * Multiplies a quantity (up to 4 decimal places) by an integer IRR unit price
 * using BigInt fixed-point scaling, then rounds half-away-from-zero to exact integer IRR.
 */
export function mulQtyByIrr(qty: number, unitPriceIrr: number): number {
  if (!Number.isFinite(qty) || !Number.isFinite(unitPriceIrr)) return 0;
  const scaledQty = BigInt(Math.round(qty * QTY_SCALE));
  const price = BigInt(toExactIrr(unitPriceIrr));
  const product = scaledQty * price;
  const scale = BigInt(QTY_SCALE);
  const half = scale / 2n;
  if (product >= 0n) {
    return Number((product + half) / scale);
  }
  return Number((product - half) / scale);
}

/**
 * Applies a percentage rate (e.g. 10 for 10%, or 0.10 when `rateIsDecimal = true`)
 * to an integer IRR base amount using exact BigInt basis-point scaling.
 */
export function percentOfIrr(baseIrr: number, rate: number, rateIsDecimal = false): number {
  if (!Number.isFinite(baseIrr) || !Number.isFinite(rate)) return 0;
  const pct = rateIsDecimal ? rate * 100 : rate;
  const basisPoints = BigInt(Math.round(pct * 10_000)); // 100% = 1,000,000
  const base = BigInt(toExactIrr(baseIrr));
  const denom = 1_000_000n;
  const half = denom / 2n;
  const num = base * basisPoints;
  if (num >= 0n) {
    return Number((num + half) / denom);
  }
  return Number((num - half) / denom);
}

/**
 * Exact fixed-point quantity rounding (prevents 10.1 + 20.2 = 30.299999999999997).
 */
export function roundQtyFixed(qty: number, decimals = 4): number {
  if (!Number.isFinite(qty)) return 0;
  const factor = 10 ** Math.max(0, Math.min(6, decimals));
  return Math.round(qty * factor) / factor;
}

/**
 * Allocates an exact integer IRR total across weighted buckets so that:
 *   sum(allocated) === totalIrr   (GUARANTEED 0 Rial residual drift)
 * Uses Largest Remainder Method (Hamilton apportionment) for fair, deterministic rounding.
 */
export function allocateProportionalIrr(totalIrr: number, weights: readonly number[]): number[] {
  const target = toExactIrr(totalIrr);
  if (weights.length === 0) return [];
  const cleanWeights = weights.map((w) => (Number.isFinite(w) && w > 0 ? w : 0));
  const weightSum = cleanWeights.reduce((s, w) => s + w, 0);
  if (weightSum <= 0 || target === 0) {
    return cleanWeights.map(() => 0);
  }

  const sign = target < 0 ? -1 : 1;
  const absTarget = Math.abs(target);

  const exactShares = cleanWeights.map((w, idx) => {
    const exact = (absTarget * w) / weightSum;
    const floored = Math.floor(exact);
    return { idx, floored, remainder: exact - floored };
  });

  let distributed = exactShares.reduce((s, x) => s + x.floored, 0);
  let leftover = absTarget - distributed;

  const byRemainder = [...exactShares].sort((a, b) => {
    if (b.remainder !== a.remainder) return b.remainder - a.remainder;
    return a.idx - b.idx;
  });

  const result = new Array<number>(weights.length).fill(0);
  for (const item of exactShares) {
    result[item.idx] = item.floored;
  }
  for (let i = 0; i < leftover && i < byRemainder.length; i++) {
    result[byRemainder[i].idx] += 1;
    distributed += 1;
  }

  return result.map((v) => v * sign);
}

export function isExactIrrBalanced(debitIrr: number, creditIrr: number): boolean {
  return subIrr(debitIrr, creditIrr) === 0;
}

/**
 * Deterministic pure-JS FNV/SHA-style 64-bit-x4 hex digest (256-bit fingerprint)
 * that works identically offline in browsers AND Node.js without external APIs.
 * Used as fallback or synchronous seal when Web Crypto async SHA-256 is unavailable.
 */
export function computeDeterministicHash256(input: string): string {
  const seeds = [
    0x811c9dc5n,
    0x9e3779b9n,
    0x85ebca6bn,
    0xc2b2ae35n,
    0x27d4eb2fn,
    0x165667b1n,
    0xd3a2646cn,
    0xfd7046c5n,
  ];
  const mask32 = 0xffffffffn;
  const prime = 0x01000193n;

  for (let i = 0; i < input.length; i++) {
    const ch = BigInt(input.charCodeAt(i));
    for (let s = 0; s < seeds.length; s++) {
      const mixed = (seeds[s] ^ (ch + BigInt(i * 31 + s * 17))) & mask32;
      seeds[s] = ((mixed * prime) ^ (mixed >> 13n)) & mask32;
    }
  }
  // Final avalanche mix
  for (let s = 0; s < seeds.length; s++) {
    let x = seeds[s];
    x ^= x >> 16n;
    x = (x * 0x7feb352dn) & mask32;
    x ^= x >> 15n;
    x = (x * 0x846ca68bn) & mask32;
    x ^= x >> 16n;
    seeds[s] = x;
  }
  return seeds.map((v) => v.toString(16).padStart(8, '0')).join('');
}

/**
 * Real SHA-256 hex digest using Web Crypto (`crypto.subtle`) when available,
 * with automatic fallback to `computeDeterministicHash256`.
 */
export async function computeSha256Hex(content: string | Uint8Array): Promise<string> {
  try {
    const subtle = typeof globalThis !== 'undefined' ? globalThis.crypto?.subtle : undefined;
    if (subtle) {
      const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
      const digest = await subtle.digest('SHA-256', bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
      return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    }
  } catch {
    // fallback below
  }
  const str =
    typeof content === 'string'
      ? content
      : Array.from(content)
          .map((b) => String.fromCharCode(b))
          .join('');
  return computeDeterministicHash256(str);
}
