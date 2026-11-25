import React, { useRef, useState } from 'react';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDown,
  ArrowUp,
  Check,
  Columns3,
  Eye,
  GripVertical,
  ImagePlus,
  Layers,
  Palette,
  RotateCcw,
  Trash2,
  Type,
} from 'lucide-react';
import {
  ACCENT_THEMES,
  InvoiceAccentColor,
  InvoiceColumnConfig,
  InvoiceFontSizeScale,
  InvoiceLogoPosition,
  InvoicePaperSize,
  InvoicePersianFont,
  InvoicePrintSettings,
  InvoiceSectionKey,
  InvoiceTemplateStyle,
  InvoiceUnitMode,
  PAPER_SIZE_LABELS,
  PERSIAN_FONT_OPTIONS,
  SECTION_LABELS,
  TEMPLATE_LABELS,
  UNIT_MODE_LABELS,
  reorderListItem,
} from '../lib/invoiceSettings';
import { toPersianDigits } from '../lib/format';

interface InvoiceTemplateDesignerProps {
  settings: InvoicePrintSettings;
  companyName: string;
  nationalId?: string;
  economicCode?: string;
  onUpdate: (patch: Partial<InvoicePrintSettings>) => void;
  onReset: () => void;
  onNotify: (msg: string) => void;
}

const SAMPLE_ITEMS = [
  {
    rowNum: '۱',
    sku: 'YN-150-48',
    productName: 'نخ پلی‌استر DTY 150/48 نیمه‌مات سفید',
    lot: 'LOT-405A',
    carton: '۱۲ کارتن',
    bobbin: '۱۴۴ بوبین',
    quantity: '۳۰۰ کیلوگرم',
    unitPrice: '۱۸۵,۰۰۰',
    discount: '۵۰۰,۰۰۰',
    vat: '۵,۵۰۰,۰۰۰',
    lineTotal: '۶۰,۵۰۰,۰۰۰',
  },
  {
    rowNum: '۲',
    sku: 'YN-30-1',
    productName: 'نخ پنبه شانه ۳۰/۱ هندی درجه یک',
    lot: 'LOT-405B',
    carton: '۸ عدل',
    bobbin: '۹۶ بوبین',
    quantity: '۲۰۰ کیلوگرم',
    unitPrice: '۲۴۰,۰۰۰',
    discount: '—',
    vat: '۴,۸۰۰,۰۰۰',
    lineTotal: '۵۲,۸۰۰,۰۰۰',
  },
];

