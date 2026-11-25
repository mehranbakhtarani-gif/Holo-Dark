import { useEffect, useState } from 'react';

export type InvoiceTemplateStyle =
  | 'modern_textile'
  | 'official_tax'
  | 'holoo_classic'
  | 'compact_a5';

export type InvoicePaperSize = 'A4' | 'A5' | 'thermal_80mm';

/**
 * Holoo Multi-Unit Display Mode for Textile Yarn Trade:
 * - 1_unit: فقط وزن (کیلوگرم)
 * - 2_units: وزن (کیلوگرم) + کارتن / عدل
 * - 3_units: وزن (کیلوگرم) + کارتن / عدل + دوک / بوبین
 */
export type InvoiceUnitMode = '1_unit' | '2_units' | '3_units';

export type InvoiceAccentColor = 'teal' | 'navy' | 'emerald' | 'slate' | 'rose';

export type InvoicePersianFont =
  | 'vazirmatn'
  | 'noto_naskh'
  | 'rubik_fa'
  | 'lalezar_vazir'
  | 'tahoma_classic';

export type InvoiceFontSizeScale = 'sm' | 'md' | 'lg';
export type InvoiceLogoPosition = 'right' | 'center' | 'left';

export type InvoiceSectionKey = 'header' | 'parties' | 'items' | 'totals' | 'footer';

export type InvoiceColumnKey =
  | 'rowNum'
  | 'sku'
  | 'productName'
  | 'lot'
  | 'carton'
  | 'bobbin'
  | 'quantity'
  | 'unitPrice'
  | 'discount'
  | 'vat'
  | 'lineTotal';

export interface InvoiceColumnConfig {
  key: InvoiceColumnKey;
  label: string;
  visible: boolean;
}

export interface InvoicePrintSettings {
  template: InvoiceTemplateStyle;
  paperSize: InvoicePaperSize;
  unitDisplayMode: InvoiceUnitMode;
  accentColor: InvoiceAccentColor;
  fontFamily: InvoicePersianFont;
  fontSizeScale: InvoiceFontSizeScale;
  logoDataUrl: string;
  logoPosition: InvoiceLogoPosition;
  logoSizePx: number;
  sectionOrder: InvoiceSectionKey[];
  columnOrder: InvoiceColumnConfig[];
  customTitle: string;
  sellerAddress: string;
  sellerPhone: string;
  bankInfo: string;
  footerTerms: string;
  showSku: boolean;
  showLotAndOrigin: boolean;
  showDiscountColumn: boolean;
  showVatColumn: boolean;
  showPartyBalance: boolean;
  showAmountInWords: boolean;
  showSignatures: boolean;
  showTaxQrBox: boolean;
}

export const DEFAULT_INVOICE_SECTIONS: InvoiceSectionKey[] = [
  'header',
  'parties',
  'items',
  'totals',
  'footer',
];

export const DEFAULT_INVOICE_COLUMNS: InvoiceColumnConfig[] = [
  { key: 'rowNum', label: 'ردیف', visible: true },
  { key: 'sku', label: 'کد کالا', visible: true },
  { key: 'productName', label: 'شرح کالا / نخ', visible: true },
  { key: 'lot', label: 'شماره لات', visible: true },
  { key: 'carton', label: 'کارتن / عدل', visible: true },
  { key: 'bobbin', label: 'بوبین / دوک', visible: true },
  { key: 'quantity', label: 'وزن / مقدار', visible: true },
  { key: 'unitPrice', label: 'فی واحد', visible: true },
  { key: 'discount', label: 'تخفیف', visible: true },
  { key: 'vat', label: 'مالیات ۱۰٪', visible: true },
  { key: 'lineTotal', label: 'جمع کل', visible: true },
];

export const DEFAULT_INVOICE_SETTINGS: InvoicePrintSettings = {
  template: 'modern_textile',
  paperSize: 'A4',
  unitDisplayMode: '3_units',
  accentColor: 'teal',
  fontFamily: 'vazirmatn',
  fontSizeScale: 'md',
  logoDataUrl: '',
  logoPosition: 'right',
  logoSizePx: 60,
  sectionOrder: [...DEFAULT_INVOICE_SECTIONS],
  columnOrder: DEFAULT_INVOICE_COLUMNS.map((c) => ({ ...c })),
  customTitle: 'صورتحساب رسمی فروش و حواله خروج نخ نساجی',
  sellerAddress: 'تهران، بازار بزرگ، سرای امید و انبار مرکزی نخ شادآباد، بلوک ۳، پلاک ۱۴',
  sellerPhone: '۰۲۱-۶۶۸۴۲۹۱۰ · ۰۹۱۲۳۸۴۷۲۱۰',
  bankInfo: 'بانک ملت (حساب جاری شرکتی) — شبا: IR420120000000001849203112 — به نام شرکت بازرگانی نخ اطلس‌ریس',
  footerTerms:
    'تحویل بار از انبار مرکزی شادآباد با قبض باسکول رسمی انجام می‌شود. اختلاف وزن باسکول تا ۰.۲٪ مطابق عرف بازار نخ مجاز است. خواهشمند است پیش از رنگرزی، نمره و لات روی کارتن‌ها تطبیق داده شود.',
  showSku: true,
  showLotAndOrigin: true,
  showDiscountColumn: true,
  showVatColumn: true,
  showPartyBalance: true,
  showAmountInWords: true,
  showSignatures: true,
  showTaxQrBox: true,
};

