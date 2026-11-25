/**
 * Bank Reconciliation Engine (تطبیق بانکی هوشمند و قابل ممیزی)
 *
 * Capabilities:
 * - Parse bank statement CSV / TSV / JSON files (supports Persian/Arabic digits & flexible columns)
 * - Auto-match bank lines with accounting vouchers posted to the selected bank account (102*)
 * - Classify match confidence: exact_ref_amount, exact_date_amount, similar_amount_near_date, ambiguous
 * - Detect transactions without vouchers (unmatched bank rows), book-only items in transit, and duplicates
 * - Compute exact Bank Balance vs Book Balance reconciliation summary
 * - Require explicit reviewer confirmation before any auto-match or ambiguous item is finalized
 * - Persist reconciliation sessions locally for full audit reviewability
 */

import { Voucher } from '../types/accounting';
import { addIrr, subIrr, sumIrr, toExactIrr } from './moneyMath';
import { shamsiToDayIndex } from './format';

export type BankMatchConfidence =
  | 'exact_ref_amount'
  | 'exact_date_amount'
  | 'similar_near_date'
  | 'ambiguous'
  | 'unmatched';

export type BankReviewStatus =
  | 'pending_review'
  | 'confirmed'
  | 'rejected'
  | 'adjusted';

export interface BankStatementLine {
  id: string;
  rowIndex: number;
  date: string; // Shamsi YYYY/MM/DD
  description: string;
  referenceNumber?: string;
  depositIrr: number; // واریز به حساب بانک (بدهکار دفتر بانک)
  withdrawalIrr: number; // برداشت از حساب بانک (بستانکار دفتر بانک)
  reportedBalanceIrr?: number;
}

export interface BookBankLine {
  lineKey: string;
  voucherId: string;
  voucherNumber: number;
  date: string;
  description: string;
  referenceId?: string;
  debitIrr: number; // واریز در دفتر
  creditIrr: number; // برداشت در دفتر
}

export interface BankMatchCandidate {
  lineKey: string;
  voucherId: string;
  voucherNumber: number;
  date: string;
  description: string;
  amountIrr: number;
  dateDiffDays: number;
  score: number; // 0..100
  reason: string;
}

export interface ReconciledBankRow {
  statementLine: BankStatementLine;
  confidence: BankMatchConfidence;
  suggestedMatch?: BankMatchCandidate;
  alternativeCandidates: BankMatchCandidate[];
  isDuplicateInStatement: boolean;
  duplicateOfRowIds: string[];
  reviewStatus: BankReviewStatus;
  reviewedBy?: string;
  reviewedAt?: string;
  reviewNote?: string;
  linkedVoucherId?: string;
  linkedVoucherNumber?: number;
}

export interface BankReconciliationSummary {
  bankAccountCode: string;
  statementLineCount: number;
  bookLineCount: number;
  matchedAutoCount: number;
  ambiguousCount: number;
  unmatchedBankCount: number;
  unmatchedBookCount: number;
  duplicateStatementCount: number;
  duplicateBookCount: number;
  confirmedCount: number;
  pendingReviewCount: number;
  bookEndingBalanceIrr: number;
  statementNetMovementIrr: number;
  statementEndingBalanceIrr: number | null;
  bankVsBookDifferenceIrr: number;
  unmatchedBankNetIrr: number;
  unmatchedBookNetIrr: number;
  isFullyReviewed: boolean;
}

export interface BankReconciliationReport {
  sessionId: string;
  createdAt: string;
  bankAccountCode: string;
  rows: ReconciledBankRow[];
  unmatchedBookLines: BookBankLine[];
  duplicateBookLineKeys: string[];
  summary: BankReconciliationSummary;
}

export interface SavedReconciliationDecision {
  statementRowId: string;
  reviewStatus: BankReviewStatus;
  linkedVoucherId?: string;
  linkedVoucherNumber?: number;
  reviewedBy: string;
  reviewedAt: string;
  reviewNote?: string;
}

const STORAGE_KEY = 'holoo_apex_bank_recon_sessions_v1';

