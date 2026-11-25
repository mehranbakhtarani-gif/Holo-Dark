/**
 * Financial Voice Search Engine (100% Local & Instant)
 * Parses natural spoken Persian financial queries, normalizes spoken Persian numbers,
 * detects accounting domain intent (invoices, proformas, cheques, parties, inventory,
 * accounts, vouchers, financial reports), and executes multi-entity fuzzy search.
 */

import type {
  Account,
  ActiveModule,
  Cheque,
  CurrencyUnit,
  Invoice,
  Party,
  Product,
  TrialBalanceRow,
  Voucher,
} from '../types/accounting';
import { fuzzyFilterAndRank, normalizeFuzzyText } from './fuzzySearch';
import { formatCompactMoney, formatMoney, toPersianDigits } from './format';

export type FinancialVoiceDomain =
  | 'all'
  | 'invoices'
  | 'proforma'
  | 'cheques'
  | 'parties'
  | 'inventory'
  | 'accounts'
  | 'vouchers'
  | 'reports';

export interface ParsedFinancialVoiceQuery {
  rawText: string;
  normalizedQuery: string;
  cleanedKeywords: string;
  detectedDomain: FinancialVoiceDomain;
  domainLabel: string;
}

export interface FinancialVoiceSearchResultItem {
  id: string;
  domain: Exclude<FinancialVoiceDomain, 'all'>;
  domainLabel: string;
  title: string;
  subtitle: string;
  amountText?: string;
  amountTone?: 'default' | 'positive' | 'negative' | 'warning';
  score: number;
  module: ActiveModule;
  intent?: string;
  subKey?: string;
  /** Optional quick search string to prefill dashboard/table search */
  filterText?: string;
}

export interface FinancialVoiceSearchDataset {
  invoices: Invoice[];
  cheques: Cheque[];
  parties: Party[];
  products: Product[];
  accounts: Account[];
  vouchers: Voucher[];
  trialBalance: TrialBalanceRow[];
  partyBalances: Map<string, number>;
  unit: CurrencyUnit;
}

export const VOICE_SEARCH_EXAMPLES: { label: string; query: string }[] = [
  { label: 'فاکتورهای فروش', query: 'فاکتور فروش' },
  { label: 'پیش‌فاکتورها', query: 'پیش فاکتور' },
  { label: 'چک‌های صیادی', query: 'چک سررسید' },
  { label: 'موجودی انبار نخ', query: 'موجودی انبار نخ' },
  { label: 'مانده بانک و صندوق', query: 'حساب بانک' },
  { label: 'گزارش سود و زیان', query: 'گزارش سود و زیان' },
];

const DOMAIN_LABELS: Record<FinancialVoiceDomain, string> = {
  all: 'همه بخش‌های مالی',
  invoices: 'فاکتورها',
  proforma: 'پیش‌فاکتورها',
  cheques: 'چک‌های صیادی',
  parties: 'طرف‌حساب‌ها',
  inventory: 'انبار و کالا',
  accounts: 'کدینگ حساب‌ها',
  vouchers: 'اسناد حسابداری',
  reports: 'گزارش‌ها و عملیات',
};

const SPOKEN_PERSIAN_NUMBER_MAP: Record<string, string> = {
  صفر: '0',
  یک: '1',
  دو: '2',
  سه: '3',
  چهار: '4',
  پنج: '5',
  شش: '6',
  شیش: '6',
  هفت: '7',
  هشت: '8',
  نه: '9',
  ده: '10',
  یازده: '11',
  دوازده: '12',
  سیزده: '13',
  چهارده: '14',
  پانزده: '15',
  شانزده: '16',
  هفده: '17',
  هجده: '18',
  نوزده: '19',
  بیست: '20',
  سی: '30',
  چهل: '40',
  پنجاه: '50',
  شصت: '60',
  هفتاد: '70',
  هشتاد: '80',
  نود: '90',
  صد: '100',
  دویست: '200',
  سیصد: '300',
  چهارصد: '400',
  پانصد: '500',
};

