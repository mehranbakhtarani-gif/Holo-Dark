import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Check,
  Columns3,
  Download,
  FileSpreadsheet,
  FileText,
  Loader2,
  Printer,
  RotateCcw,
  X,
} from 'lucide-react';
import { CompanyProfile } from '../types/accounting';
import {
  AccountingReportPrintOptions,
  ReportOrientation,
  SavedReportColumnState,
  StandardAccountingReportSpec,
  exportSelectedColumnsCsv,
  exportStandardAccountingReportPdf,
  getDefaultColumnState,
  loadSavedReportColumnState,
  moveReportColumnOrder,
  printStandardAccountingReport,
  resolveOrderedColumns,
  resolveVisibleColumns,
  saveReportColumnState,
  toggleReportColumnSelection,
} from '../lib/accountingReportExport';
import { getTodayShamsi, toPersianDigits } from '../lib/format';

interface ReportPrintPdfModalProps {
  open: boolean;
  onClose: () => void;
  spec: StandardAccountingReportSpec;
  profile: CompanyProfile;
  operatorName?: string;
  onNotify?: (msg: string, type?: 'success' | 'error' | 'warning' | 'neutral') => void;
}

export const ReportPrintPdfModal: React.FC<ReportPrintPdfModalProps> = ({
  open,
  onClose,
  spec,
  profile,
  operatorName,
  onNotify,
}) => {
  const [colState, setColState] = useState<SavedReportColumnState>(() =>
    loadSavedReportColumnState(spec.reportId, spec.columns)
  );
  const [orientation, setOrientation] = useState<ReportOrientation>(spec.recommendedOrientation);
  const [showRowNumbers, setShowRowNumbers] = useState(true);
  const [showSignatures, setShowSignatures] = useState(true);
  const [showKpis, setShowKpis] = useState(Boolean(spec.kpis && spec.kpis.length > 0));
  const [compactDensity, setCompactDensity] = useState(false);
  const [customSubtitle, setCustomSubtitle] = useState('');
  const [exportingPdf, setExportingPdf] = useState(false);
  const [printing, setPrinting] = useState(false);

  // Sync saved column selection and smart defaults whenever user switches report tab or opens modal
  useEffect(() => {
    if (!open) return;
    const loaded = loadSavedReportColumnState(spec.reportId, spec.columns);
    setColState(loaded);
    setOrientation(spec.recommendedOrientation);
    setShowKpis(Boolean(spec.kpis && spec.kpis.length > 0));
    setCompactDensity(loaded.selectedKeys.length >= 8);
    setCustomSubtitle('');
  }, [open, spec.reportId, spec.recommendedOrientation, spec.columns, spec.kpis]);

  const orderedColumns = useMemo(
    () => resolveOrderedColumns(spec.columns, colState),
    [spec.columns, colState]
  );

  const visibleColumns = useMemo(
    () => resolveVisibleColumns(spec.columns, colState),
    [spec.columns, colState]
  );

  const printOptions: AccountingReportPrintOptions = useMemo(
    () => ({
      orientation,
      showRowNumbers,
      showSignatures,
      showKpis,
      compactDensity,
      customSubtitle,
      preparedBy: operatorName || profile.displayName,
    }),
    [orientation, showRowNumbers, showSignatures, showKpis, compactDensity, customSubtitle, operatorName, profile.displayName]
  );

  if (!open) return null;

  const updateColumns = (next: SavedReportColumnState) => {
    setColState(next);
    saveReportColumnState(spec.reportId, next);
  };

  const handleToggleColumn = (key: string) => {
    if (colState.selectedKeys.includes(key) && colState.selectedKeys.length <= 1) {
      onNotify?.('حداقل یک ستون باید برای نمایش در گزارش انتخاب باشد.', 'warning');
      return;
    }
    updateColumns(toggleReportColumnSelection(colState, key));
  };

  const handleMoveColumn = (key: string, dir: 'up' | 'down') => {
    updateColumns(moveReportColumnOrder(colState, key, dir));
  };

  const handleSelectAll = () => {
    const allKeys = colState.orderedKeys;
    updateColumns({ orderedKeys: allKeys, selectedKeys: [...allKeys] });
  };

  const handleResetDefaults = () => {
    const def = getDefaultColumnState(spec.columns);
    updateColumns(def);
    setOrientation(spec.recommendedOrientation);
  };

  const handleSelectEssentialOnly = () => {
    const essentialKeys = colState.orderedKeys.filter((k) => {
      const col = spec.columns.find((c) => c.key === k);
      return Boolean(col?.essential);
    });
    const fallbackKeys =
      essentialKeys.length > 0 ? essentialKeys : colState.orderedKeys.slice(0, Math.min(4, colState.orderedKeys.length));
    updateColumns({ orderedKeys: colState.orderedKeys, selectedKeys: fallbackKeys });
  };

  const handleExportPdf = async () => {
    setExportingPdf(true);
    try {
      const fileName = await exportStandardAccountingReportPdf(
        spec,
        visibleColumns,
        profile,
        printOptions
      );
      onNotify?.(`فایل PDF استاندارد حسابداری (${fileName}) با موفقیت آماده و دانلود شد.`, 'success');
    } catch (err) {
      onNotify?.(
        err instanceof Error ? err.message : 'خطا در تولید فایل PDF گزارش. لطفاً دوباره تلاش کنید.',
        'error'
      );
    } finally {
      setExportingPdf(false);
    }
  };

  const handlePrint = async () => {
    setPrinting(true);
    try {
      await printStandardAccountingReport(spec, visibleColumns, profile, printOptions);
    } catch (err) {
      onNotify?.(
        err instanceof Error ? err.message : 'خطا در باز کردن پنجره چاپ استاندارد.',
        'error'
      );
    } finally {
      setPrinting(false);
    }
  };

  const handleExportCsv = () => {
    exportSelectedColumnsCsv(spec, visibleColumns, showRowNumbers, profile.fiscalYear);
    onNotify?.(
      `فایل اکسل (CSV) با ${toPersianDigits(visibleColumns.length)} ستون انتخابی دریافت شد.`,
      'success'
    );
  };

  const printDate = toPersianDigits(getTodayShamsi());
  const currencyLabel = spec.currencyUnit === 'IRT' ? 'تومان ایران' : 'ریال ایران';
  const effectiveSubtitle = customSubtitle.trim() || spec.subtitle || '';
  const companyMetaParts: string[] = [];
  if (profile.economicCode) companyMetaParts.push(`کد اقتصادی: ${toPersianDigits(profile.economicCode)}`);
  if (profile.nationalId) companyMetaParts.push(`شناسه ملی: ${toPersianDigits(profile.nationalId)}`);

  const previewWidthClass =
    orientation === 'landscape' ? 'min-w-[820px] max-w-[1060px]' : 'min-w-[600px] max-w-[780px]';

  let previewRowSeq = 0;

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-950/65 backdrop-blur-[2px] flex items-center justify-center p-2 sm:p-4 overflow-y-auto no-print"
      role="dialog"
      aria-modal="true"
      aria-label="خروجی PDF و چاپ استاندارد گزارش حسابداری"
    >
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl w-full max-w-[1320px] max-h-[94vh] flex flex-col overflow-hidden">
        {/* Modal Header */}
        <div className="px-4 sm:px-6 py-3.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3 bg-slate-50/80 dark:bg-slate-950/60 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-teal-700/10 dark:bg-teal-400/10 text-teal-700 dark:text-teal-400 flex items-center justify-center shrink-0">
              <FileText className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm sm:text-base font-bold text-slate-900 dark:text-white truncate">
                خروجی PDF و چاپ رسمی با استایل استاندارد حسابداری
              </h2>
              <p className="text-[11px] sm:text-xs text-slate-500 dark:text-slate-400 truncate">
                {spec.title} — انتخاب و مرتب‌سازی ستون‌های چاپی، تنظیمات برگه A4 و پیش‌نمایش زنده
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg text-slate-500 hover:text-slate-800 dark:hover:text-white hover:bg-slate-200/70 dark:hover:bg-slate-800 transition-colors shrink-0"
            title="بستن پنجره"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body: Settings Sidebar + Live Accounting Sheet Preview */}
        <div className="flex-1 min-h-0 flex flex-col lg:flex-row overflow-hidden">
          {/* Right Settings Column */}
          <aside className="w-full lg:w-[360px] xl:w-[390px] border-b lg:border-b-0 lg:border-l border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex flex-col max-h-[46vh] lg:max-h-none overflow-y-auto shrink-0">
            <div className="p-4 space-y-5">
              {/* Section 1: Column Picker & Reorder */}
              <div className="space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 text-xs font-bold text-slate-900 dark:text-white">
                    <Columns3 className="w-4 h-4 text-teal-700 dark:text-teal-400" />
                    <span>انتخاب ستون‌های نمایش‌داده‌شده</span>
                  </div>
                  <span className="text-[11px] font-code font-semibold text-teal-700 dark:text-teal-400">
                    {toPersianDigits(visibleColumns.length)} از {toPersianDigits(spec.columns.length)} ستون
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                  <button
                    type="button"
                    onClick={handleSelectAll}
                    className="px-2.5 py-1 rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/70 text-slate-700 dark:text-slate-200 hover:border-teal-500 transition-colors"
                  >
                    انتخاب همه
                  </button>
                  <button
                    type="button"
                    onClick={handleSelectEssentialOnly}
                    className="px-2.5 py-1 rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/70 text-slate-700 dark:text-slate-200 hover:border-teal-500 transition-colors"
                  >
                    ستون‌های کلیدی
                  </button>
                  <button
                    type="button"
                    onClick={handleResetDefaults}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/70 text-slate-600 dark:text-slate-300 hover:border-teal-500 transition-colors"
                  >
                    <RotateCcw className="w-3 h-3" />
                    <span>پیش‌فرض</span>
                  </button>
                </div>

                <div className="border border-slate-200 dark:border-slate-800 rounded-xl divide-y divide-slate-100 dark:divide-slate-800/80 max-h-60 overflow-y-auto bg-slate-50/40 dark:bg-slate-950/30">
                  {orderedColumns.map((col, idx) => {
                    const checked = colState.selectedKeys.includes(col.key);
                    return (
                      <div
                        key={col.key}
                        className={`px-3 py-2 flex items-center justify-between gap-2 text-xs transition-colors ${
                          checked
                            ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100'
                            : 'text-slate-400 dark:text-slate-500'
                        }`}
                      >
                        <div className="flex items-center gap-2.5 flex-1 cursor-pointer select-none min-w-0">
                          <button
                            type="button"
                            role="checkbox"
                            aria-checked={checked}
                            onClick={() => handleToggleColumn(col.key)}
                            className={`w-4 h-4 rounded flex items-center justify-center border transition-colors shrink-0 ${
                              checked
                                ? 'bg-teal-700 border-teal-700 text-white'
                                : 'bg-white dark:bg-slate-950 border-slate-300 dark:border-slate-700'
                            }`}
                          >
                            {checked && <Check className="w-3 h-3 stroke-[3]" />}
                          </button>
                          <span className="truncate font-medium" onClick={() => handleToggleColumn(col.key)}>
                            {col.label}
                          </span>
                        </div>
                        <div className="flex items-center gap-0.5 shrink-0">
                          <button
                            type="button"
                            disabled={idx === 0}
                            onClick={() => handleMoveColumn(col.key, 'up')}
                            title="انتقال ستون به راست"
                            className="p-1 rounded text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 disabled:opacity-25"
                          >
                            <ArrowUp className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            disabled={idx === orderedColumns.length - 1}
                            onClick={() => handleMoveColumn(col.key, 'down')}
                            title="انتقال ستون به چپ"
                            className="p-1 rounded text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 disabled:opacity-25"
                          >
                            <ArrowDown className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Section 2: Page & Accounting Standard Style Options */}
              <div className="space-y-3 pt-2 border-t border-slate-200 dark:border-slate-800">
                <div className="text-xs font-bold text-slate-900 dark:text-white">
                  تنظیمات صفحه‌بندی و قالب رسمی حسابداری
                </div>

                <div>
                  <span className="block text-[11px] text-slate-500 dark:text-slate-400 mb-1.5">
                    جهت برگه A4
                  </span>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => setOrientation('portrait')}
                      className={`py-2 px-3 rounded-lg border text-xs font-semibold transition-colors ${
                        orientation === 'portrait'
                          ? 'border-teal-600 bg-teal-50 dark:bg-teal-950/40 text-teal-800 dark:text-teal-300'
                          : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400'
                      }`}
                    >
                      عمودی (Portrait)
                    </button>
                    <button
                      type="button"
                      onClick={() => setOrientation('landscape')}
                      className={`py-2 px-3 rounded-lg border text-xs font-semibold transition-colors ${
                        orientation === 'landscape'
                          ? 'border-teal-600 bg-teal-50 dark:bg-teal-950/40 text-teal-800 dark:text-teal-300'
                          : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400'
                      }`}
                    >
                      افقی (Landscape)
                    </button>
                  </div>
                </div>

                <div className="space-y-2 text-xs">
                  <label className="flex items-center justify-between gap-2 cursor-pointer py-1">
                    <span className="text-slate-700 dark:text-slate-300">نمایش ستون ردیف (شماره‌گذاری)</span>
                    <input
                      type="checkbox"
                      checked={showRowNumbers}
                      onChange={(e) => setShowRowNumbers(e.target.checked)}
                      className="accent-teal-700 w-4 h-4 rounded"
                    />
                  </label>
                  <label className="flex items-center justify-between gap-2 cursor-pointer py-1">
                    <span className="text-slate-700 dark:text-slate-300">نمایش کادر امضا و مهر رسمی شرکت</span>
                    <input
                      type="checkbox"
                      checked={showSignatures}
                      onChange={(e) => setShowSignatures(e.target.checked)}
                      className="accent-teal-700 w-4 h-4 rounded"
                    />
                  </label>
                  {spec.kpis && spec.kpis.length > 0 && (
                    <label className="flex items-center justify-between gap-2 cursor-pointer py-1">
                      <span className="text-slate-700 dark:text-slate-300">نمایش خلاصه شاخص‌های کلیدی</span>
                      <input
                        type="checkbox"
                        checked={showKpis}
                        onChange={(e) => setShowKpis(e.target.checked)}
                        className="accent-teal-700 w-4 h-4 rounded"
                      />
                    </label>
                  )}
                  <label className="flex items-center justify-between gap-2 cursor-pointer py-1">
                    <span className="text-slate-700 dark:text-slate-300">حالت فشرده (مناسب جدول‌های پرستون)</span>
                    <input
                      type="checkbox"
                      checked={compactDensity}
                      onChange={(e) => setCompactDensity(e.target.checked)}
                      className="accent-teal-700 w-4 h-4 rounded"
                    />
                  </label>
                </div>

                <div>
                  <label className="block text-[11px] text-slate-500 dark:text-slate-400 mb-1">
                    زیرعنوان یا توضیح اختصاصی در سربرگ (اختیاری)
                  </label>
                  <input
                    type="text"
                    value={customSubtitle}
                    onChange={(e) => setCustomSubtitle(e.target.value)}
                    placeholder="مثلاً: جهت ارائه به حسابرس مستقل یا بانک"
                    className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                  />
                </div>
              </div>
            </div>

            {/* Sticky Action Footer inside sidebar */}
            <div className="mt-auto p-4 border-t border-slate-200 dark:border-slate-800 bg-slate-50/90 dark:bg-slate-950/70 space-y-2">
              <button
                type="button"
                disabled={exportingPdf || printing}
                onClick={handleExportPdf}
                className="w-full inline-flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl bg-teal-700 hover:bg-teal-800 text-white text-xs font-bold shadow-sm transition-colors disabled:opacity-60"
              >
                {exportingPdf ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>در حال ساخت فایل PDF استاندارد...</span>
                  </>
                ) : (
                  <>
                    <Download className="w-4 h-4" />
                    <span>دانلود مستقیم PDF استاندارد</span>
                  </>
                )}
              </button>

              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  disabled={printing || exportingPdf}
                  onClick={handlePrint}
                  className="inline-flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl border border-teal-700 dark:border-teal-500 text-teal-800 dark:text-teal-300 bg-white dark:bg-slate-900 hover:bg-teal-50 dark:hover:bg-teal-950/30 text-xs font-semibold transition-colors disabled:opacity-60"
                >
                  {printing ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Printer className="w-3.5 h-3.5" />
                  )}
                  <span>چاپ مستقیم</span>
                </button>
                <button
                  type="button"
                  onClick={handleExportCsv}
                  className="inline-flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 text-xs font-semibold transition-colors"
                >
                  <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                  <span>خروجی CSV</span>
                </button>
              </div>
            </div>
          </aside>

          {/* Left Live Preview Canvas (Pure React JSX — standard Iranian accounting layout) */}
          <section className="flex-1 min-w-0 bg-slate-200/80 dark:bg-slate-950 overflow-auto p-3 sm:p-6">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-600 dark:text-slate-400">
              <span>
                پیش‌نمایش زنده برگه A4 ({orientation === 'landscape' ? 'افقی' : 'عمودی'}) —{' '}
                {toPersianDigits(visibleColumns.length)} ستون انتخابی ·{' '}
                {toPersianDigits(spec.rows.length)} ردیف
              </span>
              <span className="font-code">
                {spec.fileNamePrefix}-{profile.fiscalYear}.pdf
              </span>
            </div>

            <div className="overflow-x-auto pb-4">
              <div
                dir="rtl"
                className={`mx-auto bg-white text-slate-900 shadow-xl border border-slate-300 rounded-sm p-5 sm:p-6 ${previewWidthClass}`}
              >
                {/* Official Accounting Letterhead */}
                <div className="border-[1.5px] border-slate-900 rounded-md px-4 py-3 mb-3">
                  <div className="flex items-start justify-between gap-4 border-b border-slate-300 pb-2.5 mb-2.5">
                    <div>
                      <div className="text-[15px] font-extrabold text-slate-900">
                        {profile.companyName}
                      </div>
                      <div className="text-[10px] text-slate-600 mt-0.5">
                        {companyMetaParts.length > 0
                          ? companyMetaParts.join('  |  ')
                          : 'گزارش رسمی مالی و دفاتر قانونی'}
                      </div>
                    </div>
                    <div className="text-center flex-1">
                      <div className="text-sm font-extrabold text-teal-800">{spec.title}</div>
                      {effectiveSubtitle && (
                        <div className="text-[10.5px] text-slate-700 mt-0.5">{effectiveSubtitle}</div>
                      )}
                    </div>
                    <div className="text-left text-[10px] text-slate-700 leading-relaxed min-w-[125px]">
                      <div>
                        تاریخ تهیه: <strong className="text-slate-900">{printDate}</strong>
                      </div>
                      <div>
                        سال مالی:{' '}
                        <strong className="text-slate-900">{toPersianDigits(profile.fiscalYear)}</strong>
                      </div>
                      <div>
                        ستون‌ها:{' '}
                        <strong className="text-slate-900">
                          {toPersianDigits(visibleColumns.length)} از {toPersianDigits(spec.columns.length)}
                        </strong>
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-[10px] text-slate-700">
                    <span>
                      دوره / بازه: <strong className="text-slate-900">{spec.periodLabel}</strong>
                    </span>
                    <span>
                      دامنه اسناد: <strong className="text-slate-900">{spec.voucherScopeLabel}</strong>
                    </span>
                    <span>
                      واحد پول: <strong className="text-slate-900">{currencyLabel}</strong>
                    </span>
                    <span>
                      تعداد ردیف: <strong className="text-slate-900">{toPersianDigits(spec.rows.length)}</strong>
                    </span>
                  </div>
                </div>

                {/* Optional KPI Summary Strip */}
                {showKpis && spec.kpis && spec.kpis.length > 0 && (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
                    {spec.kpis.map((kpi, idx) => (
                      <div
                        key={idx}
                        className="border border-slate-300 rounded px-2.5 py-1.5 bg-slate-50"
                      >
                        <div className="text-[9.5px] text-slate-600">{kpi.label}</div>
                        <div
                          dir="ltr"
                          className={`text-xs font-extrabold font-code tabular-nums text-right mt-0.5 ${
                            kpi.tone === 'positive'
                              ? 'text-emerald-700'
                              : kpi.tone === 'negative'
                                ? 'text-rose-700'
                                : kpi.tone === 'accent'
                                  ? 'text-teal-800'
                                  : 'text-slate-900'
                          }`}
                        >
                          {kpi.value}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Official Standard Accounting Grid Table */}
                <table
                  className={`w-full border-collapse border-[1.5px] border-slate-900 ${
                    compactDensity ? 'text-[10px]' : 'text-[11px]'
                  }`}
                >
                  <thead>
                    <tr className="bg-slate-100 text-slate-900">
                      {showRowNumbers && (
                        <th
                          className={`border border-slate-400 border-b-2 border-b-slate-900 text-center font-bold w-9 ${
                            compactDensity ? 'px-1.5 py-1.5' : 'px-2 py-2'
                          }`}
                        >
                          ردیف
                        </th>
                      )}
                      {visibleColumns.map((col) => (
                        <th
                          key={col.key}
                          className={`border border-slate-400 border-b-2 border-b-slate-900 font-bold whitespace-nowrap ${
                            compactDensity ? 'px-1.5 py-1.5' : 'px-2.5 py-2'
                          } ${
                            col.align === 'left' || col.isNumeric
                              ? 'text-left'
                              : col.align === 'center'
                                ? 'text-center'
                                : 'text-right'
                          }`}
                        >
                          {col.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {spec.rows.length === 0 ? (
                      <tr>
                        <td
                          colSpan={visibleColumns.length + (showRowNumbers ? 1 : 0)}
                          className="border border-slate-300 py-6 text-center text-slate-500"
                        >
                          ردیفی برای نمایش در این گزارش وجود ندارد.
                        </td>
                      </tr>
                    ) : (
                      spec.rows.map((row, rowIdx) => {
                        const isNormal = !row.rowType || row.rowType === 'normal';
                        if (isNormal) previewRowSeq += 1;
                        const rowBg =
                          row.rowType === 'section'
                            ? 'bg-slate-200 font-extrabold'
                            : row.rowType === 'subtotal'
                              ? 'bg-slate-100 font-bold'
                              : row.rowType === 'total'
                                ? 'bg-slate-100 font-extrabold border-t-2 border-t-slate-900 border-b-[3px] border-b-double border-b-slate-900'
                                : rowIdx % 2 === 1
                                  ? 'bg-slate-50/80'
                                  : 'bg-white';

                        return (
                          <tr key={row.id} className={rowBg}>
                            {showRowNumbers && (
                              <td
                                className={`border border-slate-300 text-center font-code text-slate-500 ${
                                  compactDensity ? 'px-1.5 py-1' : 'px-2 py-1.5'
                                }`}
                              >
                                {isNormal ? toPersianDigits(previewRowSeq) : ''}
                              </td>
                            )}
                            {visibleColumns.map((col) => {
                              const value = row.cells[col.key] ?? '—';
                              const highlightText =
                                (col.isNumeric || row.rowType === 'total' || row.rowType === 'subtotal') &&
                                row.highlight === 'positive'
                                  ? 'text-emerald-700'
                                  : (col.isNumeric || row.rowType === 'total' || row.rowType === 'subtotal') &&
                                      row.highlight === 'negative'
                                    ? 'text-rose-700'
                                    : (col.isNumeric || row.rowType === 'total' || row.rowType === 'subtotal') &&
                                        row.highlight === 'accent'
                                      ? 'text-teal-800'
                                      : 'text-slate-900';

                              return (
                                <td
                                  key={col.key}
                                  dir={col.isNumeric ? 'ltr' : undefined}
                                  className={`border border-slate-300 ${highlightText} ${
                                    compactDensity ? 'px-1.5 py-1' : 'px-2.5 py-1.5'
                                  } ${
                                    col.isNumeric
                                      ? 'font-code tabular-nums text-left whitespace-nowrap'
                                      : col.isCode
                                        ? `font-code tabular-nums whitespace-nowrap ${
                                            col.align === 'center'
                                              ? 'text-center'
                                              : col.align === 'left'
                                                ? 'text-left'
                                                : 'text-right'
                                          }`
                                        : col.align === 'center'
                                          ? 'text-center'
                                          : col.align === 'left'
                                            ? 'text-left'
                                            : 'text-right'
                                  }`}
                                >
                                  {value}
                                </td>
                              );
                            })}
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                  {spec.footerTotals && (
                    <tfoot>
                      <tr className="bg-slate-100 font-extrabold text-slate-900">
                        {showRowNumbers && (
                          <td
                            className={`border border-slate-400 border-t-2 border-t-slate-900 border-b-[3px] border-b-double border-b-slate-900 text-center ${
                              compactDensity ? 'px-1.5 py-1.5' : 'px-2 py-2'
                            }`}
                          >
                            —
                          </td>
                        )}
                        {visibleColumns.map((col, idx) => {
                          const totalVal =
                            spec.footerTotals?.[col.key] !== undefined
                              ? spec.footerTotals[col.key]
                              : idx === 0
                                ? (spec.footerLabel ?? 'جمع کل')
                                : '';
                          return (
                            <td
                              key={col.key}
                              dir={col.isNumeric ? 'ltr' : undefined}
                              className={`border border-slate-400 border-t-2 border-t-slate-900 border-b-[3px] border-b-double border-b-slate-900 ${
                                compactDensity ? 'px-1.5 py-1.5' : 'px-2.5 py-2'
                              } ${
                                col.isNumeric
                                  ? 'font-code tabular-nums text-left whitespace-nowrap'
                                  : col.align === 'center'
                                    ? 'text-center'
                                    : 'text-right'
                              }`}
                            >
                              {totalVal}
                            </td>
                          );
                        })}
                      </tr>
                    </tfoot>
                  )}
                </table>

                {/* Accounting Notes */}
                {spec.notes && spec.notes.length > 0 && (
                  <div className="mt-2.5 px-3 py-2 border border-dashed border-slate-400 rounded bg-slate-50 text-[10px] text-slate-700 leading-relaxed">
                    <div className="font-bold text-slate-900 mb-0.5">توضیحات و یادداشت‌های حسابداری:</div>
                    {spec.notes.map((n, i) => (
                      <div key={i}>• {n}</div>
                    ))}
                  </div>
                )}

                {/* Official Signature Block */}
                {showSignatures && (
                  <div className="grid grid-cols-3 gap-3.5 mt-5">
                    <div className="border border-slate-300 rounded px-3 pt-2.5 pb-8 text-center">
                      <div className="text-[10.5px] font-bold text-slate-900">تنظیم‌کننده / حسابدار</div>
                      <div className="text-[9.5px] text-slate-500 mt-0.5">
                        {operatorName || profile.displayName || 'واحد حسابداری'}
                      </div>
                    </div>
                    <div className="border border-slate-300 rounded px-3 pt-2.5 pb-8 text-center">
                      <div className="text-[10.5px] font-bold text-slate-900">رئیس حسابداری / مدیر مالی</div>
                      <div className="text-[9.5px] text-slate-500 mt-0.5">بررسی و تایید تطابق دفاتر</div>
                    </div>
                    <div className="border border-slate-300 rounded px-3 pt-2.5 pb-8 text-center">
                      <div className="text-[10.5px] font-bold text-slate-900">مدیرعامل / مهر رسمی شرکت</div>
                      <div className="text-[9.5px] text-slate-500 mt-0.5">{profile.companyName}</div>
                    </div>
                  </div>
                )}

                {/* Page Footer Strip */}
                <div className="mt-3 pt-1.5 border-t border-slate-300 flex items-center justify-between text-[9.5px] text-slate-500">
                  <span>تهیه‌شده با استایل استاندارد حسابداری و دفاتر قانونی — {profile.companyName}</span>
                  <span>
                    صفحه‌بندی A4 ({orientation === 'landscape' ? 'افقی' : 'عمودی'}) · واحد مبالغ:{' '}
                    {currencyLabel}
                  </span>
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
};