function toLatinDigits(input: string): string {
  return input
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
}

function normalizeShamsiDate(raw: string): string {
  const clean = toLatinDigits(raw).trim().replace(/[-.\s]/g, '/');
  const m = clean.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (!m) return clean;
  return `${m[1]}/${m[2].padStart(2, '0')}/${m[3].padStart(2, '0')}`;
}

function parseAmountField(raw: string | number | undefined): number {
  if (raw === undefined || raw === null) return 0;
  if (typeof raw === 'number') return toExactIrr(raw);
  const clean = toLatinDigits(String(raw)).replace(/[^\d.-]/g, '');
  if (!clean) return 0;
  return toExactIrr(Number(clean));
}

function splitCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if ((ch === ',' || ch === ';' || ch === '\t') && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

/**
 * Parses bank statement input in CSV, TSV, or JSON array format.
 * Supported CSV columns:
 *  - 4 columns: date, description, deposit, withdrawal
 *  - 5 columns: date, description, deposit, withdrawal, refNumber (or balance)
 *  - 6 columns: date, description, deposit, withdrawal, balance, refNumber
 */
export function parseBankStatementInput(rawText: string): BankStatementLine[] {
  const trimmed = rawText.trim();
  if (!trimmed) return [];

  // JSON format support
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed.rows) ? parsed.rows : [];
      return arr
        .map((r: Record<string, unknown>, idx: number): BankStatementLine | null => {
          const date = normalizeShamsiDate(String(r.date ?? r.Date ?? ''));
          const depositIrr = parseAmountField(
            (r.depositIrr ?? r.deposit ?? r.credit ?? r.inflow ?? 0) as string | number
          );
          const withdrawalIrr = parseAmountField(
            (r.withdrawalIrr ?? r.withdrawal ?? r.debit ?? r.outflow ?? 0) as string | number
          );
          if (!date || (depositIrr === 0 && withdrawalIrr === 0)) return null;
          const balanceRaw = r.balanceIrr ?? r.balance;
          return {
            id: String(r.id || `bnk_${idx + 1}`),
            rowIndex: idx + 1,
            date,
            description: String(r.description ?? r.desc ?? 'گردش بانکی').trim(),
            referenceNumber: r.referenceNumber || r.ref ? String(r.referenceNumber ?? r.ref).trim() : undefined,
            depositIrr: Math.max(0, depositIrr),
            withdrawalIrr: Math.max(0, withdrawalIrr),
            reportedBalanceIrr: balanceRaw !== undefined ? parseAmountField(balanceRaw as string | number) : undefined,
          };
        })
        .filter((x: BankStatementLine | null): x is BankStatementLine => x !== null);
    } catch {
      return [];
    }
  }

  // CSV / TSV line-by-line parser
  const lines = trimmed
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const result: BankStatementLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    if (cols.length < 4) continue;
    const firstCol = normalizeShamsiDate(cols[0]);
    // Skip header lines
    if (!/^\d{4}\/\d{2}\/\d{2}$/.test(firstCol)) continue;

    const description = cols[1]?.replace(/^"|"$/g, '').trim() || 'گردش بانکی';
    const depositIrr = Math.max(0, parseAmountField(cols[2]));
    const withdrawalIrr = Math.max(0, parseAmountField(cols[3]));
    if (depositIrr === 0 && withdrawalIrr === 0) continue;

    let reportedBalanceIrr: number | undefined;
    let referenceNumber: string | undefined;

    if (cols.length === 5) {
      const col5 = cols[4].trim();
      if (/^[A-Za-z0-9_-]{3,}$/.test(toLatinDigits(col5)) && !/^\d{7,}$/.test(toLatinDigits(col5))) {
        referenceNumber = toLatinDigits(col5);
      } else if (col5) {
        reportedBalanceIrr = parseAmountField(col5);
      }
    } else if (cols.length >= 6) {
      if (cols[4].trim()) reportedBalanceIrr = parseAmountField(cols[4]);
      if (cols[5].trim()) referenceNumber = toLatinDigits(cols[5].trim());
    }

    result.push({
      id: `bnk_${result.length + 1}`,
      rowIndex: result.length + 1,
      date: firstCol,
      description,
      referenceNumber,
      depositIrr,
      withdrawalIrr,
      reportedBalanceIrr,
    });
  }
  return result;
}