const VOICE_FILLER_WORDS = new Set([
  'جستجو',
  'جستجوی',
  'بگرد',
  'پیدا',
  'کن',
  'نشان',
  'نشون',
  'بده',
  'نمایش',
  'باز',
  'لیست',
  'همه',
  'تمامی',
  'فهرست',
  'مربوط',
  'شماره',
  'لطفا',
  'لطفاً',
  'برام',
  'برای',
  'من',
  'رو',
  'را',
  'ببینم',
  'بیار',
]);

const DOMAIN_TRIGGER_WORDS: Record<Exclude<FinancialVoiceDomain, 'all'>, string[]> = {
  proforma: ['پیش فاکتور', 'پیشفاکتور', 'استعلام قیمت'],
  invoices: ['فاکتور', 'فاکتورها', 'فاکتورهای', 'فروش', 'خرید', 'مرجوعی'],
  cheques: ['چک', 'چکها', 'چکهای', 'صیادی', 'سررسید', 'خزانه', 'خزانه داری'],
  parties: ['طرف حساب', 'طرفحساب', 'مشتری', 'مشتریان', 'تامین کننده', 'بدهکاران', 'بستانکاران'],
  inventory: ['انبار', 'کالا', 'کالاها', 'موجودی انبار', 'نخ', 'کاردکس', 'لات', 'کارتن'],
  accounts: ['حساب', 'حسابها', 'کدینگ', 'معین', 'کل', 'بانک', 'صندوق', 'نقدینگی', 'مانده'],
  vouchers: ['سند', 'اسناد', 'روزنامه', 'حسابداری'],
  reports: ['گزارش', 'سود و زیان', 'ترازنامه', 'تراز ازمایشی', 'تراز آزمایشی', 'مرور حساب'],
};

const QUICK_FINANCIAL_ACTIONS: Array<{
  id: string;
  title: string;
  subtitle: string;
  keywords: string;
  module: ActiveModule;
  intent?: string;
  subKey?: string;
}> = [
  {
    id: 'act-pnl',
    title: 'صورت سود و زیان',
    subtitle: 'گزارش درآمدها، بهای تمام‌شده و سود خالص دوره',
    keywords: 'گزارش سود و زیان درآمد هزینه سود خالص pnl',
    module: 'reports',
    intent: 'pnl',
    subKey: 'rep-pnl',
  },
  {
    id: 'act-trial',
    title: 'تراز آزمایشی و مرور حساب‌ها',
    subtitle: 'بررسی تراز کل، معین و گردش بدهکار و بستانکار',
    keywords: 'تراز آزمایشی ترازنامه مرور حساب گزارش مالی trial balance',
    module: 'reports',
    intent: 'trial',
    subKey: 'rep-trial',
  },
  {
    id: 'act-balance',
    title: 'ترازنامه مالی',
    subtitle: 'وضعیت دارایی‌ها، بدهی‌ها و حقوق صاحبان سهام',
    keywords: 'ترازنامه دارایی بدهی سرمایه balance sheet',
    module: 'reports',
    intent: 'balance',
    subKey: 'rep-balance',
  },
  {
    id: 'act-new-sale',
    title: 'صدور فاکتور فروش جدید',
    subtitle: 'باز کردن فرم صدور فاکتور رسمی و سامانه مودیان',
    keywords: 'صدور فاکتور فروش جدید ثبت فاکتور رسمی',
    module: 'invoices',
    intent: 'new-sale',
    subKey: 'inv-sale',
  },
  {
    id: 'act-new-proforma',
    title: 'صدور پیش‌فاکتور جدید',
    subtitle: 'ایجاد پیش‌فاکتور و استعلام قیمت مشتری',
    keywords: 'صدور پیش فاکتور پیشفاکتور جدید استعلام قیمت',
    module: 'invoices',
    intent: 'new-proforma',
    subKey: 'inv-proforma',
  },
  {
    id: 'act-new-voucher',
    title: 'ثبت سند حسابداری جدید',
    subtitle: 'ورود اطلاعات سند دوبل در دفتر روزنامه',
    keywords: 'ثبت سند جدید سند حسابداری روزنامه',
    module: 'vouchers',
    intent: 'new-voucher',
    subKey: 'voucher-new',
  },
  {
    id: 'act-cheques',
    title: 'مدیریت چک‌های صیادی و سررسید',
    subtitle: 'پیگیری چک‌های دریافتی، پرداختی و سررسیدهای نزدیک',
    keywords: 'چک صیادی سررسید نزدیک وصول چک خزانه داری',
    module: 'treasury',
    intent: 'cheques',
    subKey: 'tr-cheques',
  },
];