export const SECTION_LABELS: Record<InvoiceSectionKey, { title: string; desc: string }> = {
  header: { title: 'سربرگ، لوگو و عنوان فاکتور', desc: 'نام شرکت، لوگوی اختصاصی، شماره و تاریخ فاکتور' },
  parties: { title: 'مشخصات فروشنده، خریدار و انبار', desc: 'کد اقتصادی، شناسه ملی، تلفن و نشانی تحویل' },
  items: { title: 'جدول اقلام کالا و ستون‌ها', desc: 'ردیف‌های کالا با ترتیب ستون‌های کشیدنی (Drag & Drop)' },
  totals: { title: 'جمع کل، مالیات، حروف و مانده حساب', desc: 'خلاصه مبالغ، مبلغ به حروف فارسی و مانده قبل/بعد' },
  footer: { title: 'شرایط تحویل، حساب بانکی و کادر امضا', desc: 'شماره شبا، توضیحات پاورقی و مهر و امضای طرفین' },
};

export const PERSIAN_FONT_OPTIONS: Record<
  InvoicePersianFont,
  {
    label: string;
    sample: string;
    bodyFontCss: string;
    headingFontCss: string;
    desc: string;
  }
> = {
  vazirmatn: {
    label: 'وزیرمتن (Vazirmatn)',
    sample: 'صورتحساب رسمی فروش — ۱۲۵,۴۰۰,۰۰۰ ریال',
    bodyFontCss: "'Vazirmatn', Tahoma, sans-serif",
    headingFontCss: "'Vazirmatn', Tahoma, sans-serif",
    desc: 'فونت مدرن و استاندارد فارسی با خوانایی عالی برای اعداد حسابداری',
  },
  noto_naskh: {
    label: 'نسخ رسمی مالیاتی (Noto Naskh)',
    sample: 'صورتحساب رسمی فروش — ۱۲۵,۴۰۰,۰۰۰ ریال',
    bodyFontCss: "'Noto Naskh Arabic', 'Vazirmatn', serif",
    headingFontCss: "'Noto Naskh Arabic', 'Vazirmatn', serif",
    desc: 'استایل رسمی و اداری مناسب فاکتورهای سامانه مودیان و دفاتر قانونی',
  },
  rubik_fa: {
    label: 'روبیک هندسی (Rubik)',
    sample: 'صورتحساب رسمی فروش — ۱۲۵,۴۰۰,۰۰۰ ریال',
    bodyFontCss: "'Rubik', 'Vazirmatn', sans-serif",
    headingFontCss: "'Rubik', 'Vazirmatn', sans-serif",
    desc: 'ظاهر مینیمال، نرم و مدرن برای برندهای تجاری معاصر',
  },
  lalezar_vazir: {
    label: 'تیتر لاله‌زار + متن وزیرمتن',
    sample: 'صورتحساب رسمی فروش — ۱۲۵,۴۰۰,۰۰۰ ریال',
    bodyFontCss: "'Vazirmatn', Tahoma, sans-serif",
    headingFontCss: "'Lalezar', 'Vazirmatn', sans-serif",
    desc: 'سربرگ شاخص و تبلیغاتی با بدنه خوانای وزیرمتن',
  },
  tahoma_classic: {
    label: 'تاهوما کلاسیک هلو (Tahoma)',
    sample: 'صورتحساب رسمی فروش — ۱۲۵,۴۰۰,۰۰۰ ریال',
    bodyFontCss: "Tahoma, 'Vazirmatn', sans-serif",
    headingFontCss: "Tahoma, 'Vazirmatn', sans-serif",
    desc: 'ظاهر سنتی و آشنای فاکتورهای قدیمی نرم‌افزارهای حسابداری ایران',
  },
};