function dateDistanceDays(d1: string, d2: string): number {
  const i1 = shamsiToDayIndex(d1);
  const i2 = shamsiToDayIndex(d2);
  if (!Number.isFinite(i1) || !Number.isFinite(i2)) return 999;
  return Math.abs(i1 - i2);
}

function descriptionSimilarity(a: string, b: string): number {
  const norm = (s: string) =>
    toLatinDigits(s)
      .toLowerCase()
      .replace(/[^\u0600-\u06FFa-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 2);
  const ta = new Set(norm(a));
  const tb = new Set(norm(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let overlap = 0;
  for (const w of ta) {
    if (tb.has(w)) overlap += 1;
  }
  return overlap / Math.max(ta.size, tb.size);
}

/**
 * Runs deterministic bank statement vs accounting ledger reconciliation.
 * Never auto-finalizes: all suggested matches remain `pending_review` until
 * explicitly confirmed or rejected via `applyReconciliationDecision`.
 */
export function runBankReconciliation(params: {
  bankAccountCode: string;
  statementLines: BankStatementLine[];
  vouchers: Voucher[];
  openingBankBalanceIrr?: number;
  priorDecisions?: Record<string, SavedReconciliationDecision>;
  maxDateToleranceDays?: number;
}): BankReconciliationReport {
  const {
    bankAccountCode,
    statementLines,
    vouchers,
    priorDecisions = {},
    maxDateToleranceDays = 5,
  } = params;

  // 1. Extract permanent book ledger lines for this bank account
  const bookLines: BookBankLine[] = [];
  for (const v of vouchers) {
    if (v.status === 'draft') continue;
    v.lines.forEach((line, lineIdx) => {
      if (line.accountCode !== bankAccountCode) return;
      const debitIrr = toExactIrr(line.debit);
      const creditIrr = toExactIrr(line.credit);
      if (debitIrr === 0 && creditIrr === 0) return;
      bookLines.push({
        lineKey: `${v.id}:${lineIdx}`,
        voucherId: v.id,
        voucherNumber: v.voucherNumber,
        date: v.date,
        description: line.description || v.description,
        referenceId: v.referenceId,
        debitIrr,
        creditIrr,
      });
    });
  }

  // 2. Detect duplicate lines in bank statement (same date + deposit + withdrawal + ref)
  const stmtSignatureMap = new Map<string, string[]>();
  for (const s of statementLines) {
    const sig = `${s.date}|${s.depositIrr}|${s.withdrawalIrr}|${s.referenceNumber || ''}`;
    const list = stmtSignatureMap.get(sig) || [];
    list.push(s.id);
    stmtSignatureMap.set(sig, list);
  }

  // 3. Detect duplicate book entries (same date + exact debit/credit + same description, different vouchers)
  const bookSigMap = new Map<string, string[]>();
  for (const b of bookLines) {
    const sig = `${b.date}|${b.debitIrr}|${b.creditIrr}|${b.description.trim()}`;
    const list = bookSigMap.get(sig) || [];
    list.push(b.lineKey);
    bookSigMap.set(sig, list);
  }
  const duplicateBookLineKeys = Array.from(bookSigMap.values())
    .filter((keys) => keys.length > 1)
    .flat();

  // 4. Score & match statement rows to book lines (greedy best-score unique matching + ambiguity detection)
  const usedBookKeys = new Set<string>();
  const rows: ReconciledBankRow[] = [];

  for (const stmt of statementLines) {
    const stmtAmount = stmt.depositIrr > 0 ? stmt.depositIrr : stmt.withdrawalIrr;
    const isDeposit = stmt.depositIrr > 0;
    const sig = `${stmt.date}|${stmt.depositIrr}|${stmt.withdrawalIrr}|${stmt.referenceNumber || ''}`;
    const dupIds = (stmtSignatureMap.get(sig) || []).filter((id) => id !== stmt.id);

    const candidates: BankMatchCandidate[] = [];
    for (const b of bookLines) {
      if (usedBookKeys.has(b.lineKey)) continue;
      const bookAmount = isDeposit ? b.debitIrr : b.creditIrr;
      if (bookAmount <= 0) continue;

      const amountExact = bookAmount === stmtAmount;
      if (!amountExact) continue;

      const dateDiff = dateDistanceDays(stmt.date, b.date);
      if (dateDiff > maxDateToleranceDays) continue;

      const refMatched =
        Boolean(stmt.referenceNumber) &&
        Boolean(b.referenceId) &&
        b.referenceId!.toLowerCase().includes(stmt.referenceNumber!.toLowerCase());
      const textSim = descriptionSimilarity(stmt.description, b.description);

      let score = 60;
      const reasons: string[] = ['تطابق دقیق مبلغ'];
      if (refMatched) {
        score += 30;
        reasons.push('تطابق شماره پیگیری');
      }
      if (dateDiff === 0) {
        score += 20;
        reasons.push('تاریخ دقیق یکسان');
      } else {
        score += Math.max(0, 15 - dateDiff * 3);
        reasons.push(`اختلاف تاریخ ${dateDiff} روز`);
      }
      if (textSim >= 0.35) {
        score += 10;
        reasons.push('شباهت شرح تراکنش');
      }

      candidates.push({
        lineKey: b.lineKey,
        voucherId: b.voucherId,
        voucherNumber: b.voucherNumber,
        date: b.date,
        description: b.description,
        amountIrr: bookAmount,
        dateDiffDays: dateDiff,
        score: Math.min(100, score),
        reason: reasons.join(' · '),
      });
    }

    candidates.sort((a, b) => b.score - a.score || a.dateDiffDays - b.dateDiffDays);

    let confidence: BankMatchConfidence = 'unmatched';
    let suggestedMatch: BankMatchCandidate | undefined;

    if (candidates.length > 0) {
      const top = candidates[0];
      const tiedSecond = candidates.length > 1 && Math.abs(candidates[1].score - top.score) <= 5;
      if (tiedSecond) {
        confidence = 'ambiguous';
        suggestedMatch = top;
      } else if (top.score >= 90) {
        confidence = 'exact_ref_amount';
        suggestedMatch = top;
        usedBookKeys.add(top.lineKey);
      } else if (top.dateDiffDays === 0) {
        confidence = 'exact_date_amount';
        suggestedMatch = top;
        usedBookKeys.add(top.lineKey);
      } else {
        confidence = 'similar_near_date';
        suggestedMatch = top;
        usedBookKeys.add(top.lineKey);
      }
    }

    const prior = priorDecisions[stmt.id];
    const reviewStatus: BankReviewStatus = prior?.reviewStatus ?? 'pending_review';
    if (prior?.linkedVoucherId) {
      const matchedKey = bookLines.find((b) => b.voucherId === prior.linkedVoucherId)?.lineKey;
      if (matchedKey) usedBookKeys.add(matchedKey);
    }

    rows.push({
      statementLine: stmt,
      confidence,
      suggestedMatch,
      alternativeCandidates: candidates.slice(0, 5),
      isDuplicateInStatement: dupIds.length > 0,
      duplicateOfRowIds: dupIds,
      reviewStatus,
      reviewedBy: prior?.reviewedBy,
      reviewedAt: prior?.reviewedAt,
      reviewNote: prior?.reviewNote,
      linkedVoucherId: prior?.linkedVoucherId ?? (reviewStatus === 'confirmed' ? suggestedMatch?.voucherId : undefined),
      linkedVoucherNumber:
        prior?.linkedVoucherNumber ?? (reviewStatus === 'confirmed' ? suggestedMatch?.voucherNumber : undefined),
    });
  }

  const unmatchedBookLines = bookLines.filter((b) => !usedBookKeys.has(b.lineKey));

  const bookEndingBalanceIrr = sumIrr(
    bookLines.map((b) => subIrr(b.debitIrr, b.creditIrr))
  );
  const statementNetMovementIrr = sumIrr(
    statementLines.map((s) => subIrr(s.depositIrr, s.withdrawalIrr))
  );
  const lastReported = [...statementLines]
    .reverse()
    .find((s) => s.reportedBalanceIrr !== undefined)?.reportedBalanceIrr;
  const statementEndingBalanceIrr =
    lastReported !== undefined
      ? lastReported
      : params.openingBankBalanceIrr !== undefined
        ? addIrr(params.openingBankBalanceIrr, statementNetMovementIrr)
        : null;

  const unmatchedBankNetIrr = sumIrr(
    rows
      .filter((r) => r.confidence === 'unmatched' && r.reviewStatus !== 'confirmed')
      .map((r) => subIrr(r.statementLine.depositIrr, r.statementLine.withdrawalIrr))
  );
  const unmatchedBookNetIrr = sumIrr(
    unmatchedBookLines.map((b) => subIrr(b.debitIrr, b.creditIrr))
  );

  const bankVsBookDifferenceIrr =
    statementEndingBalanceIrr !== null
      ? subIrr(statementEndingBalanceIrr, bookEndingBalanceIrr)
      : subIrr(statementNetMovementIrr, bookEndingBalanceIrr);

  const matchedAutoCount = rows.filter(
    (r) =>
      r.confidence === 'exact_ref_amount' ||
      r.confidence === 'exact_date_amount' ||
      r.confidence === 'similar_near_date'
  ).length;
  const ambiguousCount = rows.filter((r) => r.confidence === 'ambiguous').length;
  const unmatchedBankCount = rows.filter((r) => r.confidence === 'unmatched').length;
  const duplicateStatementCount = rows.filter((r) => r.isDuplicateInStatement).length;
  const confirmedCount = rows.filter(
    (r) => r.reviewStatus === 'confirmed' || r.reviewStatus === 'adjusted'
  ).length;
  const pendingReviewCount = rows.filter((r) => r.reviewStatus === 'pending_review').length;

  return {
    sessionId: `recon_${bankAccountCode}_${Date.now()}`,
    createdAt: new Date().toISOString(),
    bankAccountCode,
    rows,
    unmatchedBookLines,
    duplicateBookLineKeys,
    summary: {
      bankAccountCode,
      statementLineCount: statementLines.length,
      bookLineCount: bookLines.length,
      matchedAutoCount,
      ambiguousCount,
      unmatchedBankCount,
      unmatchedBookCount: unmatchedBookLines.length,
      duplicateStatementCount,
      duplicateBookCount: duplicateBookLineKeys.length,
      confirmedCount,
      pendingReviewCount,
      bookEndingBalanceIrr,
      statementNetMovementIrr,
      statementEndingBalanceIrr,
      bankVsBookDifferenceIrr,
      unmatchedBankNetIrr,
      unmatchedBookNetIrr,
      isFullyReviewed: statementLines.length > 0 && pendingReviewCount === 0,
    },
  };
}

export function applyReconciliationDecision(
  decisions: Record<string, SavedReconciliationDecision>,
  decision: Omit<SavedReconciliationDecision, 'reviewedAt'>
): Record<string, SavedReconciliationDecision> {
  return {
    ...decisions,
    [decision.statementRowId]: {
      ...decision,
      reviewedAt: new Date().toISOString(),
    },
  };
}

export function saveBankReconciliationSession(
  bankAccountCode: string,
  decisions: Record<string, SavedReconciliationDecision>
): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const all = raw ? (JSON.parse(raw) as Record<string, Record<string, SavedReconciliationDecision>>) : {};
    all[bankAccountCode] = decisions;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // ignore storage errors in non-browser test environments
  }
}

export function loadBankReconciliationSession(
  bankAccountCode: string
): Record<string, SavedReconciliationDecision> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const all = JSON.parse(raw) as Record<string, Record<string, SavedReconciliationDecision>>;
    return all[bankAccountCode] || {};
  } catch {
    return {};
  }
}