/**
 * Replaces simple spoken Persian numbers (e.g. "سند پنج", "فاکتور صد و یک") with ASCII digits
 * so spoken invoice/voucher numbers match stored numeric codes seamlessly.
 */
export function normalizeSpokenPersianNumbers(input: string): string {
  const norm = normalizeFuzzyText(input);
  if (!norm) return '';

  const words = norm.split(' ');
  const out: string[] = [];

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    // Handle compound "صد و یک" -> 101, "بیست و پنج" -> 25
    const curVal = SPOKEN_PERSIAN_NUMBER_MAP[w];
    if (
      curVal &&
      i + 2 < words.length &&
      words[i + 1] === 'و' &&
      SPOKEN_PERSIAN_NUMBER_MAP[words[i + 2]]
    ) {
      const a = Number(curVal);
      const b = Number(SPOKEN_PERSIAN_NUMBER_MAP[words[i + 2]]);
      if (a >= 20 && b < a) {
        out.push(String(a + b));
        i += 2;
        continue;
      }
    }
    if (curVal) {
      out.push(curVal);
    } else {
      out.push(w);
    }
  }

  return out.join(' ');
}

export function parseFinancialVoiceQuery(rawText: string): ParsedFinancialVoiceQuery {
  const withDigits = normalizeSpokenPersianNumbers(rawText);
  if (!withDigits) {
    return {
      rawText,
      normalizedQuery: '',
      cleanedKeywords: '',
      detectedDomain: 'all',
      domainLabel: DOMAIN_LABELS.all,
    };
  }

  let detectedDomain: FinancialVoiceDomain = 'all';

  // Detect domain in priority order (proforma before invoices, reports before general accounts)
  const checkOrder: Exclude<FinancialVoiceDomain, 'all'>[] = [
    'proforma',
    'reports',
    'cheques',
    'inventory',
    'parties',
    'vouchers',
    'invoices',
    'accounts',
  ];

  for (const domain of checkOrder) {
    const triggers = DOMAIN_TRIGGER_WORDS[domain];
    if (triggers.some((t) => withDigits.includes(normalizeFuzzyText(t)))) {
      detectedDomain = domain;
      break;
    }
  }

  // Strip polite spoken filler words while keeping entity names, numbers, and domain keywords
  const domainSingleWords = new Set(
    detectedDomain !== 'all'
      ? DOMAIN_TRIGGER_WORDS[detectedDomain]
          .flatMap((phrase) => normalizeFuzzyText(phrase).split(' '))
          .filter(Boolean)
      : []
  );

  const tokens = withDigits.split(' ').filter(Boolean);
  const withoutFillers = tokens.filter((t) => !VOICE_FILLER_WORDS.has(t));
  const specificTokens = withoutFillers.filter((t) => !domainSingleWords.has(t));

  // If the user ONLY spoke a domain phrase like "چک‌های صیادی" or "پیش فاکتور", keep withoutFillers
  const cleanedKeywords = (specificTokens.length > 0 ? specificTokens : withoutFillers).join(' ');

  return {
    rawText,
    normalizedQuery: withDigits,
    cleanedKeywords,
    detectedDomain,
    domainLabel: DOMAIN_LABELS[detectedDomain],
  };
}

const INVOICE_TYPE_PERSIAN: Record<string, string> = {
  sale: 'فاکتور فروش رسمی',
  purchase: 'فاکتور خرید',
  proforma: 'پیش‌فاکتور',
  sale_return: 'برگشت از فروش',
  purchase_return: 'برگشت از خرید',
  waste: 'ضایعات انبار',
};