export function reorderListItem<T>(items: T[], fromIndex: number, toIndex: number): T[] {
  if (
    fromIndex === toIndex ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= items.length ||
    toIndex >= items.length
  ) {
    return [...items];
  }
  const next = [...items];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

export function normalizeInvoiceSettings(
  raw?: Partial<InvoicePrintSettings> | null
): InvoicePrintSettings {
  const merged: InvoicePrintSettings = {
    ...DEFAULT_INVOICE_SETTINGS,
    ...(raw ?? {}),
  };

  // Validate section order contains every valid section exactly once
  const validSections = new Set<InvoiceSectionKey>(DEFAULT_INVOICE_SECTIONS);
  const rawSections = Array.isArray(merged.sectionOrder)
    ? merged.sectionOrder.filter((s): s is InvoiceSectionKey => validSections.has(s))
    : [];
  const dedupedSections = Array.from(new Set(rawSections));
  const missingSections = DEFAULT_INVOICE_SECTIONS.filter((s) => !dedupedSections.includes(s));
  merged.sectionOrder = [...dedupedSections, ...missingSections];

  // Validate column order contains every valid column exactly once
  const defaultColMap = new Map(DEFAULT_INVOICE_COLUMNS.map((c) => [c.key, c]));
  const rawCols = Array.isArray(merged.columnOrder) ? merged.columnOrder : [];
  const seenCols = new Set<InvoiceColumnKey>();
  const normalizedCols: InvoiceColumnConfig[] = [];
  for (const col of rawCols) {
    if (!col || !defaultColMap.has(col.key) || seenCols.has(col.key)) continue;
    seenCols.add(col.key);
    normalizedCols.push({
      key: col.key,
      label: (col.label || defaultColMap.get(col.key)!.label).trim(),
      visible: Boolean(col.visible),
    });
  }
  for (const defCol of DEFAULT_INVOICE_COLUMNS) {
    if (!seenCols.has(defCol.key)) {
      normalizedCols.push({ ...defCol });
    }
  }
  // Ensure at least productName & lineTotal or 1 column stays visible
  if (!normalizedCols.some((c) => c.visible)) {
    normalizedCols[0].visible = true;
  }
  merged.columnOrder = normalizedCols;

  // Clamp logo size
  const sizeNum = Number(merged.logoSizePx);
  merged.logoSizePx = Number.isFinite(sizeNum) ? Math.min(110, Math.max(36, Math.round(sizeNum))) : 60;

  if (!PERSIAN_FONT_OPTIONS[merged.fontFamily]) {
    merged.fontFamily = 'vazirmatn';
  }

  return merged;
}

const STORAGE_KEY = 'holoo_apex_invoice_settings_v1';
const SYNC_EVENT = 'holoo-invoice-settings-changed';

export function loadInvoiceSettings(): InvoicePrintSettings {
  if (typeof window === 'undefined') return normalizeInvoiceSettings(DEFAULT_INVOICE_SETTINGS);
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return normalizeInvoiceSettings(DEFAULT_INVOICE_SETTINGS);
    const parsed = JSON.parse(raw) as Partial<InvoicePrintSettings>;
    return normalizeInvoiceSettings(parsed);
  } catch {
    return normalizeInvoiceSettings(DEFAULT_INVOICE_SETTINGS);
  }
}

export function saveInvoiceSettings(patch: Partial<InvoicePrintSettings>): InvoicePrintSettings {
  const current = loadInvoiceSettings();
  const nextRaw: Partial<InvoicePrintSettings> = { ...current, ...patch };

  // Keep legacy boolean toggles synchronized when columnOrder or toggles change
  if (patch.columnOrder) {
    const map = new Map(patch.columnOrder.map((c) => [c.key, c.visible]));
    if (map.has('sku')) nextRaw.showSku = Boolean(map.get('sku'));
    if (map.has('lot')) nextRaw.showLotAndOrigin = Boolean(map.get('lot'));
    if (map.has('discount')) nextRaw.showDiscountColumn = Boolean(map.get('discount'));
    if (map.has('vat')) nextRaw.showVatColumn = Boolean(map.get('vat'));
  } else if (
    patch.showSku !== undefined ||
    patch.showLotAndOrigin !== undefined ||
    patch.showDiscountColumn !== undefined ||
    patch.showVatColumn !== undefined ||
    patch.unitDisplayMode !== undefined
  ) {
    const mode = patch.unitDisplayMode ?? current.unitDisplayMode;
    nextRaw.columnOrder = current.columnOrder.map((c) => {
      if (c.key === 'sku' && patch.showSku !== undefined) return { ...c, visible: patch.showSku };
      if (c.key === 'lot' && patch.showLotAndOrigin !== undefined) return { ...c, visible: patch.showLotAndOrigin };
      if (c.key === 'discount' && patch.showDiscountColumn !== undefined) return { ...c, visible: patch.showDiscountColumn };
      if (c.key === 'vat' && patch.showVatColumn !== undefined) return { ...c, visible: patch.showVatColumn };
      if (c.key === 'carton' && patch.unitDisplayMode !== undefined) return { ...c, visible: mode !== '1_unit' };
      if (c.key === 'bobbin' && patch.unitDisplayMode !== undefined) return { ...c, visible: mode === '3_units' };
      return c;
    });
  }

  const next = normalizeInvoiceSettings(nextRaw);
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      window.dispatchEvent(new Event(SYNC_EVENT));
    } catch {
      // Ignore storage quota errors
    }
  }
  return next;
}

