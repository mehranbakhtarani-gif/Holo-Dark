import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  Loader2,
  Upload,
  X,
} from 'lucide-react';
import { useAccounting } from '../context/AccountingContext';
import {
  autoMapExcelColumns,
  downloadEntityExcelTemplate,
  ParsedExcelSheet,
  parseExcelArrayBuffer,
  UNIVERSAL_IMPORT_SCHEMAS,
  UniversalImportEntity,
  validateAndTransformImportRows,
} from '../lib/universalExcelImport';
import { toPersianDigits } from '../lib/format';
import { InvoiceItem, InvoiceType, VoucherLine } from '../types/accounting';

interface UniversalExcelImportModalProps {
  open: boolean;
  initialEntity?: UniversalImportEntity;
  onClose: () => void;
}

const ENTITY_ORDER: UniversalImportEntity[] = [
  'parties',
  'products',
  'accounts',
  'vouchers',
  'invoices',
  'cheques',
  'employees',
  'costCenters',
];

export const UniversalExcelImportModal: React.FC<UniversalExcelImportModalProps> = ({
  open,
  initialEntity = 'parties',
  onClose,
}) => {
  const {
    accounts,
    parties,
    products,
    addParty,
    addProduct,
    addAccount,
    createVoucher,
    createInvoice,
    addCheque,
    addEmployee,
    addCostCenter,
    showToast,
  } = useAccounting();

  const [entity, setEntity] = useState<UniversalImportEntity>(initialEntity);
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [fileName, setFileName] = useState('');
  const [rawBuffer, setRawBuffer] = useState<ArrayBuffer | null>(null);
  const [sheet, setSheet] = useState<ParsedExcelSheet | null>(null);
  const [columnMap, setColumnMap] = useState<Record<string, string>>({});
  const [dragActive, setDragActive] = useState(false);
  const [importing, setImporting] = useState(false);
  const [commitResult, setCommitResult] = useState<{
    imported: number;
    skipped: number;
    notes: string[];
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setEntity(initialEntity);
    }
  }, [open, initialEntity]);

  const schema = UNIVERSAL_IMPORT_SCHEMAS[entity];

  const previewResult = useMemo(() => {
    if (!sheet || sheet.rows.length === 0) return null;
    return validateAndTransformImportRows(entity, sheet.rows, columnMap);
  }, [entity, sheet, columnMap]);

  if (!open) return null;

  const resetUpload = () => {
    setStep(1);
    setFileName('');
    setRawBuffer(null);
    setSheet(null);
    setColumnMap({});
    setCommitResult(null);
  };

  const handleSelectEntity = (next: UniversalImportEntity) => {
    setEntity(next);
    setCommitResult(null);
    if (sheet && sheet.headers.length > 0) {
      setColumnMap(autoMapExcelColumns(sheet.headers, next));
    }
  };

  const handleFile = async (file: File) => {
    const ext = file.name.toLowerCase();
    if (!ext.endsWith('.xlsx') && !ext.endsWith('.xls') && !ext.endsWith('.csv')) {
      showToast('لطفاً فایل معتبر اکسل (.xlsx، .xls) یا .csv انتخاب نمایید.');
      return;
    }
    try {
      const buf = await file.arrayBuffer();
      const parsed = parseExcelArrayBuffer(buf);
      if (parsed.headers.length === 0 || parsed.rows.length === 0) {
        showToast('فایل انتخاب‌شده خالی است یا سطر داده معتبری ندارد.');
        return;
      }
      setRawBuffer(buf);
      setFileName(file.name);
      setSheet(parsed);
      setColumnMap(autoMapExcelColumns(parsed.headers, entity));
      setCommitResult(null);
      setStep(2);
    } catch {
      showToast('خواندن فایل اکسل با خطا مواجه شد؛ لطفاً سلامت فایل را بررسی کنید.');
    }
  };

  const handleSwitchSheet = (sheetName: string) => {
    if (!rawBuffer) return;
    const parsed = parseExcelArrayBuffer(rawBuffer, sheetName);
    setSheet(parsed);
    setColumnMap(autoMapExcelColumns(parsed.headers, entity));
  };

  const handleCommitImport = async () => {
    if (!previewResult || previewResult.validRows.length === 0 || importing) return;
    setImporting(true);
    let imported = 0;
    let skipped = 0;
    const notes: string[] = [];

    try {
      if (entity === 'parties') {
        for (const row of previewResult.validRows as any[]) {
          try {
            await addParty(row);
            imported++;
          } catch (e: any) {
            skipped++;
            notes.push(`${row.name}: ${e?.message || 'خطا در ثبت'}`);
          }
        }
      } else if (entity === 'products') {
        for (const row of previewResult.validRows as any[]) {
          try {
            await addProduct(row);
            imported++;
          } catch (e: any) {
            skipped++;
            notes.push(`${row.name}: ${e?.message || 'خطا در ثبت'}`);
          }
        }
      } else if (entity === 'accounts') {
        const existingCodes = new Set(accounts.map((a) => a.code));
        for (const row of previewResult.validRows as any[]) {
          if (existingCodes.has(row.code)) {
            skipped++;
            notes.push(`کد حساب ${row.code} تکراری است و رد شد.`);
            continue;
          }
          try {
            await addAccount(row);
            existingCodes.add(row.code);
            imported++;
          } catch (e: any) {
            skipped++;
            notes.push(`${row.code}: ${e?.message || 'خطا در ثبت'}`);
          }
        }
      } else if (entity === 'vouchers') {
        const accMap = new Map(accounts.map((a) => [a.code, a.title]));
        for (const doc of previewResult.validRows as any[]) {
          try {
            const lines: VoucherLine[] = doc.lines.map((l: any) => {
              const matchedParty = l.partyName
                ? parties.find(
                    (p) =>
                      p.name.includes(l.partyName) ||
                      p.code.toLowerCase() === String(l.partyName).toLowerCase()
                  )
                : undefined;
              return {
                accountCode: l.accountCode,
                accountTitle: accMap.get(l.accountCode) || `حساب ${l.accountCode}`,
                partyId: matchedParty?.id,
                partyName: matchedParty?.name,
                description: l.description,
                debit: l.debit,
                credit: l.credit,
              };
            });
            await createVoucher({
              date: doc.date,
              description: doc.description,
              voucherType: doc.voucherType || 'general',
              status: 'draft',
              lines,
              allowDuplicate: true,
            });
            imported++;
          } catch (e: any) {
            skipped++;
            notes.push(`سند ${doc.groupKey}: ${e?.message || 'خطا در ثبت'}`);
          }
        }
      } else if (entity === 'invoices') {
        for (const doc of previewResult.validRows as any[]) {
          try {
            const matchedParty =
              parties.find(
                (p) =>
                  p.name.includes(doc.partyName) ||
                  doc.partyName.includes(p.name) ||
                  p.code.toLowerCase() === String(doc.partyName).toLowerCase()
              ) || parties[0];

            if (!matchedParty) {
              skipped++;
              notes.push(`فاکتور ${doc.invoiceNumber}: طرف‌حسابی در سیستم تعریف نشده است.`);
              continue;
            }

            const items: InvoiceItem[] = doc.items.map((it: any) => {
              const matchedProd =
                products.find(
                  (p) =>
                    p.sku.toLowerCase() === String(it.productName).toLowerCase() ||
                    p.name.includes(it.productName) ||
                    it.productName.includes(p.name)
                ) || products[0];
              const gross = Math.round(it.quantity * it.unitPrice);
              const taxable = Math.max(0, gross - it.discount);
              const vatAmount = Math.round((taxable * it.vatRate) / 100);
              const lineTotal = taxable + vatAmount;
              return {
                productId: matchedProd?.id || `xl-prod-${it.productName}`,
                sku: matchedProd?.sku || 'XL-ITEM',
                productName: matchedProd?.name || it.productName,
                unit: matchedProd?.unit || 'کیلوگرم',
                quantity: it.quantity,
                unitPrice: it.unitPrice,
                discount: it.discount,
                vatAmount,
                lineTotal,
              };
            });

            const subtotal = items.reduce((s, it) => s + Math.round(it.quantity * it.unitPrice), 0);
            const discount = items.reduce((s, it) => s + it.discount, 0);
            const vatAmount = items.reduce((s, it) => s + it.vatAmount, 0);
            const grandTotal = Math.max(0, subtotal - discount + vatAmount);

            await createInvoice({
              invoiceNumber: doc.invoiceNumber,
              invoiceType: doc.invoiceType as InvoiceType,
              date: doc.date,
              partyId: matchedParty.id,
              partyName: matchedParty.name,
              warehouse: products[0]?.warehouse || 'انبار مرکزی',
              subtotal,
              discount,
              vatAmount,
              grandTotal,
              paidCash: 0,
              paidBank: 0,
              paidCheque: 0,
              creditAmount: grandTotal,
              status: 'issued',
              items,
            });
            imported++;
          } catch (e: any) {
            skipped++;
            notes.push(`فاکتور ${doc.invoiceNumber}: ${e?.message || 'خطا در ثبت'}`);
          }
        }
      } else if (entity === 'cheques') {
        for (const row of previewResult.validRows as any[]) {
          try {
            const matchedParty =
              parties.find(
                (p) => p.name.includes(row.partyName) || row.partyName.includes(p.name)
              ) || parties[0];
            if (!matchedParty) {
              skipped++;
              notes.push(`چک ${row.sayadiId}: طرف‌حسابی یافت نشد.`);
              continue;
            }
            await addCheque({
              sayadiId: row.sayadiId,
              serial: row.serial,
              direction: row.direction,
              partyId: matchedParty.id,
              partyName: matchedParty.name,
              bankName: row.bankName,
              amount: row.amount,
              issueDate: row.issueDate,
              dueDate: row.dueDate,
              status: row.status,
              notes: row.notes,
            });
            imported++;
          } catch (e: any) {
            skipped++;
            notes.push(`چک ${row.sayadiId}: ${e?.message || 'خطا در ثبت'}`);
          }
        }
      } else if (entity === 'employees') {
        for (const row of previewResult.validRows as any[]) {
          try {
            await addEmployee(row);
            imported++;
          } catch (e: any) {
            skipped++;
            notes.push(`${row.fullName}: ${e?.message || 'خطا در ثبت'}`);
          }
        }
      } else if (entity === 'costCenters') {
        for (const row of previewResult.validRows as any[]) {
          try {
            await addCostCenter(row);
            imported++;
          } catch (e: any) {
            skipped++;
            notes.push(`${row.name}: ${e?.message || 'خطا در ثبت'}`);
          }
        }
      }

      setCommitResult({ imported, skipped, notes });
      if (imported > 0) {
        showToast(
          `${toPersianDigits(imported)} رکورد از فایل اکسل با موفقیت در بخش «${schema.title}» ثبت شد.`
        );
      }
    } finally {
      setImporting(false);
    }
  };

  return (
    <div
      dir="rtl"
      className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex items-center justify-center p-3 sm:p-5 no-print"
    >
      <div className="w-full max-w-4xl max-h-[90vh] flex flex-col rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3 bg-slate-50/80 dark:bg-slate-950/60">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-emerald-600/10 dark:bg-emerald-400/10 text-emerald-700 dark:text-emerald-400 flex items-center justify-center shrink-0">
              <FileSpreadsheet className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm sm:text-base font-bold text-slate-900 dark:text-white truncate">
                موتور جامع ورود داده از اکسل (Excel / CSV) برای تمامی بخش‌ها
              </h2>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                انتقال یکپارچه اطلاعات از هلو، سپیدار، همکاران سیستم یا هر فایل اکسل با نگاشت هوشمند ستون‌ها
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Stepper */}
        <div className="px-5 py-2.5 border-b border-slate-100 dark:border-slate-800 flex items-center gap-3 text-xs bg-white dark:bg-slate-900">
          {[
            { num: 1, label: '۱. انتخاب بخش و بارگذاری اکسل' },
            { num: 2, label: '۲. تطبیق خودکار ستون‌ها' },
            { num: 3, label: '۳. پیش‌نمایش و ثبت نهایی' },
          ].map((s) => (
            <button
              key={s.num}
              type="button"
              disabled={s.num > 1 && !sheet}
              onClick={() => setStep(s.num as 1 | 2 | 3)}
              className={`px-3 py-1 rounded-lg font-semibold transition-colors disabled:opacity-40 ${
                step === s.num
                  ? 'bg-emerald-600 text-white'
                  : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5 text-xs">
          {/* Step 1: Entity Selector + Upload */}
          {step === 1 && (
            <>
              <div className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label className="font-bold text-slate-800 dark:text-slate-200">
                    بخش مقصد ورود اطلاعات را انتخاب کنید:
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      downloadEntityExcelTemplate(entity);
                      showToast(`فایل نمونه اکسل «${schema.title}» دانلود شد.`);
                    }}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-emerald-200 dark:border-emerald-800 bg-emerald-50/70 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-300 font-semibold hover:bg-emerald-100 dark:hover:bg-emerald-900/50"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>دانلود فایل نمونه اکسل ({schema.title})</span>
                  </button>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                  {ENTITY_ORDER.map((id) => {
                    const item = UNIVERSAL_IMPORT_SCHEMAS[id];
                    const active = entity === id;
                    return (
                      <button
                        key={id}
                        type="button"
                        onClick={() => handleSelectEntity(id)}
                        className={`p-3 rounded-xl border text-right transition-all ${
                          active
                            ? 'border-emerald-600 bg-emerald-50/80 dark:bg-emerald-950/40 ring-2 ring-emerald-500/20'
                            : 'border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50'
                        }`}
                      >
                        <div className="font-bold text-slate-900 dark:text-white">{item.title}</div>
                        <div className="text-[10.5px] text-slate-500 dark:text-slate-400 mt-1 line-clamp-2 leading-4">
                          {item.subtitle}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Dropzone */}
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragActive(true);
                }}
                onDragLeave={() => setDragActive(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragActive(false);
                  const f = e.dataTransfer.files?.[0];
                  if (f) void handleFile(f);
                }}
                onClick={() => fileInputRef.current?.click()}
                className={`p-8 rounded-2xl border-2 border-dashed text-center cursor-pointer transition-colors ${
                  dragActive
                    ? 'border-emerald-600 bg-emerald-50/70 dark:bg-emerald-950/30'
                    : 'border-slate-300 dark:border-slate-700 hover:border-emerald-500 bg-slate-50/60 dark:bg-slate-950/40'
                }`}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void handleFile(f);
                    e.target.value = '';
                  }}
                />
                <Upload className="w-8 h-8 mx-auto text-emerald-600 dark:text-emerald-400 mb-2" />
                <div className="text-sm font-bold text-slate-900 dark:text-white">
                  فایل اکسل (.xlsx / .xls / .csv) را اینجا بکشید و رها کنید یا کلیک کنید
                </div>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1.5">
                  ستون‌های فارسی و انگلیسی به‌طور خودکار تشخیص داده می‌شوند و نیازی به یکسان بودن دقیق نام ستون‌ها نیست.
                </p>
              </div>
            </>
          )}

          {/* Step 2: Column Mapping */}
          {step === 2 && sheet && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2 p-3 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                <div>
                  <span className="font-bold text-slate-900 dark:text-white">{fileName}</span>
                  <span className="text-slate-500 mr-2">
                    ({toPersianDigits(sheet.rows.length)} ردیف · {toPersianDigits(sheet.headers.length)} ستون)
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {sheet.sheetNames.length > 1 && (
                    <select
                      value={sheet.sheetName}
                      onChange={(e) => handleSwitchSheet(e.target.value)}
                      className="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                    >
                      {sheet.sheetNames.map((sn) => (
                        <option key={sn} value={sn}>
                          برگه: {sn}
                        </option>
                      ))}
                    </select>
                  )}
                  <button
                    type="button"
                    onClick={resetUpload}
                    className="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-white dark:hover:bg-slate-800"
                  >
                    تعویض فایل
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {schema.fields.map((field) => (
                  <div
                    key={field.key}
                    className="p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950/50 space-y-1.5"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-bold text-slate-900 dark:text-white">
                        {field.label}
                        {field.required && <span className="text-rose-600 mr-1">*</span>}
                      </span>
                      <span className="text-[10.5px] text-slate-400 truncate max-w-[160px]">
                        {field.hint}
                      </span>
                    </div>
                    <select
                      value={columnMap[field.key] || ''}
                      onChange={(e) =>
                        setColumnMap((prev) => ({ ...prev, [field.key]: e.target.value }))
                      }
                      className={`w-full px-3 py-2 rounded-lg border bg-white dark:bg-slate-900 ${
                        columnMap[field.key]
                          ? 'border-emerald-400 dark:border-emerald-700'
                          : field.required
                            ? 'border-amber-400 dark:border-amber-700'
                            : 'border-slate-200 dark:border-slate-700'
                      }`}
                    >
                      <option value="">— انتخاب نشده (رد شود) —</option>
                      {sheet.headers.map((h) => (
                        <option key={h} value={h}>
                          {h}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Step 3: Validation Preview & Commit */}
          {step === 3 && previewResult && (
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-3">
                <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                  <div className="text-[11px] text-slate-500">کل ردیف‌های اکسل</div>
                  <div className="text-lg font-extrabold font-code text-slate-900 dark:text-white mt-0.5">
                    {toPersianDigits(previewResult.totalRows)}
                  </div>
                </div>
                <div className="p-3 rounded-xl bg-emerald-50/70 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900">
                  <div className="text-[11px] text-emerald-700 dark:text-emerald-400">رکورد معتبر آماده ثبت</div>
                  <div className="text-lg font-extrabold font-code text-emerald-800 dark:text-emerald-300 mt-0.5">
                    {toPersianDigits(previewResult.validRows.length)}
                  </div>
                </div>
                <div className="p-3 rounded-xl bg-rose-50/70 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-900">
                  <div className="text-[11px] text-rose-700 dark:text-rose-400">ردیف دارای خطا / رد شده</div>
                  <div className="text-lg font-extrabold font-code text-rose-800 dark:text-rose-300 mt-0.5">
                    {toPersianDigits(previewResult.errors.length)}
                  </div>
                </div>
              </div>

              {previewResult.errors.length > 0 && (
                <div className="p-3 rounded-xl border border-amber-300 dark:border-amber-800 bg-amber-50/70 dark:bg-amber-950/30 space-y-1">
                  <div className="flex items-center gap-1.5 font-bold text-amber-800 dark:text-amber-300">
                    <AlertTriangle className="w-4 h-4 shrink-0" />
                    <span>هشدارهای اعتبارسنجی ({toPersianDigits(previewResult.errors.length)} مورد):</span>
                  </div>
                  <ul className="list-disc list-inside text-[11px] text-amber-900 dark:text-amber-200 space-y-0.5 max-h-28 overflow-y-auto">
                    {previewResult.errors.slice(0, 10).map((err, i) => (
                      <li key={i}>
                        ردیف {toPersianDigits(err.rowIndex)}: {err.message}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {commitResult && (
                <div className="p-3.5 rounded-xl border border-emerald-300 dark:border-emerald-800 bg-emerald-50/80 dark:bg-emerald-950/40 space-y-1.5">
                  <div className="flex items-center gap-2 font-bold text-emerald-800 dark:text-emerald-300">
                    <CheckCircle2 className="w-4 h-4 shrink-0" />
                    <span>
                      ورود اطلاعات تکمیل شد: {toPersianDigits(commitResult.imported)} رکورد ثبت شد
                      {commitResult.skipped > 0
                        ? ` · ${toPersianDigits(commitResult.skipped)} مورد رد شد`
                        : ''}
                    </span>
                  </div>
                  {commitResult.notes.length > 0 && (
                    <div className="text-[11px] text-slate-700 dark:text-slate-300 max-h-24 overflow-y-auto space-y-0.5">
                      {commitResult.notes.slice(0, 8).map((n, idx) => (
                        <div key={idx}>• {n}</div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {previewResult.validRows.length > 0 && (
                <div className="border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
                  <div className="px-3 py-2 bg-slate-50 dark:bg-slate-950 text-[11px] font-semibold text-slate-600 dark:text-slate-300 border-b border-slate-200 dark:border-slate-800">
                    پیش‌نمایش رکوردهای معتبر (نمایش حداکثر ۱۰ رکورد اول)
                  </div>
                  <div className="overflow-x-auto max-h-56">
                    <table className="w-full text-right text-[11px] border-collapse">
                      <thead>
                        <tr className="bg-slate-50/80 dark:bg-slate-950/60 border-b border-slate-200 dark:border-slate-800 text-slate-500">
                          <th className="p-2">#</th>
                          {Object.keys(previewResult.validRows[0])
                            .filter((k) => k !== 'lines' && k !== 'items')
                            .slice(0, 6)
                            .map((k) => (
                              <th key={k} className="p-2 font-medium whitespace-nowrap">
                                {schema.fields.find((f) => f.key === k)?.label || k}
                              </th>
                            ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                        {previewResult.validRows.slice(0, 10).map((r, idx) => (
                          <tr key={idx}>
                            <td className="p-2 font-code text-slate-400">{toPersianDigits(idx + 1)}</td>
                            {Object.keys(previewResult.validRows[0])
                              .filter((k) => k !== 'lines' && k !== 'items')
                              .slice(0, 6)
                              .map((k) => (
                                <td key={k} className="p-2 whitespace-nowrap max-w-[180px] truncate">
                                  {toPersianDigits(String((r as any)[k] ?? '—'))}
                                </td>
                              ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3.5 border-t border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50 flex items-center justify-between gap-2 text-xs">
          <button
            type="button"
            onClick={step > 1 ? () => setStep((s) => (s === 3 ? 2 : 1)) : onClose}
            className="px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-white dark:hover:bg-slate-800"
          >
            {step > 1 ? 'مرحله قبل' : 'بستن'}
          </button>

          <div className="flex items-center gap-2">
            {step === 2 && (
              <button
                type="button"
                onClick={() => setStep(3)}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-semibold"
              >
                <span>بررسی و پیش‌نمایش داده‌ها</span>
                <ArrowLeft className="w-3.5 h-3.5" />
              </button>
            )}
            {step === 3 && (
              <button
                type="button"
                disabled={importing || !previewResult || previewResult.validRows.length === 0 || Boolean(commitResult)}
                onClick={() => void handleCommitImport()}
                className="inline-flex items-center gap-1.5 px-5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-semibold disabled:opacity-50"
              >
                {importing ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>در حال ثبت رکوردها...</span>
                  </>
                ) : commitResult ? (
                  <>
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <span>ثبت انجام شد</span>
                  </>
                ) : (
                  <>
                    <Upload className="w-3.5 h-3.5" />
                    <span>
                      ورود {toPersianDigits(previewResult?.validRows.length ?? 0)} رکورد به «{schema.title}»
                    </span>
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