const CHEQUE_STATUS_PERSIAN: Record<string, string> = {
  in_box: 'در صندوق',
  deposited: 'در جریان وصول',
  cleared: 'وصول / پاس شده',
  bounced: 'برگشتی',
  endorsed: 'خرج‌شده',
  cancelled: 'باطل‌شده',
};

/**
 * Executes instant local multi-entity Persian fuzzy search across the entire accounting workspace.
 */
export function executeFinancialVoiceSearch(
  rawQuery: string,
  dataset: FinancialVoiceSearchDataset,
  maxResults = 14
): {
  parsed: ParsedFinancialVoiceQuery;
  results: FinancialVoiceSearchResultItem[];
} {
  const parsed = parseFinancialVoiceQuery(rawQuery);
  if (!parsed.normalizedQuery) {
    return { parsed, results: [] };
  }

  const {
    invoices,
    cheques,
    parties,
    products,
    accounts,
    vouchers,
    trialBalance,
    partyBalances,
    unit,
  } = dataset;

  const searchNeedle = parsed.cleanedKeywords || parsed.normalizedQuery;
  const domain = parsed.detectedDomain;
  const results: FinancialVoiceSearchResultItem[] = [];

  const trialBalanceMap = new Map<string, number>();
  for (const row of trialBalance) {
    trialBalanceMap.set(row.accountCode, row.balanceDebit - row.balanceCredit);
  }

  // 1. Invoices & Proformas
  const invoicePool =
    domain === 'proforma'
      ? invoices.filter((inv) => inv.invoiceType === 'proforma')
      : invoices;

  const isPureDomainListing =
    domain !== 'all' &&
    normalizeFuzzyText(parsed.cleanedKeywords) ===
      normalizeFuzzyText(
        parsed.normalizedQuery
          .split(' ')
          .filter((t) => !VOICE_FILLER_WORDS.has(t))
          .join(' ')
      ) &&
    DOMAIN_TRIGGER_WORDS[domain].some((tr) =>
      normalizeFuzzyText(parsed.cleanedKeywords).includes(normalizeFuzzyText(tr))
    );

  if (domain === 'proforma' && isPureDomainListing) {
    invoicePool.slice(0, 5).forEach((inv, idx) => {
      results.push({
        id: `inv-${inv.id}`,
        domain: 'proforma',
        domainLabel: 'پیش‌فاکتور',
        title: `${toPersianDigits(inv.invoiceNumber)} · ${inv.partyName}`,
        subtitle: `پیش‌فاکتور · تاریخ ${toPersianDigits(inv.date)}`,
        amountText: formatMoney(inv.grandTotal, unit),
        amountTone: 'warning',
        score: 120 - idx,
        module: 'invoices',
        filterText: inv.invoiceNumber,
      });
    });
  } else {
    const invRanked = fuzzyFilterAndRank(invoicePool, searchNeedle, (inv) => [
      { text: inv.invoiceNumber, weight: 1.5 },
      { text: inv.partyName, weight: 1.35 },
      { text: INVOICE_TYPE_PERSIAN[inv.invoiceType] || inv.invoiceType, weight: 1.1 },
      { text: inv.date, weight: 1.0 },
      { text: String(inv.grandTotal), weight: 0.85 },
      { text: inv.items.map((it) => `${it.productName} ${it.sku}`).join(' '), weight: 0.95 },
    ]);
    const boost = domain === 'invoices' || domain === 'proforma' ? 22 : 0;
    invRanked.slice(0, 5).forEach((r) => {
      const inv = r.item;
      const isProforma = inv.invoiceType === 'proforma';
      results.push({
        id: `inv-${inv.id}`,
        domain: isProforma ? 'proforma' : 'invoices',
        domainLabel: isProforma ? 'پیش‌فاکتور' : 'فاکتور',
        title: `${toPersianDigits(inv.invoiceNumber)} · ${inv.partyName}`,
        subtitle: `${INVOICE_TYPE_PERSIAN[inv.invoiceType] || inv.invoiceType} · ${toPersianDigits(inv.date)}`,
        amountText: formatMoney(inv.grandTotal, unit),
        amountTone: inv.status === 'settled' ? 'positive' : inv.status === 'cancelled' ? 'negative' : 'warning',
        score: r.score + boost,
        module: 'invoices',
        filterText: inv.invoiceNumber,
      });
    });
  }

  // 2. Sayadi Cheques
  if (domain === 'cheques' && isPureDomainListing) {
    cheques.slice(0, 5).forEach((ch, idx) => {
      results.push({
        id: `chq-${ch.id}`,
        domain: 'cheques',
        domainLabel: 'چک صیادی',
        title: `${ch.partyName} · ${ch.bankName}`,
        subtitle: `سررسید ${toPersianDigits(ch.dueDate)} · ${ch.direction === 'receivable' ? 'دریافتی' : 'پرداختی'} · ${CHEQUE_STATUS_PERSIAN[ch.status] || ch.status}`,
        amountText: formatCompactMoney(ch.amount, unit),
        amountTone: ch.status === 'bounced' ? 'negative' : ch.direction === 'receivable' ? 'positive' : 'warning',
        score: 120 - idx,
        module: 'treasury',
        intent: `cheque:${ch.id}`,
        subKey: 'tr-cheques',
      });
    });
  } else {
    const chqRanked = fuzzyFilterAndRank(cheques, searchNeedle, (ch) => [
      { text: ch.partyName, weight: 1.35 },
      { text: ch.sayadiId, weight: 1.4 },
      { text: ch.serial, weight: 1.3 },
      { text: ch.bankName, weight: 1.15 },
      { text: ch.dueDate, weight: 1.1 },
      { text: CHEQUE_STATUS_PERSIAN[ch.status], weight: 1.0 },
      { text: ch.direction === 'receivable' ? 'دریافتی' : 'پرداختی', weight: 0.95 },
      { text: String(ch.amount), weight: 0.85 },
    ]);
    const boost = domain === 'cheques' ? 24 : 0;
    chqRanked.slice(0, 4).forEach((r) => {
      const ch = r.item;
      results.push({
        id: `chq-${ch.id}`,
        domain: 'cheques',
        domainLabel: 'چک صیادی',
        title: `${ch.partyName} · ${ch.bankName}`,
        subtitle: `سررسید ${toPersianDigits(ch.dueDate)} · صیادی ${toPersianDigits(ch.sayadiId)}`,
        amountText: formatCompactMoney(ch.amount, unit),
        amountTone: ch.status === 'bounced' ? 'negative' : ch.direction === 'receivable' ? 'positive' : 'warning',
        score: r.score + boost,
        module: 'treasury',
        intent: `cheque:${ch.id}`,
        subKey: 'tr-cheques',
      });
    });
  }

  // 3. Parties & Balances
  const partyRanked = fuzzyFilterAndRank(parties, searchNeedle, (p) => [
    { text: p.name, weight: 1.4 },
    { text: p.code, weight: 1.3 },
    { text: p.phone, weight: 1.0 },
    { text: p.nationalId, weight: 1.0 },
  ]);
  const partyBoost = domain === 'parties' ? 22 : 0;
  partyRanked.slice(0, 4).forEach((r) => {
    const p = r.item;
    const bal = partyBalances.get(p.id) ?? 0;
    results.push({
      id: `party-${p.id}`,
      domain: 'parties',
      domainLabel: 'طرف‌حساب',
      title: p.name,
      subtitle: `کد ${toPersianDigits(p.code)}${p.phone ? ` · ${toPersianDigits(p.phone)}` : ''}`,
      amountText:
        bal === 0
          ? 'تسویه'
          : `${formatCompactMoney(Math.abs(bal), unit)} ${bal > 0 ? 'بد' : 'بس'}`,
      amountTone: bal > 0 ? 'warning' : bal < 0 ? 'positive' : 'default',
      score: r.score + partyBoost,
      module: 'parties',
      subKey: 'parties',
      filterText: p.name,
    });
  });

  // 4. Inventory / Yarn Products
  const prodRanked = fuzzyFilterAndRank(products, searchNeedle, (p) => [
    { text: p.name, weight: 1.4 },
    { text: p.sku, weight: 1.35 },
    { text: p.category, weight: 1.1 },
    { text: p.warehouse, weight: 1.05 },
    { text: p.yarnCount, weight: 1.1 },
    { text: p.lotNumber, weight: 1.05 },
  ]);
  const invtBoost = domain === 'inventory' ? 24 : 0;
  prodRanked.slice(0, 4).forEach((r) => {
    const p = r.item;
    const low = p.stock < p.reorderPoint;
    results.push({
      id: `prod-${p.id}`,
      domain: 'inventory',
      domainLabel: 'انبار و کالا',
      title: p.name,
      subtitle: `کد ${toPersianDigits(p.sku)} · ${p.warehouse}`,
      amountText: `${toPersianDigits(p.stock.toLocaleString('en-US'))} ${p.unit}`,
      amountTone: low ? 'negative' : 'positive',
      score: r.score + invtBoost,
      module: 'inventory',
      intent: 'kardex',
      subKey: 'inv-kardex',
      filterText: p.name,
    });
  });

  // 5. Chart of Accounts & Live Balances
  const accRanked = fuzzyFilterAndRank(accounts, searchNeedle, (a) => [
    { text: a.title, weight: 1.35 },
    { text: a.code, weight: 1.45 },
  ]);
  const accBoost = domain === 'accounts' ? 22 : 0;
  accRanked.slice(0, 4).forEach((r) => {
    const a = r.item;
    const bal = trialBalanceMap.get(a.code) ?? 0;
    results.push({
      id: `acc-${a.id}`,
      domain: 'accounts',
      domainLabel: 'حساب',
      title: `${toPersianDigits(a.code)} · ${a.title}`,
      subtitle: a.level === 'kol' ? 'حساب کل' : a.level === 'moein' ? 'حساب معین' : 'حساب تفصیلی',
      amountText:
        bal === 0
          ? 'مانده صفر'
          : `${formatCompactMoney(Math.abs(bal), unit)} ${bal > 0 ? 'بد' : 'بس'}`,
      amountTone: bal < 0 ? 'positive' : 'default',
      score: r.score + accBoost,
      module: 'accounts',
      subKey: 'accounts-all',
    });
  });

  // 6. Accounting Vouchers
  const vchRanked = fuzzyFilterAndRank(vouchers, searchNeedle, (v) => [
    { text: String(v.voucherNumber), weight: 1.45 },
    { text: v.description, weight: 1.25 },
    { text: v.date, weight: 1.0 },
    { text: v.lines.map((l) => `${l.accountTitle} ${l.description}`).join(' '), weight: 0.9 },
  ]);
  const vchBoost = domain === 'vouchers' ? 22 : 0;
  vchRanked.slice(0, 3).forEach((r) => {
    const v = r.item;
    results.push({
      id: `vch-${v.id}`,
      domain: 'vouchers',
      domainLabel: 'سند حسابداری',
      title: `سند شماره ${toPersianDigits(v.voucherNumber)}`,
      subtitle: `${v.description} · ${toPersianDigits(v.date)}`,
      amountText: formatCompactMoney(v.totalDebit, unit),
      amountTone: 'default',
      score: r.score + vchBoost,
      module: 'vouchers',
      subKey: 'voucher-cartable',
    });
  });

  // 7. Quick Financial Reports & Actions
  const actRanked = fuzzyFilterAndRank(QUICK_FINANCIAL_ACTIONS, parsed.normalizedQuery, (a) => [
    { text: a.title, weight: 1.35 },
    { text: a.keywords, weight: 1.2 },
    { text: a.subtitle, weight: 0.9 },
  ]);
  const repBoost = domain === 'reports' ? 30 : 0;
  actRanked.slice(0, 3).forEach((r) => {
    const act = r.item;
    results.push({
      id: act.id,
      domain: 'reports',
      domainLabel: 'گزارش / عملیات',
      title: act.title,
      subtitle: act.subtitle,
      score: r.score + repBoost,
      module: act.module,
      intent: act.intent,
      subKey: act.subKey,
    });
  });

  results.sort((a, b) => b.score - a.score);
  return {
    parsed,
    results: results.slice(0, maxResults),
  };
}