export function resetInvoiceSettings(): InvoicePrintSettings {
  const fresh = normalizeInvoiceSettings(DEFAULT_INVOICE_SETTINGS);
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fresh));
      window.dispatchEvent(new Event(SYNC_EVENT));
    } catch {
      // Ignore
    }
  }
  return fresh;
}

export function useInvoiceSettings() {
  const [settings, setSettings] = useState<InvoicePrintSettings>(() => loadInvoiceSettings());

  useEffect(() => {
    const handleSync = () => setSettings(loadInvoiceSettings());
    window.addEventListener(SYNC_EVENT, handleSync);
    window.addEventListener('storage', handleSync);
    return () => {
      window.removeEventListener(SYNC_EVENT, handleSync);
      window.removeEventListener('storage', handleSync);
    };
  }, []);

  const updateSettings = (patch: Partial<InvoicePrintSettings>) => {
    const updated = saveInvoiceSettings(patch);
    setSettings(updated);
    return updated;
  };

  const reset = () => {
    const next = resetInvoiceSettings();
    setSettings(next);
    return next;
  };

  return { settings, updateSettings, reset };
}

export const TEMPLATE_LABELS: Record<InvoiceTemplateStyle, { title: string; desc: string }> = {
  modern_textile: {
    title: 'مدرن بازرگانی نخ',
    desc: 'طراحی خوانا با تفکیک وزن/کارتن/بوبین، شماره لات و باکس بانکی',
  },
  official_tax: {
    title: 'رسمی سامانه مودیان',
    desc: 'فرمت استاندارد کادردار سازمان امور مالیاتی با شناسه یکتای مالیاتی',
  },
  holoo_classic: {
    title: 'کلاسیک هلو شرکتی',
    desc: 'چیدمان سنتی و آشنا برای کاربران هلو با مانده قبل و بعد از فاکتور',
  },
  compact_a5: {
    title: 'نیم‌برگ سریع (A5)',
    desc: 'طراحی فشرده و سریع برای چاپ تحویل بار انبار و قبض فروش',
  },
};

export const UNIT_MODE_LABELS: Record<InvoiceUnitMode, { title: string; desc: string }> = {
  '1_unit': {
    title: '۱ واحدی (فقط کیلوگرم)',
    desc: 'نمایش وزن خالص (کیلوگرم) و فی هر کیلو',
  },
  '2_units': {
    title: '۲ واحدی (کارتن/عدل + کیلوگرم)',
    desc: 'نمایش تعداد کارتن/عدل و وزن کل باسکول',
  },
  '3_units': {
    title: '۳ واحدی (کارتن + دوک/بوبین + کیلوگرم)',
    desc: 'کامل‌ترین حالت صنف نخ: کارتن/عدل، تعداد دوک/بوبین و وزن کل',
  },
};

export const PAPER_SIZE_LABELS: Record<InvoicePaperSize, string> = {
  A4: 'برگه کامل A4',
  A5: 'نیم‌برگ A5',
  thermal_80mm: 'فیش پرینتر ۸ سانتی',
};

export const ACCENT_THEMES: Record<
  InvoiceAccentColor,
  { label: string; headerBg: string; border: string; text: string; softBg: string; swatch: string }
> = {
  teal: {
    label: 'سبز فیروزه‌ای',
    headerBg: 'bg-teal-800 text-white',
    border: 'border-teal-700',
    text: 'text-teal-800',
    softBg: 'bg-teal-50',
    swatch: 'bg-teal-700',
  },
  navy: {
    label: 'سرمه‌ای رسمی',
    headerBg: 'bg-blue-950 text-white',
    border: 'border-blue-900',
    text: 'text-blue-900',
    softBg: 'bg-blue-50',
    swatch: 'bg-blue-900',
  },
  emerald: {
    label: 'زمردی بازرگانی',
    headerBg: 'bg-emerald-800 text-white',
    border: 'border-emerald-700',
    text: 'text-emerald-800',
    softBg: 'bg-emerald-50',
    swatch: 'bg-emerald-700',
  },
  slate: {
    label: 'ذغالی مودیان',
    headerBg: 'bg-slate-900 text-white',
    border: 'border-slate-900',
    text: 'text-slate-900',
    softBg: 'bg-slate-100',
    swatch: 'bg-slate-800',
  },
  rose: {
    label: 'زرشکی کلاسیک',
    headerBg: 'bg-rose-900 text-white',
    border: 'border-rose-800',
    text: 'text-rose-900',
    softBg: 'bg-rose-50',
    swatch: 'bg-rose-800',
  },
};