export const InvoiceTemplateDesigner: React.FC<InvoiceTemplateDesignerProps> = ({
  settings,
  companyName,
  nationalId,
  economicCode,
  onUpdate,
  onReset,
  onNotify,
}) => {
  const [activeDesignerTab, setActiveDesignerTab] = useState<
    'columns' | 'sections' | 'logo_font' | 'texts'
  >('columns');
  const [draggedColIdx, setDraggedColIdx] = useState<number | null>(null);
  const [dragOverColIdx, setDragOverColIdx] = useState<number | null>(null);
  const [draggedSecIdx, setDraggedSecIdx] = useState<number | null>(null);
  const [dragOverSecIdx, setDragOverSecIdx] = useState<number | null>(null);
  const [logoDragActive, setLogoDragActive] = useState(false);
  const logoInputRef = useRef<HTMLInputElement | null>(null);

  const activeAccent = ACCENT_THEMES[settings.accentColor];
  const fontSpec = PERSIAN_FONT_OPTIONS[settings.fontFamily] || PERSIAN_FONT_OPTIONS.vazirmatn;
  const visibleColumns = settings.columnOrder.filter((c) => c.visible);

  const fontScaleClass =
    settings.fontSizeScale === 'sm'
      ? 'text-[10px]'
      : settings.fontSizeScale === 'lg'
        ? 'text-[12.5px]'
        : 'text-[11px]';

  // Compress uploaded logo safely into lightweight DataURL so localStorage stays fast
  const processLogoFile = (file: File) => {
    if (!file.type.startsWith('image/')) {
      onNotify('لطفاً فقط فایل تصویری معتبر (PNG، JPG، WebP یا SVG) انتخاب کنید.');
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      onNotify('حجم فایل لوگو نباید بیشتر از ۴ مگابایت باشد.');
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const rawUrl = String(reader.result || '');
      if (file.type === 'image/svg+xml') {
        onUpdate({ logoDataUrl: rawUrl });
        onNotify('لوگوی برداری (SVG) با موفقیت در قالب فاکتور ثبت شد.');
        return;
      }
      const img = new Image();
      img.onload = () => {
        const maxDim = 260;
        const ratio = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.max(24, Math.round(img.width * ratio));
        const h = Math.max(24, Math.round(img.height * ratio));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.clearRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);
          const compressed = canvas.toDataURL('image/png', 0.9);
          onUpdate({ logoDataUrl: compressed });
          onNotify('لوگوی شرکت با موفقیت بارگذاری و بهینه‌سازی شد.');
        }
      };
      img.onerror = () => onNotify('خواندن تصویر لوگو با خطا مواجه شد.');
      img.src = rawUrl;
    };
    reader.readAsDataURL(file);
  };

  // Column Drag & Drop handlers
  const handleDropColumn = (targetIdx: number) => {
    if (draggedColIdx === null || draggedColIdx === targetIdx) {
      setDraggedColIdx(null);
      setDragOverColIdx(null);
      return;
    }
    const nextCols = reorderListItem(settings.columnOrder, draggedColIdx, targetIdx);
    onUpdate({ columnOrder: nextCols });
    setDraggedColIdx(null);
    setDragOverColIdx(null);
  };

  const handleToggleColumn = (key: InvoiceColumnConfig['key']) => {
    const current = settings.columnOrder.find((c) => c.key === key);
    if (current?.visible && visibleColumns.length <= 1) {
      onNotify('حداقل یک ستون باید در جدول فاکتور فعال بماند.');
      return;
    }
    onUpdate({
      columnOrder: settings.columnOrder.map((c) =>
        c.key === key ? { ...c, visible: !c.visible } : c
      ),
    });
  };

  const handleRenameColumn = (key: InvoiceColumnConfig['key'], nextLabel: string) => {
    onUpdate({
      columnOrder: settings.columnOrder.map((c) =>
        c.key === key ? { ...c, label: nextLabel } : c
      ),
    });
  };

  // Section Drag & Drop handlers
  const handleDropSection = (targetIdx: number) => {
    if (draggedSecIdx === null || draggedSecIdx === targetIdx) {
      setDraggedSecIdx(null);
      setDragOverSecIdx(null);
      return;
    }
    const nextSecs = reorderListItem(settings.sectionOrder, draggedSecIdx, targetIdx);
    onUpdate({ sectionOrder: nextSecs });
    setDraggedSecIdx(null);
    setDragOverSecIdx(null);
  };

  // Render each draggable invoice block in the live WYSIWYG canvas
  const renderPreviewSection = (secKey: InvoiceSectionKey) => {
    if (secKey === 'header') {
      const logoImg = settings.logoDataUrl ? (
        <img
          src={settings.logoDataUrl}
          alt="لوگوی شرکت"
          style={{ height: `${settings.logoSizePx}px`, maxWidth: '150px' }}
          className="object-contain rounded bg-white/95 p-1 border border-slate-200/70 shrink-0"
        />
      ) : null;

      return (
        <div
          key="header"
          className={`p-4 rounded-lg ${
            settings.template === 'modern_textile'
              ? activeAccent.headerBg
              : `border-b-2 ${activeAccent.border} bg-white text-slate-900`
          }`}
        >
          {settings.logoPosition === 'center' && logoImg && (
            <div className="flex justify-center mb-2.5">{logoImg}</div>
          )}
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              {settings.logoPosition === 'right' && logoImg}
              <div className="min-w-0">
                <div
                  style={{ fontFamily: fontSpec.headingFontCss }}
                  className="text-sm sm:text-base font-extrabold truncate"
                >
                  {companyName}
                </div>
                <div className="text-[10px] opacity-85 mt-0.5">
                  شناسه ملی: {toPersianDigits(nationalId || '14001234567')} · کد اقتصادی:{' '}
                  {toPersianDigits(economicCode || '411223344556')}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <div className="text-left text-[10px] leading-5">
                <div
                  style={{ fontFamily: fontSpec.headingFontCss }}
                  className="text-xs font-bold"
                >
                  {settings.customTitle || 'صورتحساب رسمی فروش'}
                </div>
                <div className="font-code opacity-90">شماره: F-1405-1024</div>
                <div className="font-code opacity-90">تاریخ: ۱۴۰۵/۰۸/۱۴</div>
              </div>
              {settings.logoPosition === 'left' && logoImg}
            </div>
          </div>
        </div>
      );
    }

    if (secKey === 'parties') {
      return (
        <div
          key="parties"
          className={`grid grid-cols-1 sm:grid-cols-2 gap-2.5 p-3 rounded-lg border ${
            settings.template === 'holoo_classic'
              ? 'bg-white border-slate-400'
              : `${activeAccent.softBg} border-slate-200`
          }`}
        >
          <div className="space-y-0.5">
            <div>
              <span className="text-slate-500">خریدار: </span>
              <strong className="text-slate-900">کارخانه نساجی پارس‌بافت یزد</strong>
            </div>
            <div className="text-[10px] text-slate-600 font-code">
              شناسه ملی: ۱۴۰۱۴۵۸۹۱۲۰ · تلفن: ۰۳۵-۳۷۲۴۱۹۰۰
            </div>
          </div>
          <div className="space-y-0.5">
            <div>
              <span className="text-slate-500">انبار تحویل: </span>
              <strong className="text-slate-900">انبار مرکزی نخ شادآباد</strong>
            </div>
            {settings.sellerAddress && (
              <div className="text-[10px] text-slate-600 truncate">{settings.sellerAddress}</div>
            )}
          </div>
        </div>
      );
    }

    if (secKey === 'items') {
      return (
        <div key="items" className="overflow-x-auto">
          <table className="w-full text-right border-collapse border border-slate-300">
            <thead>
              <tr className="bg-slate-100 text-slate-800 border-b-2 border-slate-400">
                {visibleColumns.map((col) => (
                  <th
                    key={col.key}
                    className={`py-1.5 px-2 border-l border-slate-300 font-bold whitespace-nowrap ${
                      col.key === 'unitPrice' ||
                      col.key === 'discount' ||
                      col.key === 'vat' ||
                      col.key === 'lineTotal'
                        ? 'text-left'
                        : col.key === 'rowNum'
                          ? 'text-center'
                          : 'text-right'
                    }`}
                  >
                    {col.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {SAMPLE_ITEMS.map((item, idx) => (
                <tr key={idx} className={idx % 2 === 1 ? 'bg-slate-50/70' : 'bg-white'}>
                  {visibleColumns.map((col) => {
                    const isNum =
                      col.key === 'unitPrice' ||
                      col.key === 'discount' ||
                      col.key === 'vat' ||
                      col.key === 'lineTotal';
                    return (
                      <td
                        key={col.key}
                        className={`py-1.5 px-2 border-l border-slate-200 ${
                          isNum
                            ? 'text-left font-code tabular-nums whitespace-nowrap'
                            : col.key === 'rowNum'
                              ? 'text-center font-code'
                              : col.key === 'sku' || col.key === 'lot'
                                ? 'font-code whitespace-nowrap'
                                : ''
                        }`}
                      >
                        {item[col.key]}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }

    if (secKey === 'totals') {
      return (
        <div
          key="totals"
          className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1"
        >
          <div className="space-y-1 text-[10.5px] text-slate-700">
            {settings.showAmountInWords && (
              <div className="p-2 rounded bg-slate-50 border border-slate-200">
                <span className="text-slate-500">مبلغ کل به حروف: </span>
                <strong className="text-slate-900">یکصد و سیزده میلیون و سیصد هزار ریال</strong>
              </div>
            )}
            {settings.showPartyBalance && (
              <div className="p-2 rounded bg-slate-50 border border-slate-200 font-code flex items-center justify-between">
                <span>مانده قبل: ۴۰,۰۰۰,۰۰۰</span>
                <strong className={activeAccent.text}>مانده جدید: ۱۵۳,۳۰۰,۰۰۰</strong>
              </div>
            )}
          </div>
          <div className="border border-slate-300 rounded-lg p-2.5 space-y-1 bg-slate-50/70">
            <div className="flex justify-between">
              <span className="text-slate-600">جمع ناخالص:</span>
              <span className="font-code tabular-nums">۱۰۳,۵۰۰,۰۰۰</span>
            </div>
            {settings.showDiscountColumn && (
              <div className="flex justify-between text-rose-700">
                <span>تخفیف:</span>
                <span className="font-code tabular-nums">(۵۰۰,۰۰۰)</span>
              </div>
            )}
            {settings.showVatColumn && (
              <div className="flex justify-between">
                <span>مالیات ارزش افزوده (۱۰٪):</span>
                <span className="font-code tabular-nums">۱۰,۳۰۰,۰۰۰</span>
              </div>
            )}
            <div className="flex justify-between pt-1.5 border-t-2 border-slate-800 font-extrabold text-slate-900">
              <span>مبلغ قابل پرداخت:</span>
              <span className={`font-code tabular-nums ${activeAccent.text}`}>۱۱۳,۳۰۰,۰۰۰ ریال</span>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div key="footer" className="space-y-2.5 pt-1 border-t border-slate-200">
        {settings.bankInfo && (
          <div className="p-2 rounded bg-slate-50 border border-slate-200 text-[10px] text-slate-700">
            <strong>اطلاعات بانکی واریز: </strong>
            {settings.bankInfo}
          </div>
        )}
        {settings.footerTerms && (
          <div className="text-[10px] text-slate-600 leading-relaxed">{settings.footerTerms}</div>
        )}
        {settings.showSignatures && (
          <div className="grid grid-cols-3 gap-2 pt-2">
            {['مهر و امضای فروشنده', 'تحویل‌دهنده انبار / باسکول', 'مهر و امضای خریدار'].map((role) => (
              <div
                key={role}
                className="border border-dashed border-slate-300 rounded py-3 px-2 text-center text-[10px] text-slate-600"
              >
                {role}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-5">
      {/* Header Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 dark:border-slate-800 pb-3">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-teal-700/10 dark:bg-teal-400/10 text-teal-700 dark:text-teal-400 flex items-center justify-center">
            <Palette className="w-4 h-4" />
          </div>
          <div>
            <h2 className="text-sm font-bold text-slate-900 dark:text-white">
              طراح بصری Drag & Drop قالب فاکتور، ستون‌ها، لوگو و فونت فارسی
            </h2>
            <p className="text-[11px] text-slate-500 mt-0.5">
              ستون‌ها و بخش‌های فاکتور را با کشیدن و رها کردن (Drag & Drop) جابه‌جا کنید، لوگوی شرکت را بارگذاری کنید و فونت فارسی دلخواه را انتخاب نمایید.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            onReset();
            onNotify('قالب فاکتور، ستون‌ها، لوگو و فونت به حالت استاندارد بازنشانی شد.');
          }}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 text-xs"
        >
          <RotateCcw className="w-3.5 h-3.5" />
          <span>بازنشانی پیش‌فرض</span>
        </button>
      </div>

      {/* Main Split Studio: Controls (Right) + Live Interactive Preview (Left) */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-5 items-start">
        {/* Controls Column */}
        <div className="xl:col-span-5 space-y-4">
          {/* Sub-navigation Tabs */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-1 p-1 rounded-xl bg-slate-100 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-[11px]">
            {[
              { id: 'columns', label: 'ستون‌ها (Drag)', icon: Columns3 },
              { id: 'sections', label: 'چیدمان بخش‌ها', icon: Layers },
              { id: 'logo_font', label: 'لوگو و فونت فارسی', icon: Type },
              { id: 'texts', label: 'متن و قالب پایه', icon: Palette },
            ].map((t) => {
              const Icon = t.icon;
              const active = activeDesignerTab === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setActiveDesignerTab(t.id as typeof activeDesignerTab)}
                  className={`inline-flex items-center justify-center gap-1 py-2 px-2 rounded-lg font-semibold transition-colors ${
                    active
                      ? 'bg-white dark:bg-slate-800 text-teal-800 dark:text-teal-300 shadow-sm'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5 shrink-0" />
                  <span className="truncate">{t.label}</span>
                </button>
              );
            })}
          </div>

          {/* Tab 1: Drag-and-Drop Columns */}
          {activeDesignerTab === 'columns' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between text-[11px] text-slate-500">
                <span>ستون‌ها را بکشید و رها کنید یا عنوان هر ستون را ویرایش نمایید:</span>
                <span className="font-code font-bold text-teal-700 dark:text-teal-400">
                  {toPersianDigits(visibleColumns.length)} از {toPersianDigits(settings.columnOrder.length)} فعال
                </span>
              </div>

              <div className="space-y-1.5">
                {settings.columnOrder.map((col, idx) => (
                  <div
                    key={col.key}
                    draggable
                    onDragStart={() => setDraggedColIdx(idx)}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDragOverColIdx(idx);
                    }}
                    onDragLeave={() => setDragOverColIdx(null)}
                    onDrop={(e) => {
                      e.preventDefault();
                      handleDropColumn(idx);
                    }}
                    onDragEnd={() => {
                      setDraggedColIdx(null);
                      setDragOverColIdx(null);
                    }}
                    className={`flex items-center gap-2 p-2 rounded-lg border transition-all cursor-grab active:cursor-grabbing ${
                      dragOverColIdx === idx
                        ? 'border-teal-600 bg-teal-50/70 dark:bg-teal-950/40 ring-2 ring-teal-500/20'
                        : col.visible
                          ? 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950/60'
                          : 'border-slate-200/70 dark:border-slate-800/60 bg-slate-50/60 dark:bg-slate-950/20 opacity-65'
                    }`}
                  >
                    <GripVertical className="w-4 h-4 text-slate-400 shrink-0" />
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={col.visible}
                      onClick={() => handleToggleColumn(col.key)}
                      className={`w-4 h-4 rounded flex items-center justify-center border shrink-0 transition-colors ${
                        col.visible
                          ? 'bg-teal-700 border-teal-700 text-white'
                          : 'bg-white dark:bg-slate-900 border-slate-300 dark:border-slate-700'
                      }`}
                    >
                      {col.visible && <Check className="w-3 h-3 stroke-[3]" />}
                    </button>
                    <input
                      type="text"
                      value={col.label}
                      onChange={(e) => handleRenameColumn(col.key, e.target.value)}
                      className="flex-1 min-w-0 px-2 py-1 text-xs rounded border border-transparent hover:border-slate-200 dark:hover:border-slate-700 focus:border-teal-500 bg-transparent text-slate-900 dark:text-slate-100 font-medium"
                      placeholder="عنوان ستون"
                    />
                    <div className="flex items-center gap-0.5 shrink-0">
                      <button
                        type="button"
                        disabled={idx === 0}
                        onClick={() =>
                          onUpdate({ columnOrder: reorderListItem(settings.columnOrder, idx, idx - 1) })
                        }
                        title="جابه‌جایی به راست"
                        className="p-1 rounded text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 disabled:opacity-25"
                      >
                        <ArrowUp className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        disabled={idx === settings.columnOrder.length - 1}
                        onClick={() =>
                          onUpdate({ columnOrder: reorderListItem(settings.columnOrder, idx, idx + 1) })
                        }
                        title="جابه‌جایی به چپ"
                        className="p-1 rounded text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 disabled:opacity-25"
                      >
                        <ArrowDown className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Tab 2: Drag-and-Drop Page Sections */}
          {activeDesignerTab === 'sections' && (
            <div className="space-y-3">
              <p className="text-[11px] text-slate-500">
                ترتیب بلوک‌های فاکتور را با کشیدن و رها کردن تغییر دهید (مثلاً می‌توانید کادر جمع کل را بالاتر یا مشخصات طرفین را بالای سربرگ قرار دهید):
              </p>
              <div className="space-y-2">
                {settings.sectionOrder.map((secKey, idx) => (
                  <div
                    key={secKey}
                    draggable
                    onDragStart={() => setDraggedSecIdx(idx)}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDragOverSecIdx(idx);
                    }}
                    onDragLeave={() => setDragOverSecIdx(null)}
                    onDrop={(e) => {
                      e.preventDefault();
                      handleDropSection(idx);
                    }}
                    onDragEnd={() => {
                      setDraggedSecIdx(null);
                      setDragOverSecIdx(null);
                    }}
                    className={`flex items-center justify-between gap-2.5 p-3 rounded-xl border cursor-grab active:cursor-grabbing transition-all ${
                      dragOverSecIdx === idx
                        ? 'border-teal-600 bg-teal-50/70 dark:bg-teal-950/40 ring-2 ring-teal-500/20'
                        : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950/60'
                    }`}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <GripVertical className="w-4 h-4 text-slate-400 shrink-0" />
                      <span className="w-5 h-5 rounded-md bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 font-code text-[11px] font-bold flex items-center justify-center shrink-0">
                        {toPersianDigits(idx + 1)}
                      </span>
                      <div className="min-w-0">
                        <div className="text-xs font-bold text-slate-900 dark:text-white truncate">
                          {SECTION_LABELS[secKey].title}
                        </div>
                        <div className="text-[10.5px] text-slate-500 truncate">
                          {SECTION_LABELS[secKey].desc}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-0.5 shrink-0">
                      <button
                        type="button"
                        disabled={idx === 0}
                        onClick={() =>
                          onUpdate({ sectionOrder: reorderListItem(settings.sectionOrder, idx, idx - 1) })
                        }
                        className="p-1 rounded text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 disabled:opacity-25"
                      >
                        <ArrowUp className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        disabled={idx === settings.sectionOrder.length - 1}
                        onClick={() =>
                          onUpdate({ sectionOrder: reorderListItem(settings.sectionOrder, idx, idx + 1) })
                        }
                        className="p-1 rounded text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 disabled:opacity-25"
                      >
                        <ArrowDown className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-2 gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
                {(
                  [
                    ['showPartyBalance', 'مانده قبلی و جدید مشتری'],
                    ['showAmountInWords', 'مبلغ کل به حروف فارسی'],
                    ['showSignatures', 'کادر مهر و امضا'],
                    ['showTaxQrBox', 'کیوآرکد سامانه مودیان'],
                  ] as const
                ).map(([key, label]) => (
                  <label
                    key={key}
                    className="inline-flex items-center gap-2 p-2 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200/80 dark:border-slate-800 cursor-pointer text-[11px] text-slate-700 dark:text-slate-300"
                  >
                    <input
                      type="checkbox"
                      checked={settings[key]}
                      onChange={(e) => onUpdate({ [key]: e.target.checked })}
                      className="accent-teal-700 rounded"
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* Tab 3: Logo Upload & Persian Font Studio */}
          {activeDesignerTab === 'logo_font' && (
            <div className="space-y-4">
              {/* Drag & Drop Logo Uploader */}
              <div className="space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-900 dark:text-white">
                    لوگوی اختصاصی شرکت در سربرگ فاکتور
                  </span>
                  {settings.logoDataUrl && (
                    <button
                      type="button"
                      onClick={() => {
                        onUpdate({ logoDataUrl: '' });
                        onNotify('لوگو از قالب فاکتور حذف شد.');
                      }}
                      className="inline-flex items-center gap-1 text-[11px] text-rose-600 hover:underline"
                    >
                      <Trash2 className="w-3 h-3" />
                      <span>حذف لوگو</span>
                    </button>
                  )}
                </div>

                <div
                  onDragOver={(e) => {
                    e.preventDefault();
                    setLogoDragActive(true);
                  }}
                  onDragLeave={() => setLogoDragActive(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setLogoDragActive(false);
                    const file = e.dataTransfer.files?.[0];
                    if (file) processLogoFile(file);
                  }}
                  onClick={() => logoInputRef.current?.click()}
                  className={`p-4 rounded-xl border-2 border-dashed text-center cursor-pointer transition-colors ${
                    logoDragActive
                      ? 'border-teal-600 bg-teal-50/70 dark:bg-teal-950/30'
                      : 'border-slate-300 dark:border-slate-700 hover:border-teal-500 bg-slate-50/70 dark:bg-slate-950/40'
                  }`}
                >
                  <input
                    ref={logoInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/svg+xml"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) processLogoFile(file);
                      e.target.value = '';
                    }}
                  />
                  {settings.logoDataUrl ? (
                    <div className="flex items-center justify-center gap-3">
                      <img
                        src={settings.logoDataUrl}
                        alt="پیش‌نمایش لوگو"
                        className="h-12 max-w-[120px] object-contain rounded border border-slate-200 bg-white p-1"
                      />
                      <div className="text-right text-[11px] text-slate-600 dark:text-slate-300">
                        <div className="font-bold text-teal-700 dark:text-teal-400">لوگو بارگذاری شد</div>
                        <div>برای تعویض، فایل جدید را بکشید یا کلیک کنید</div>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-1">
                      <ImagePlus className="w-6 h-6 mx-auto text-teal-700 dark:text-teal-400" />
                      <div className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                        تصویر لوگو را اینجا بکشید و رها کنید (یا کلیک کنید)
                      </div>
                      <div className="text-[10.5px] text-slate-500">
                        فرمت‌های PNG، JPG، WebP و SVG — بهینه‌سازی خودکار برای چاپ
                      </div>
                    </div>
                  )}
                </div>

                {/* Logo Alignment & Size */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <span className="block text-[11px] text-slate-500 mb-1">جایگاه لوگو</span>
                    <div className="grid grid-cols-3 gap-1">
                      {(
                        [
                          ['right', 'راست', AlignRight],
                          ['center', 'وسط', AlignCenter],
                          ['left', 'چپ', AlignLeft],
                        ] as [InvoiceLogoPosition, string, typeof AlignRight][]
                      ).map(([pos, label, Icon]) => (
                        <button
                          key={pos}
                          type="button"
                          onClick={() => onUpdate({ logoPosition: pos })}
                          className={`inline-flex items-center justify-center gap-1 py-1.5 rounded-lg border text-[11px] font-medium ${
                            settings.logoPosition === pos
                              ? 'border-teal-600 bg-teal-50 dark:bg-teal-950/40 text-teal-800 dark:text-teal-300'
                              : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400'
                          }`}
                        >
                          <Icon className="w-3.5 h-3.5" />
                          <span>{label}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <div className="flex justify-between text-[11px] text-slate-500 mb-1">
                      <span>اندازه لوگو</span>
                      <span className="font-code">{toPersianDigits(settings.logoSizePx)} px</span>
                    </div>
                    <input
                      type="range"
                      min={36}
                      max={105}
                      value={settings.logoSizePx}
                      onChange={(e) => onUpdate({ logoSizePx: Number(e.target.value) })}
                      className="w-full accent-teal-700 mt-1.5"
                    />
                  </div>
                </div>
              </div>

              {/* Persian Font Picker */}
              <div className="space-y-2 pt-3 border-t border-slate-200 dark:border-slate-800">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-900 dark:text-white">
                    انتخاب فونت فارسی فاکتور
                  </span>
                  <div className="inline-flex items-center gap-1 text-[11px]">
                    {(
                      [
                        ['sm', 'کوچک'],
                        ['md', 'متوسط'],
                        ['lg', 'بزرگ'],
                      ] as [InvoiceFontSizeScale, string][]
                    ).map(([sz, lbl]) => (
                      <button
                        key={sz}
                        type="button"
                        onClick={() => onUpdate({ fontSizeScale: sz })}
                        className={`px-2 py-0.5 rounded border ${
                          settings.fontSizeScale === sz
                            ? 'border-teal-600 bg-teal-50 dark:bg-teal-950/40 text-teal-800 dark:text-teal-300 font-bold'
                            : 'border-slate-200 dark:border-slate-700 text-slate-500'
                        }`}
                      >
                        {lbl}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-1.5">
                  {(Object.keys(PERSIAN_FONT_OPTIONS) as InvoicePersianFont[]).map((fontKey) => {
                    const opt = PERSIAN_FONT_OPTIONS[fontKey];
                    const active = settings.fontFamily === fontKey;
                    return (
                      <button
                        key={fontKey}
                        type="button"
                        onClick={() => onUpdate({ fontFamily: fontKey })}
                        className={`w-full text-right p-2.5 rounded-xl border transition-colors ${
                          active
                            ? 'border-teal-600 bg-teal-50/70 dark:bg-teal-950/40'
                            : 'border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/40'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span
                            style={{ fontFamily: opt.headingFontCss }}
                            className="text-xs font-bold text-slate-900 dark:text-white"
                          >
                            {opt.label}
                          </span>
                          {active && (
                            <span className="text-[10px] font-bold text-teal-700 dark:text-teal-400">
                              فعال
                            </span>
                          )}
                        </div>
                        <div
                          style={{ fontFamily: opt.bodyFontCss }}
                          className="text-[11px] text-slate-700 dark:text-slate-300 mt-1"
                        >
                          {opt.sample}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* Tab 4: Base Template, Accent, Paper, Unit Mode & Custom Texts */}
          {activeDesignerTab === 'texts' && (
            <div className="space-y-3.5">
              <div className="grid grid-cols-2 gap-2">
                {(Object.keys(TEMPLATE_LABELS) as InvoiceTemplateStyle[]).map((tpl) => (
                  <button
                    key={tpl}
                    type="button"
                    onClick={() => onUpdate({ template: tpl })}
                    className={`p-2.5 rounded-lg border text-right transition-colors ${
                      settings.template === tpl
                        ? 'border-teal-600 bg-teal-50/70 dark:bg-teal-950/40'
                        : 'border-slate-200 dark:border-slate-800'
                    }`}
                  >
                    <div className="font-bold text-slate-900 dark:text-white text-xs">
                      {TEMPLATE_LABELS[tpl].title}
                    </div>
                  </button>
                ))}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-500 mb-1">ابعاد کاغذ چاپ</label>
                  <select
                    value={settings.paperSize}
                    onChange={(e) => onUpdate({ paperSize: e.target.value as InvoicePaperSize })}
                    className="w-full px-2.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
                  >
                    {Object.entries(PAPER_SIZE_LABELS).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-slate-500 mb-1">حالت چندواحدی</label>
                  <select
                    value={settings.unitDisplayMode}
                    onChange={(e) => onUpdate({ unitDisplayMode: e.target.value as InvoiceUnitMode })}
                    className="w-full px-2.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
                  >
                    {(Object.keys(UNIT_MODE_LABELS) as InvoiceUnitMode[]).map((m) => (
                      <option key={m} value={m}>
                        {UNIT_MODE_LABELS[m].title}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-slate-500 mb-1">تم رنگی سربرگ و تیتر فاکتور</label>
                <div className="flex flex-wrap items-center gap-1.5">
                  {(Object.keys(ACCENT_THEMES) as InvoiceAccentColor[]).map((col) => (
                    <button
                      key={col}
                      type="button"
                      onClick={() => onUpdate({ accentColor: col })}
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border text-[11px] ${
                        settings.accentColor === col
                          ? 'border-slate-900 dark:border-white font-bold'
                          : 'border-slate-200 dark:border-slate-700 text-slate-500'
                      }`}
                    >
                      <span className={`w-3 h-3 rounded-sm ${ACCENT_THEMES[col].swatch}`} />
                      <span>{ACCENT_THEMES[col].label}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-slate-500 mb-1">عنوان سربرگ فاکتور</label>
                <input
                  value={settings.customTitle}
                  onChange={(e) => onUpdate({ customTitle: e.target.value })}
                  placeholder="عنوان چاپی بالای فاکتور فروش"
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                <div>
                  <label className="block text-slate-500 mb-1">نشانی فروشنده / انبار</label>
                  <input
                    value={settings.sellerAddress}
                    onChange={(e) => onUpdate({ sellerAddress: e.target.value })}
                    placeholder="نشانی دقیق دفتر یا انبار"
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label className="block text-slate-500 mb-1">تلفن فروشنده</label>
                  <input
                    value={settings.sellerPhone}
                    onChange={(e) => onUpdate({ sellerPhone: e.target.value })}
                    placeholder="شماره تلفن تماس فروشنده"
                    className="w-full px-3 py-2 font-code rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
              </div>

              <div>
                <label className="block text-slate-500 mb-1">
                  شماره شبا و مشخصات حساب بانکی (درج در فاکتور و پیام‌رسان‌ها)
                </label>
                <input
                  value={settings.bankInfo}
                  onChange={(e) => onUpdate({ bankInfo: e.target.value })}
                  placeholder="نام بانک، شماره حساب یا شبا جهت واریز وجه"
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>

              <div>
                <label className="block text-slate-500 mb-1">توضیحات و شرایط پاورقی فاکتور</label>
                <textarea
                  rows={2}
                  value={settings.footerTerms}
                  onChange={(e) => onUpdate({ footerTerms: e.target.value })}
                  placeholder="شرایط تحویل، مهلت تسویه یا توضیحات حقوقی پایین فاکتور"
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
            </div>
          )}
        </div>

        {/* Live WYSIWYG Interactive Invoice Preview Canvas */}
        <div className="xl:col-span-7 space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500">
            <div className="inline-flex items-center gap-1.5 font-semibold text-slate-700 dark:text-slate-300">
              <Eye className="w-3.5 h-3.5 text-teal-700 dark:text-teal-400" />
              <span>پیش‌نمایش زنده قالب فاکتور (ذخیره خودکار آنی)</span>
            </div>
            <span className="font-code text-teal-700 dark:text-teal-400">
              {PAPER_SIZE_LABELS[settings.paperSize]} · {fontSpec.label}
            </span>
          </div>

          <div className="rounded-xl bg-slate-100/90 dark:bg-slate-950 p-3 sm:p-4 border border-slate-200 dark:border-slate-800 overflow-x-auto">
            <div
              dir="rtl"
              style={{ fontFamily: fontSpec.bodyFontCss }}
              className={`mx-auto bg-white text-slate-900 rounded-lg shadow-lg border ${
                settings.template === 'official_tax'
                  ? 'border-2 border-slate-900'
                  : 'border-slate-300'
              } p-4 sm:p-5 space-y-3.5 min-w-[540px] ${fontScaleClass}`}
            >
              {settings.sectionOrder.map((secKey) => renderPreviewSection(secKey))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
