import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  FileCheck2,
  FileUp,
  FlaskConical,
  GitBranch,
  Lock,
  Paperclip,
  Play,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  TrendingUp,
  Unlock,
  Upload,
  XCircle,
} from 'lucide-react';
import { useAccounting } from '../context/AccountingContext';
import {
  AuditReviewStatus,
  evaluatePeriodClosingChecklist,
  runIndependentAuditMode,
  traceAccountLineage,
} from '../lib/accountingIntegrityEngine';
import {
  computeSandboxDiff,
  createSandboxSession,
  postSandboxInvoice,
  SandboxSession,
} from '../lib/sandboxEngine';
import {
  Holo203SourcePayload,
  HoloMigrationResult,
  parseHolo203Json,
  runHolo203Migration,
} from '../lib/holoMigrationEngine';
import {
  AttachmentEntityType,
  deleteDocumentAttachment,
  DocumentAttachmentMeta,
  DocumentSensitivity,
  listDocumentAttachments,
  retrieveVerifiedAttachment,
  saveDocumentAttachment,
} from '../lib/documentVault';
import { computeFinancialForecast } from '../lib/financialForecastEngine';
import { formatMoney, formatNumber, toPersianDigits } from '../lib/format';
import {
  computeMultiWarehouseMatrix,
  TrackedWarehouseTransfer,
} from '../lib/multiWarehouseEngine';
import { useWorkspaceExtensions } from '../context/WorkspaceExtensionsContext';
import { receiveTrackedWarehouseTransferAtomic } from '../lib/firebase';

export type EnterpriseControlTab =
  | 'independent_audit'
  | 'lineage'
  | 'sandbox'
  | 'closing_wizard'
  | 'migration'
  | 'documents'
  | 'forecast';

const SAMPLE_HOLO_203_JSON = JSON.stringify(
  {
    sourceVersion: '2.0.3',
    fiscalYear: '1405',
    companyName: 'نمونه خروجی هلو ۲.۰.۳',
    accounts: [
      { SarfaslCode: '10209', SarfaslName: 'بانک ملت شعبه بازار (مهاجرت هلو ۲.۰.۳)', category: 'asset' },
    ],
    customers: [
      { C_Code: 'H203-C01', C_Name: 'نساجی پارس (مهاجرتی)', Bedehkar: 0, Credit: 500000000 },
    ],
    products: [
      {
        A_Code: 'H203-YRN-01',
        A_Name: 'نخ پلی‌استر ۳۰۰/۹۶ مهاجرتی هلو ۲.۰.۳',
        AnbarName: 'انبار مرکزی نخ شادآباد',
        UnitName: 'کیلوگرم',
        Exist: 50,
        BuyPrice: 2000000,
        Sel_Price: 2450000,
      },
    ],
    vouchers: [
      {
        SanadNo: 9001,
        SanadDate: '1405/01/05',
        SanadDesc: 'سند انتقال مانده از هلو ۲.۰.۳',
        lines: [
          { SarfaslCode: '10209', SarfaslName: 'بانک ملت شعبه بازار (مهاجرت هلو ۲.۰.۳)', Bed: 100000000, Bes: 0 },
          { SarfaslCode: '50101', SarfaslName: 'سرمایه ثبتی شرکت', Bed: 0, Bes: 100000000 },
        ],
      },
    ],
  },
  null,
  2
);

export const EnterpriseControlPanels: React.FC<{ activeTab: EnterpriseControlTab }> = ({
  activeTab,
}) => {
  const {
    profile,
    accounts,
    parties,
    products,
    vouchers,
    invoices,
    cheques,
    assets,
    trialBalance,
    auditLogs,
    activeOperator,
    salesOrders,
    importDossiers,
    runYearEndClosing,
    reopenFiscalYear,
    commitHolo203Migration,
    showToast,
  } = useAccounting();
  const { reservedInvoices, trackedWarehouseTransfers } = useWorkspaceExtensions();

  const unit = profile.currencyUnit;

  // ---------------- 1. INDEPENDENT AUDIT MODE (READ-ONLY) ----------------
  const [reviewOverrides, setReviewOverrides] = useState<
    Record<string, { reviewStatus: AuditReviewStatus; reviewResult: string }>
  >({});

  const independentAudit = useMemo(
    () =>
      runIndependentAuditMode({
        profile,
        accounts,
        parties,
        products,
        vouchers,
        invoices,
        cheques,
        auditLogs,
        fiscalYear: profile.fiscalYear,
        reviewOverrides,
      }),
    [profile, accounts, parties, products, vouchers, invoices, cheques, auditLogs, reviewOverrides]
  );

  // ---------------- 2. LINEAGE DRILL-DOWN ----------------
  const postableAccounts = useMemo(
    () => accounts.filter((a) => a.level === 'moein' || a.level === 'tafsili'),
    [accounts]
  );
  const [selectedLineageAccount, setSelectedLineageAccount] = useState<string>('10501');

  const lineageChain = useMemo(
    () =>
      traceAccountLineage({
        accountCode: selectedLineageAccount,
        accounts,
        vouchers,
        invoices,
        cheques,
        auditLogs,
        fiscalYear: profile.fiscalYear,
        includeDrafts: false,
      }),
    [selectedLineageAccount, accounts, vouchers, invoices, cheques, auditLogs, profile.fiscalYear]
  );

  // ---------------- 3. ISOLATED SANDBOX ----------------
  const [sandbox, setSandbox] = useState<SandboxSession | null>(null);
  const [sandboxMessage, setSandboxMessage] = useState<string>('');

  const handleInitSandbox = () => {
    const s = createSandboxSession({
      profile,
      accounts,
      parties,
      products,
      vouchers,
      invoices,
      cheques,
    });
    setSandbox(s);
    setSandboxMessage('محیط آزمایشی ایزوله از آخرین وضعیت دیتابیس ساخته شد. هیچ تغییری روی داده‌های واقعی اعمال نخواهد شد.');
  };

  const handleRunSandboxSaleTest = () => {
    const base =
      sandbox ||
      createSandboxSession({
        profile,
        accounts,
        parties,
        products,
        vouchers,
        invoices,
        cheques,
      });
    const product = base.current.products.find((p) => p.stock >= 5);
    const customer = base.current.parties.find((p) => p.partyType === 'customer' || p.partyType === 'both');
    if (!product || !customer) {
      setSandboxMessage('کالای دارای موجودی کافی یا مشتری در داده‌ها یافت نشد.');
      return;
    }
    const qty = Math.min(5, Math.floor(product.stock));
    const unitPrice = product.sellPrice > 0 ? product.sellPrice : Math.round(product.buyPrice * 1.25);
    const subtotal = qty * unitPrice;
    const vat = product.vatExempt ? 0 : Math.round(subtotal * 0.1);
    const grandTotal = subtotal + vat;

    const res = postSandboxInvoice(base, {
      invoiceNumber: `SBX-SL-${Date.now().toString().slice(-4)}`,
      invoiceType: 'sale',
      date: `${base.current.profile.fiscalYear}/06/15`,
      partyId: customer.id,
      partyName: customer.name,
      warehouse: product.warehouse,
      subtotal,
      discount: 0,
      vatAmount: vat,
      grandTotal,
      paidCash: 0,
      paidBank: Math.round(grandTotal / 2),
      paidCheque: 0,
      creditAmount: grandTotal - Math.round(grandTotal / 2),
      status: 'issued',
      items: [
        {
          productId: product.id,
          sku: product.sku,
          productName: product.name,
          unit: product.unit,
          quantity: qty,
          unitPrice,
          discount: 0,
          vatAmount: vat,
          lineTotal: grandTotal,
        },
      ],
    });
    if (!res.ok) {
      setSandboxMessage(`خطای کنترل داخلی در Sandbox: ${res.error}`);
      return;
    }
    setSandbox(res.session);
    setSandboxMessage(
      `فاکتور آزمایشی فروش ${res.invoice.invoiceNumber} همراه با سند حسابداری و کسر موجودی انبار در Sandbox اجرا شد و ترازنامه مجدداً کنترل گردید.`
    );
  };

  const sandboxDiffBundle = useMemo(
    () => (sandbox ? computeSandboxDiff(sandbox) : null),
    [sandbox]
  );

  // ---------------- 4. PERIOD CLOSING & REOPENING WIZARD ----------------
  const closingChecklist = useMemo(
    () =>
      evaluatePeriodClosingChecklist({
        profile,
        accounts,
        parties,
        products,
        vouchers,
        invoices,
        cheques,
        assets,
        fiscalYear: profile.fiscalYear,
      }),
    [profile, accounts, parties, products, vouchers, invoices, cheques, assets]
  );

  const [reopenTargetYear, setReopenTargetYear] = useState<string>(
    profile.closedFiscalYears?.[0] || profile.fiscalYear
  );
  const [reopenReason, setReopenReason] = useState('');

  // ---------------- 5. HOLO 2.0.3 MIGRATION TOOL ----------------
  const [migrationJson, setMigrationJson] = useState(SAMPLE_HOLO_203_JSON);
  const [migrationPreview, setMigrationPreview] = useState<HoloMigrationResult | null>(null);
  const [migrationParseErr, setMigrationParseErr] = useState<string>('');

  const handleRunMigrationDryRun = () => {
    setMigrationParseErr('');
    const parsed = parseHolo203Json(migrationJson);
    if (!parsed.ok) {
      setMigrationParseErr(parsed.error);
      setMigrationPreview(null);
      return;
    }
    const res = runHolo203Migration({
      source: parsed.payload,
      existing: { accounts, parties, products, vouchers },
      ownerId: profile.uid,
      defaultFiscalYear: profile.fiscalYear,
      dryRun: true,
    });
    setMigrationPreview(res);
  };

  const handleCommitMigration = async () => {
    const parsed = parseHolo203Json(migrationJson);
    if (!parsed.ok) {
      setMigrationParseErr(parsed.error);
      return;
    }
    const res = await commitHolo203Migration(parsed.payload as Holo203SourcePayload);
    setMigrationPreview(res);
  };

  // ---------------- 6. OFFLINE DOCUMENT VAULT ----------------
  const [attachments, setAttachments] = useState<DocumentAttachmentMeta[]>([]);
  const [docEntityType, setDocEntityType] = useState<AttachmentEntityType>('voucher');
  const [docEntityId, setDocEntityId] = useState<string>(vouchers[0]?.id || '');
  const [docSensitivity, setDocSensitivity] = useState<DocumentSensitivity>('standard');
  const [docNotes, setDocNotes] = useState<string>('');
  const [docVerifyMsg, setDocVerifyMsg] = useState<string>('');

  const refreshAttachments = async () => {
    const list = await listDocumentAttachments({ viewerRole: activeOperator.role });
    setAttachments(list);
  };

  useEffect(() => {
    if (activeTab === 'documents') {
      void refreshAttachments();
    }
  }, [activeTab, activeOperator.role]);

  const handleFileAttach = async (file: File) => {
    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = String(reader.result || '');
      const res = await saveDocumentAttachment({
        entityType: docEntityType,
        entityId: docEntityId || 'manual_ref',
        entityLabel: `${docEntityType.toUpperCase()} — ${docEntityId || 'عمومی'}`,
        fileName: file.name,
        mimeType: file.type || 'application/pdf',
        dataUrl,
        sizeBytes: file.size,
        sensitivity: docSensitivity,
        uploadedBy: activeOperator.fullName,
        uploadedByRole: activeOperator.role,
        notes: docNotes,
      });
      if (!res.ok) {
        showToast(res.error, 'error');
        return;
      }
      showToast(`مدرک «${res.meta.fileName}» با مهر SHA-256 در بایگانی آفلاین ذخیره شد.`, 'success');
      setDocNotes('');
      await refreshAttachments();
    };
    reader.readAsDataURL(file);
  };

  const handleVerifyAndOpenDoc = async (id: string) => {
    const res = await retrieveVerifiedAttachment(id, activeOperator.role);
    if (!res.ok) {
      setDocVerifyMsg(res.error);
      showToast(res.error, 'error');
      return;
    }
    setDocVerifyMsg(
      res.integrityValid
        ? `صحت فایل «${res.record.fileName}» با SHA-256 تأیید شد (${res.record.sha256.slice(0, 16)}…).`
        : `هشدار! مهر SHA-256 فایل «${res.record.fileName}» مطابقت ندارد.`
    );
  };

  // ---------------- 7. ISOLATED FINANCIAL FORECAST + WAREHOUSE OVERVIEW ----------------
  const forecast = useMemo(
    () =>
      computeFinancialForecast({
        trialBalance,
        vouchers,
        invoices,
        cheques,
        products,
      }),
    [trialBalance, vouchers, invoices, cheques, products]
  );

  const trackedTransfers = trackedWarehouseTransfers;
  const [transferReceivedDate, setTransferReceivedDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [receivingTransferId, setReceivingTransferId] = useState<string | null>(null);

  const multiWarehouse = useMemo(
    () =>
      computeMultiWarehouseMatrix({
        products,
        salesOrders,
        reservedInvoiceItems: reservedInvoices.flatMap((r) =>
          (r.draftItems || []).map((it) => ({
            productId: it.productId,
            warehouse: r.warehouse,
            quantity: it.quantity,
          }))
        ),
        importDossiers,
        transfers: trackedTransfers,
        defaultCostingMethod: profile.defaultCostingMethod || 'moving_average',
      }),
    [products, salesOrders, reservedInvoices, importDossiers, trackedTransfers, profile.defaultCostingMethod]
  );

  const handleReceiveWarehouseTransfer = async (transfer: TrackedWarehouseTransfer) => {
    if (!activeOperator.active || activeOperator.permissions?.canEditInventory !== true) {
      showToast('اپراتور فعال مجوز دریافت انتقال انبار را ندارد.', 'error');
      return;
    }
    const product = products.find((item) => item.id === transfer.productId);
    if (!product) {
      showToast('کالای مرتبط با این انتقال یافت نشد؛ دریافت انجام نشد.', 'error');
      return;
    }
    setReceivingTransferId(transfer.id);
    try {
      await receiveTrackedWarehouseTransferAtomic({
        productId: product.id,
        transferId: transfer.id,
        receivedDate: transferReceivedDate,
      });
      showToast(
        `انتقال ${transfer.transferNumber} دریافت شد؛ موجودی کل و ارزش ریالی بدون تغییر ماند.`,
        'success'
      );
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'دریافت انتقال ناموفق بود.', 'error');
    } finally {
      setReceivingTransferId(null);
    }
  };

  // ==================== RENDER BY TAB ====================

  if (activeTab === 'independent_audit') {
    return (
      <div className="space-y-5 text-xs">
        <div className="bg-slate-900 text-white rounded-xl p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-5 h-5 text-teal-400" />
              <h2 className="text-sm font-bold">
                حالت حسابرس مستقل (Independent Audit Mode — فقط خواندنی)
              </h2>
            </div>
            <p className="text-[11px] text-slate-300 leading-relaxed">
              {independentAudit.scoreFormulaExplanation}
            </p>
            <p className="text-[11px] text-amber-300">
              {independentAudit.auditorDisclaimer}
            </p>
          </div>
          <div className="shrink-0 bg-white/10 border border-white/15 rounded-xl px-5 py-3 text-center">
            <div className="text-[11px] text-slate-300">امتیاز سلامت داده‌ها</div>
            <div className="text-2xl font-extrabold font-code tabular-nums text-teal-300 mt-0.5">
              {toPersianDigits(independentAudit.healthScore)} / ۱۰۰
            </div>
            <div className="text-[10px] text-slate-300 mt-0.5">
              تعداد رکورد تغییریافته: ۰ (Read-Only)
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          <div className="bg-white dark:bg-slate-900 border border-rose-200 dark:border-rose-900/50 rounded-xl p-3.5">
            <div className="text-[11px] text-slate-500">خطاهای بحرانی</div>
            <div className="text-lg font-bold font-code text-rose-700 dark:text-rose-400 mt-1">
              {toPersianDigits(independentAudit.criticalErrors.length)}
            </div>
          </div>
          <div className="bg-white dark:bg-slate-900 border border-amber-200 dark:border-amber-900/50 rounded-xl p-3.5">
            <div className="text-[11px] text-slate-500">خطاهای مهم</div>
            <div className="text-lg font-bold font-code text-amber-700 dark:text-amber-400 mt-1">
              {toPersianDigits(independentAudit.majorErrors.length)}
            </div>
          </div>
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3.5">
            <div className="text-[11px] text-slate-500">هشدارها</div>
            <div className="text-lg font-bold font-code text-slate-800 dark:text-slate-200 mt-1">
              {toPersianDigits(independentAudit.warnings.length)}
            </div>
          </div>
          <div className="bg-white dark:bg-slate-900 border border-emerald-200 dark:border-emerald-900/50 rounded-xl p-3.5">
            <div className="text-[11px] text-slate-500">موارد تأییدشده</div>
            <div className="text-lg font-bold font-code text-emerald-700 dark:text-emerald-400 mt-1">
              {toPersianDigits(independentAudit.verifiedItems.length)} از ۱۴
            </div>
          </div>
          <div className="bg-white dark:bg-slate-900 border border-indigo-200 dark:border-indigo-900/50 rounded-xl p-3.5">
            <div className="text-[11px] text-slate-500">نیازمند بررسی انسانی</div>
            <div className="text-lg font-bold font-code text-indigo-700 dark:text-indigo-400 mt-1">
              {toPersianDigits(independentAudit.humanReviewItems.length)}
            </div>
          </div>
        </div>

        {/* 9-Field Discrepancy Table */}
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 font-bold text-slate-900 dark:text-white">
            جدول یافته‌ها و مغایرت‌های حسابرسی مستقل (۹ شاخص استاندارد)
          </div>
          {independentAudit.allFindings.length === 0 ? (
            <div className="p-6 text-center text-emerald-700 dark:text-emerald-400 font-semibold">
              تمام ۱۴ کنترل مستقل حسابرسی بدون هیچ خطا یا مغایرتی تأیید شدند.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-right border-collapse text-[11px]">
                <thead>
                  <tr className="bg-slate-50 dark:bg-slate-950 border-b border-slate-200 dark:border-slate-800 text-slate-500">
                    <th className="py-2.5 px-3">شناسه مغایرت</th>
                    <th className="py-2.5 px-3">نوع خطا</th>
                    <th className="py-2.5 px-3">شدت</th>
                    <th className="py-2.5 px-3 text-left">مبلغ اختلاف</th>
                    <th className="py-2.5 px-3">اسناد مرتبط</th>
                    <th className="py-2.5 px-3">علت احتمالی و پیشنهاد اصلاح</th>
                    <th className="py-2.5 px-3">وضعیت رسیدگی</th>
                    <th className="py-2.5 px-3">نتیجه بررسی</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {independentAudit.allFindings.map((f) => (
                    <tr key={f.discrepancyId} className="align-top">
                      <td className="py-2.5 px-3 font-code whitespace-nowrap font-semibold">
                        {f.discrepancyId}
                      </td>
                      <td className="py-2.5 px-3 font-semibold text-slate-900 dark:text-white">
                        {f.errorType}
                      </td>
                      <td className="py-2.5 px-3 whitespace-nowrap font-bold">
                        <span
                          className={
                            f.severity === 'critical'
                              ? 'text-rose-700 dark:text-rose-400'
                              : f.severity === 'major'
                                ? 'text-amber-700 dark:text-amber-400'
                                : 'text-slate-600 dark:text-slate-300'
                          }
                        >
                          {f.severity === 'critical'
                            ? 'بحرانی'
                            : f.severity === 'major'
                              ? 'مهم'
                              : 'هشدار'}
                        </span>
                      </td>
                      <td className="py-2.5 px-3 text-left font-code tabular-nums">
                        {f.discrepancyAmount > 0 ? formatMoney(f.discrepancyAmount, unit) : '—'}
                      </td>
                      <td className="py-2.5 px-3 max-w-xs">
                        <ul className="space-y-0.5">
                          {f.relatedDocuments.slice(0, 3).map((d, i) => (
                            <li key={i} className="font-code text-slate-600 dark:text-slate-300">
                              • {d}
                            </li>
                          ))}
                        </ul>
                      </td>
                      <td className="py-2.5 px-3 max-w-sm space-y-1">
                        <div>
                          <strong className="text-slate-700 dark:text-slate-200">علت:</strong> {f.probableCause}
                        </div>
                        <div className="text-teal-700 dark:text-teal-400">
                          <strong>پیشنهاد:</strong> {f.suggestedFix}
                        </div>
                      </td>
                      <td className="py-2.5 px-3">
                        <select
                          value={f.reviewStatus}
                          onChange={(e) =>
                            setReviewOverrides((prev) => ({
                              ...prev,
                              [f.discrepancyId]: {
                                reviewStatus: e.target.value as AuditReviewStatus,
                                reviewResult:
                                  prev[f.discrepancyId]?.reviewResult || f.reviewResult,
                              },
                            }))
                          }
                          className="px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-[11px]"
                        >
                          <option value="open">باز</option>
                          <option value="in_review">در دست رسیدگی</option>
                          <option value="resolved">برطرف‌شده</option>
                          <option value="accepted_by_auditor">تأیید حسابرس</option>
                        </select>
                      </td>
                      <td className="py-2.5 px-3">
                        <input
                          value={f.reviewResult}
                          onChange={(e) =>
                            setReviewOverrides((prev) => ({
                              ...prev,
                              [f.discrepancyId]: {
                                reviewStatus: prev[f.discrepancyId]?.reviewStatus || f.reviewStatus,
                                reviewResult: e.target.value,
                              },
                            }))
                          }
                          className="w-40 px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-[11px]"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Verified Controls List */}
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 space-y-2">
          <div className="font-bold text-slate-900 dark:text-white">
            کنترل‌های تأییدشده توسط موتور حسابرسی مستقل ({toPersianDigits(independentAudit.verifiedItems.length)} مورد)
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {independentAudit.verifiedItems.map((v) => (
              <div
                key={v.controlId}
                className="flex items-start gap-2 p-2.5 rounded-lg bg-emerald-50/60 dark:bg-emerald-950/20 border border-emerald-200/70 dark:border-emerald-900/40"
              >
                <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                <div>
                  <div className="font-semibold text-slate-900 dark:text-white">{v.title}</div>
                  <div className="text-[11px] text-slate-600 dark:text-slate-300">{v.details}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (activeTab === 'lineage') {
    return (
      <div className="space-y-4 text-xs">
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
              <GitBranch className="w-4 h-4 text-teal-700 dark:text-teal-400" />
              <span>زنجیره ردیابی کامل (از گزارش مالی تا سند، فاکتور، چک و سابقه ممیزی)</span>
            </h2>
            <p className="text-[11px] text-slate-500 mt-0.5">
              هر سرفصل معین را انتخاب کنید تا ریشه تمام ارقام آن در اسناد قطعی، فاکتورها و چک‌ها ردیابی شود.
            </p>
          </div>
          <select
            value={selectedLineageAccount}
            onChange={(e) => setSelectedLineageAccount(e.target.value)}
            className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 font-medium"
          >
            {postableAccounts.map((a) => (
              <option key={a.id} value={a.code}>
                {a.code} — {a.title}
              </option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
            <div className="text-slate-500">جمع گردش بدهکار</div>
            <div className="text-base font-bold font-code mt-1">
              {formatMoney(lineageChain.totalDebitIrr, unit)}
            </div>
          </div>
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
            <div className="text-slate-500">جمع گردش بستانکار</div>
            <div className="text-base font-bold font-code mt-1">
              {formatMoney(lineageChain.totalCreditIrr, unit)}
            </div>
          </div>
          <div className="bg-white dark:bg-slate-900 border border-teal-200 dark:border-teal-900 rounded-xl p-4">
            <div className="text-slate-500">مانده خالص حساب {lineageChain.accountCode}</div>
            <div className="text-base font-bold font-code text-teal-700 dark:text-teal-400 mt-1">
              {formatMoney(Math.abs(lineageChain.netBalanceIrr), unit)}{' '}
              <span className="text-[11px]">
                ({lineageChain.netBalanceIrr >= 0 ? 'بدهکار' : 'بستانکار'})
              </span>
            </div>
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-right border-collapse text-[11px]">
              <thead>
                <tr className="bg-slate-50 dark:bg-slate-950 border-b border-slate-200 dark:border-slate-800 text-slate-500">
                  <th className="py-2.5 px-3">سند و تاریخ</th>
                  <th className="py-2.5 px-3">شرح و تفصیلی</th>
                  <th className="py-2.5 px-3 text-left">بدهکار</th>
                  <th className="py-2.5 px-3 text-left">بستانکار</th>
                  <th className="py-2.5 px-3">عملیات تجاری منشأ (فاکتور / چک)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {lineageChain.entries.map((e, i) => (
                  <tr key={`${e.voucherId}_${i}`}>
                    <td className="py-2.5 px-3 font-code whitespace-nowrap">
                      <div className="font-bold text-slate-900 dark:text-white">
                        سند #{toPersianDigits(e.voucherNumber)}
                      </div>
                      <div className="text-slate-500">{toPersianDigits(e.date)}</div>
                    </td>
                    <td className="py-2.5 px-3">
                      <div className="text-slate-800 dark:text-slate-200">{e.description}</div>
                      {e.partyName && (
                        <div className="text-[10.5px] text-teal-700 dark:text-teal-400">
                          طرف‌حساب: {e.partyName}
                        </div>
                      )}
                    </td>
                    <td className="py-2.5 px-3 text-left font-code tabular-nums">
                      {e.debitIrr > 0 ? formatMoney(e.debitIrr, unit, false) : '—'}
                    </td>
                    <td className="py-2.5 px-3 text-left font-code tabular-nums">
                      {e.creditIrr > 0 ? formatMoney(e.creditIrr, unit, false) : '—'}
                    </td>
                    <td className="py-2.5 px-3">
                      {e.linkedInvoice ? (
                        <div className="text-emerald-700 dark:text-emerald-400 font-medium">
                          فاکتور {e.linkedInvoice.invoiceNumber} ({e.linkedInvoice.invoiceType}) ·{' '}
                          {formatMoney(e.linkedInvoice.grandTotalIrr, unit)}
                        </div>
                      ) : (
                        <span className="text-slate-400">سند مستقیم حسابداری</span>
                      )}
                      {e.linkedCheques.length > 0 && (
                        <div className="text-amber-700 dark:text-amber-400 font-code">
                          چک صیادی: {e.linkedCheques.map((c) => c.sayadiId).join('، ')}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  }

  if (activeTab === 'sandbox') {
    return (
      <div className="space-y-4 text-xs">
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-3">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <FlaskConical className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                <span>محیط آزمایشی مستقل حسابداری (Isolated Sandbox)</span>
              </h2>
              <p className="text-[11px] text-slate-500 mt-1">
                تمام اسناد و فاکتورهای آزمایشی در یک کپی کاملاً مجزا در حافظه اجرا می‌شوند و <strong>هیچ اثری بر دیتابیس واقعی یا ابر</strong> نمی‌گذارند.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={handleInitSandbox}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 font-semibold hover:bg-slate-50 dark:hover:bg-slate-800"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>بازسازی کپی ایزوله</span>
              </button>
              <button
                type="button"
                onClick={handleRunSandboxSaleTest}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white font-semibold"
              >
                <Play className="w-3.5 h-3.5" />
                <span>اجرای تست فاکتور فروش + کسر انبار + کنترل ترازنامه</span>
              </button>
            </div>
          </div>

          {sandboxMessage && (
            <div className="p-3 rounded-lg bg-indigo-50/70 dark:bg-indigo-950/30 border border-indigo-200 dark:border-indigo-900/50 text-indigo-900 dark:text-indigo-200">
              {sandboxMessage}
            </div>
          )}

          {sandboxDiffBundle && (
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3 pt-2">
              <div className="p-3.5 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                <div className="text-slate-500">تغییر جمع دارایی ترازنامه</div>
                <div className="text-base font-bold font-code mt-1">
                  {formatMoney(sandboxDiffBundle.diff.deltaAssetsIrr, unit)}
                </div>
                <div className="text-[10.5px] text-emerald-700 dark:text-emerald-400 mt-0.5">
                  ترازنامه Sandbox: {sandboxDiffBundle.diff.sandboxBalanceSheetBalanced ? 'کاملاً متوازن' : 'نامتوازن'}
                </div>
              </div>
              <div className="p-3.5 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                <div className="text-slate-500">تغییر سود خالص</div>
                <div className="text-base font-bold font-code text-teal-700 dark:text-teal-400 mt-1">
                  {formatMoney(sandboxDiffBundle.diff.deltaNetProfitIrr, unit)}
                </div>
              </div>
              <div className="p-3.5 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                <div className="text-slate-500">تغییر ارزش موجودی انبار</div>
                <div className="text-base font-bold font-code text-amber-700 dark:text-amber-400 mt-1">
                  {formatMoney(sandboxDiffBundle.diff.deltaInventoryValueIrr, unit)}
                </div>
              </div>
              <div className="p-3.5 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                <div className="text-slate-500">امتیاز حسابرسی Sandbox</div>
                <div className="text-base font-bold font-code text-emerald-700 dark:text-emerald-400 mt-1">
                  {toPersianDigits(sandboxDiffBundle.diff.sandboxAuditScore)} / ۱۰۰
                </div>
                <div className="text-[10.5px] text-slate-500 mt-0.5">داده واقعی: ۱۰۰٪ دست‌نخورده</div>
              </div>
            </div>
          )}

          {sandbox && (
            <div className="pt-2">
              <div className="font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                گزارش عملیات انجام‌شده در Sandbox:
              </div>
              <ul className="space-y-1 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg p-3 font-code text-[11px]">
                {sandbox.operationsLog.map((line, i) => (
                  <li key={i}>• {line}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (activeTab === 'closing_wizard') {
    return (
      <div className="space-y-4 text-xs">
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <Lock className="w-4 h-4 text-teal-700 dark:text-teal-400" />
                <span>ویزارد جامع بستن و بازگشایی رسمی دوره مالی ({toPersianDigits(closingChecklist.fiscalYear)})</span>
              </h2>
              <p className="text-[11px] text-slate-500 mt-0.5">
                بررسی ۱۱ کنترل پیش‌نیاز پیش از بستن حساب‌های موقت و قفل‌گذاری دوره مالی
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={!closingChecklist.canCloseNow}
                onClick={() => void runYearEndClosing({ createNextYearOpening: true })}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-teal-700 hover:bg-teal-800 disabled:opacity-40 text-white font-semibold"
              >
                <Lock className="w-3.5 h-3.5" />
                <span>بستن سال {toPersianDigits(closingChecklist.fiscalYear)} + صدور سند افتتاحیه سال بعد</span>
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
            {closingChecklist.checks.map((c) => (
              <div
                key={c.id}
                className={`p-3 rounded-lg border flex items-start gap-2.5 ${
                  c.status === 'pass'
                    ? 'border-emerald-200 dark:border-emerald-900/50 bg-emerald-50/40 dark:bg-emerald-950/20'
                    : c.status === 'fail'
                      ? 'border-rose-300 dark:border-rose-900 bg-rose-50/60 dark:bg-rose-950/30'
                      : 'border-amber-200 dark:border-amber-900/50 bg-amber-50/50 dark:bg-amber-950/20'
                }`}
              >
                {c.status === 'pass' ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                ) : c.status === 'fail' ? (
                  <XCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                ) : (
                  <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                )}
                <div>
                  <div className="font-bold text-slate-900 dark:text-white">{c.title}</div>
                  <div className="text-[11px] text-slate-600 dark:text-slate-300 mt-0.5">{c.summary}</div>
                </div>
              </div>
            ))}
          </div>

          {/* Audited Period Reopening Section */}
          <div className="pt-4 border-t border-slate-200 dark:border-slate-800 space-y-3">
            <h3 className="text-xs font-bold text-slate-900 dark:text-white flex items-center gap-2">
              <Unlock className="w-4 h-4 text-amber-600" />
              <span>فرآیند رسمی بازگشایی دوره مالی بسته (با مجوز مدیر مالی و ثبت در Audit Trail)</span>
            </h3>
            {(!profile.closedFiscalYears || profile.closedFiscalYears.length === 0) ? (
              <div className="text-[11px] text-slate-500">
                در حال حاضر هیچ سال مالی بسته‌شده‌ای وجود ندارد.
              </div>
            ) : (
              <div className="flex flex-col sm:flex-row gap-2">
                <select
                  value={reopenTargetYear}
                  onChange={(e) => setReopenTargetYear(e.target.value)}
                  className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
                >
                  {profile.closedFiscalYears.map((y) => (
                    <option key={y} value={y}>
                      سال مالی بسته {toPersianDigits(y)}
                    </option>
                  ))}
                </select>
                <input
                  value={reopenReason}
                  onChange={(e) => setReopenReason(e.target.value)}
                  placeholder="علت مستند بازگشایی دوره (الزامی — حداقل ۸ کاراکتر)..."
                  className="flex-1 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
                <button
                  type="button"
                  onClick={async () => {
                    const ok = await reopenFiscalYear(reopenTargetYear, reopenReason);
                    if (ok) setReopenReason('');
                  }}
                  className="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-700 text-white font-semibold whitespace-nowrap"
                >
                  ثبت بازگشایی رسمی
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (activeTab === 'migration') {
    return (
      <div className="space-y-4 text-xs">
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <Database className="w-4 h-4 text-teal-700 dark:text-teal-400" />
                <span>ابزار مهاجرت امن و مقاوم در برابر تکرار از هلو ۲.۰.۳</span>
              </h2>
              <p className="text-[11px] text-slate-500 mt-0.5">
                داده‌های مبدأ هرگز دستکاری نمی‌شوند؛ پیش از انتقال واقعی، اجرای آزمایشی (Dry-Run) و پشتیبان‌گیری خودکار انجام می‌گیرد.
              </p>
            </div>
            <label className="cursor-pointer inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 font-semibold">
              <FileUp className="w-3.5 h-3.5" />
              <span>بارگذاری JSON هلو ۲.۰.۳</span>
              <input
                type="file"
                accept=".json"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  const reader = new FileReader();
                  reader.onload = () => setMigrationJson(String(reader.result || ''));
                  reader.readAsText(f);
                }}
              />
            </label>
          </div>

          <textarea
            rows={7}
            dir="ltr"
            value={migrationJson}
            onChange={(e) => setMigrationJson(e.target.value)}
            className="w-full p-3 font-code text-[11px] rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-left"
          />

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={handleRunMigrationDryRun}
              className="px-4 py-2 rounded-lg border border-teal-600 text-teal-700 dark:text-teal-300 font-semibold hover:bg-teal-50 dark:hover:bg-teal-950/40"
            >
              ۱. اجرای آزمایشی و کنترل تطبیق (Dry-Run)
            </button>
            <button
              type="button"
              disabled={!migrationPreview || !migrationPreview.canCommit}
              onClick={() => void handleCommitMigration()}
              className="px-4 py-2 rounded-lg bg-teal-700 hover:bg-teal-800 disabled:opacity-40 text-white font-semibold"
            >
              ۲. انتقال واقعی با پشتیبان خودکار پیش‌ازانتقال
            </button>
          </div>

          {migrationParseErr && (
            <div className="p-3 rounded-lg bg-rose-50 dark:bg-rose-950/30 border border-rose-200 text-rose-700 dark:text-rose-300">
              {migrationParseErr}
            </div>
          )}

          {migrationPreview && (
            <div className="space-y-3 pt-2">
              <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 grid grid-cols-2 md:grid-cols-4 gap-3">
                <div>
                  <div className="text-slate-500">ساختار شناسایی‌شده</div>
                  <div className="font-semibold mt-0.5">{migrationPreview.detectedSchema}</div>
                </div>
                <div>
                  <div className="text-slate-500">توازن بدهکار و بستانکار</div>
                  <div className="font-bold mt-0.5 text-emerald-700 dark:text-emerald-400">
                    {migrationPreview.verification.debitCreditBalanced ? '۱۰۰٪ تراز' : 'نامتوازن'}
                  </div>
                </div>
                <div>
                  <div className="text-slate-500">تطبیق موجودی و ارزش انبار</div>
                  <div className="font-bold mt-0.5 text-emerald-700 dark:text-emerald-400">
                    {migrationPreview.verification.inventoryMatches
                      ? `${formatNumber(migrationPreview.verification.migratedInventoryQty)} واحد · تراز`
                      : 'مغایرت انبار'}
                  </div>
                </div>
                <div>
                  <div className="text-slate-500">رکوردهای جدید / ردشده (تکراری)</div>
                  <div className="font-code mt-0.5">
                    +{toPersianDigits(migrationPreview.verification.mappedCounts.vouchers)} سند ·{' '}
                    {toPersianDigits(migrationPreview.verification.skippedDuplicates.vouchers)} تکراری
                  </div>
                </div>
              </div>

              {migrationPreview.errors.length > 0 && (
                <div className="p-3 rounded-lg bg-rose-50 dark:bg-rose-950/30 border border-rose-200 space-y-1 text-rose-700 dark:text-rose-300">
                  {migrationPreview.errors.map((err, i) => (
                    <div key={i}>• [{err.entity}] {err.message}</div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (activeTab === 'documents') {
    return (
      <div className="space-y-4 text-xs">
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4">
          <div>
            <h2 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
              <Paperclip className="w-4 h-4 text-teal-700 dark:text-teal-400" />
              <span>بایگانی آفلاین اسناد و مدارک مثبته (با مهر SHA-256 و کنترل دسترسی)</span>
            </h2>
            <p className="text-[11px] text-slate-500 mt-0.5">
              پیوست تصویر و PDF به فاکتورها، اسناد حسابداری، چک‌ها و قراردادها با ذخیره محلی در IndexedDB و بررسی صحت فایل هنگام بازیابی.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <select
              value={docEntityType}
              onChange={(e) => setDocEntityType(e.target.value as AttachmentEntityType)}
              className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
            >
              <option value="voucher">سند حسابداری</option>
              <option value="invoice">فاکتور خرید/فروش</option>
              <option value="cheque">چک صیادی</option>
              <option value="contract">قرارداد</option>
              <option value="operation">عملیات مالی</option>
            </select>
            <input
              value={docEntityId}
              onChange={(e) => setDocEntityId(e.target.value)}
              placeholder="شناسه سند / شماره فاکتور / چک..."
              className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 font-code"
            />
            <select
              value={docSensitivity}
              onChange={(e) => setDocSensitivity(e.target.value as DocumentSensitivity)}
              className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
            >
              <option value="standard">سطح دسترسی: عادی</option>
              <option value="confidential">سطح دسترسی: محرمانه (حسابداری و خزانه)</option>
              <option value="restricted">سطح دسترسی: محدود (مدیر مالی و حسابرس)</option>
            </select>
            <label className="cursor-pointer inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-teal-700 hover:bg-teal-800 text-white font-semibold">
              <Upload className="w-3.5 h-3.5" />
              <span>پیوست فایل (PDF / تصویر)</span>
              <input
                type="file"
                accept="application/pdf,image/jpeg,image/png,image/webp"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void handleFileAttach(file);
                }}
              />
            </label>
          </div>

          {docVerifyMsg && (
            <div className="p-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 text-emerald-800 dark:text-emerald-300 font-code">
              {docVerifyMsg}
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-right border-collapse text-[11px]">
              <thead>
                <tr className="bg-slate-50 dark:bg-slate-950 border-b border-slate-200 dark:border-slate-800 text-slate-500">
                  <th className="py-2 px-3">نام فایل</th>
                  <th className="py-2 px-3">مرتبط با</th>
                  <th className="py-2 px-3">محرمانگی</th>
                  <th className="py-2 px-3">اثرانگشت SHA-256</th>
                  <th className="py-2 px-3 text-left">عملیات</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {attachments.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-6 text-center text-slate-400">
                      هنوز مدرکی در بایگانی آفلاین پیوست نشده است.
                    </td>
                  </tr>
                ) : (
                  attachments.map((att) => (
                    <tr key={att.id}>
                      <td className="py-2 px-3 font-medium text-slate-900 dark:text-white">
                        {att.fileName}
                      </td>
                      <td className="py-2 px-3 font-code">{att.entityLabel}</td>
                      <td className="py-2 px-3">{att.sensitivity}</td>
                      <td className="py-2 px-3 font-code text-slate-500">
                        {att.sha256.slice(0, 16)}…
                      </td>
                      <td className="py-2 px-3 text-left space-x-2 space-x-reverse">
                        <button
                          type="button"
                          onClick={() => void handleVerifyAndOpenDoc(att.id)}
                          className="text-teal-700 dark:text-teal-400 font-semibold hover:underline"
                        >
                          تأیید صحت
                        </button>
                        <button
                          type="button"
                          onClick={async () => {
                            await deleteDocumentAttachment(att.id, activeOperator.role);
                            await refreshAttachments();
                          }}
                          className="text-rose-600 hover:underline"
                        >
                          حذف
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  }

  // Forecast Tab (Strictly Isolated from Ledger)
  return (
    <div className="space-y-4 text-xs">
      <div className="bg-amber-50/70 dark:bg-amber-950/30 border border-amber-300 dark:border-amber-800 rounded-xl p-4 flex items-start gap-2.5">
        <ShieldAlert className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
        <div>
          <div className="font-bold text-amber-900 dark:text-amber-200">
            ماژول پیش‌بینی مالی (کاملاً جدا از دفاتر قطعی حسابداری)
          </div>
          <p className="text-[11px] text-amber-800 dark:text-amber-300 mt-0.5">
            {forecast.disclaimer}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {forecast.horizons.map((h) => (
          <div
            key={h.horizonDays}
            className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 space-y-2"
          >
            <div className="flex items-center justify-between">
              <span className="font-bold text-slate-900 dark:text-white flex items-center gap-1.5">
                <TrendingUp className="w-4 h-4 text-teal-700 dark:text-teal-400" />
                {h.label}
              </span>
              {h.liquidityWarning && (
                <span className="text-[10px] font-bold text-rose-600">هشدار نقدینگی</span>
              )}
            </div>
            <div className="space-y-1 text-[11px]">
              <div className="flex justify-between">
                <span className="text-slate-500">فروش تخمینی:</span>
                <span className="font-code font-semibold">{formatMoney(h.projectedSalesIrr, unit)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">وصول چک‌های دریافتنی:</span>
                <span className="font-code text-emerald-700 dark:text-emerald-400">
                  {formatMoney(h.scheduledChequeInflowIrr, unit)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">پرداخت چک‌های صادره:</span>
                <span className="font-code text-rose-700 dark:text-rose-400">
                  {formatMoney(h.scheduledChequeOutflowIrr, unit)}
                </span>
              </div>
              <div className="flex justify-between pt-1.5 border-t border-slate-100 dark:border-slate-800">
                <span className="font-semibold">مانده نقدینگی پیش‌بینی‌شده:</span>
                <span className="font-code font-bold text-teal-700 dark:text-teal-400">
                  {formatMoney(h.projectedEndingCashIrr, unit)}
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="font-bold text-slate-900 dark:text-white">دریافت انتقال‌های بین‌انبارِ در راه</div>
          <label className="flex items-center gap-2 text-[11px] text-slate-500">
            تاریخ دریافت
            <input
              type="date"
              value={transferReceivedDate}
              onChange={(event) => setTransferReceivedDate(event.target.value)}
              className="px-2 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
            />
          </label>
        </div>
        {trackedTransfers.filter((transfer) => transfer.status === 'in_transit').length === 0 ? (
          <div className="text-center text-slate-400 py-4">انتقالِ در راهی برای دریافت وجود ندارد.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-right text-[11px] border-collapse">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500">
                  <th className="py-2 px-2">شماره انتقال</th>
                  <th className="py-2 px-2">کالا</th>
                  <th className="py-2 px-2">مبدأ ← مقصد</th>
                  <th className="py-2 px-2 text-left">مقدار</th>
                  <th className="py-2 px-2 text-left">ارزش ریالی</th>
                  <th className="py-2 px-2">عملیات</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {trackedTransfers.filter((transfer) => transfer.status === 'in_transit').map((transfer) => (
                  <tr key={transfer.id}>
                    <td className="py-2 px-2 font-code">{transfer.transferNumber}</td>
                    <td className="py-2 px-2">{transfer.productName}</td>
                    <td className="py-2 px-2">{transfer.fromWarehouse} ← {transfer.toWarehouse}</td>
                    <td className="py-2 px-2 text-left font-code">{formatNumber(transfer.qty)}</td>
                    <td className="py-2 px-2 text-left font-code">{formatMoney(transfer.transferredCostIrr, unit)}</td>
                    <td className="py-2 px-2 text-center">
                      <button
                        type="button"
                        disabled={receivingTransferId !== null || !transferReceivedDate}
                        onClick={() => void handleReceiveWarehouseTransfer(transfer)}
                        className="px-3 py-1.5 rounded-lg bg-teal-700 hover:bg-teal-800 disabled:opacity-40 text-white font-semibold whitespace-nowrap"
                      >
                        {receivingTransferId === transfer.id ? 'در حال ثبت…' : 'ثبت دریافت'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-[10px] text-slate-500">
          دریافت فقط محل لایه‌های بهای تمام‌شدهٔ همان انتقال را تغییر می‌دهد؛ مقدار کل موجودی، ارزش موجودی و سود و زیان ثابت می‌مانند.
        </p>
      </div>

      {/* Inventory Stagnant & Multi-Warehouse Summary */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 space-y-2">
          <div className="font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <FileCheck2 className="w-4 h-4 text-teal-700 dark:text-teal-400" />
            <span>وضعیت چندانباره (فیزیکی / رزروشده / قابل فروش / در راه)</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-right text-[11px] border-collapse">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500">
                  <th className="py-2 px-2">انبار</th>
                  <th className="py-2 px-2 text-left">فیزیکی</th>
                  <th className="py-2 px-2 text-left">رزرو</th>
                  <th className="py-2 px-2 text-left">قابل فروش</th>
                  <th className="py-2 px-2 text-left">در راه</th>
                  <th className="py-2 px-2 text-left">ارزش ریالی</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {multiWarehouse.warehouseSummaries.map((w) => (
                  <tr key={w.warehouse}>
                    <td className="py-2 px-2 font-medium">{w.warehouse}</td>
                    <td className="py-2 px-2 text-left font-code">{formatNumber(w.totalPhysicalQty)}</td>
                    <td className="py-2 px-2 text-left font-code text-amber-600">{formatNumber(w.totalReservedQty)}</td>
                    <td className="py-2 px-2 text-left font-code text-emerald-700 dark:text-emerald-400">{formatNumber(w.totalAvailableQty)}</td>
                    <td className="py-2 px-2 text-left font-code text-sky-600">{formatNumber(w.totalInTransitQty)}</td>
                    <td className="py-2 px-2 text-left font-code">{formatMoney(w.totalValuationIrr, unit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 space-y-2">
          <div className="font-bold text-slate-900 dark:text-white">
            کالاهای کم‌موجودی ({toPersianDigits(forecast.lowStockProducts.length)}) و راکد ({toPersianDigits(forecast.stagnantProducts.length)})
          </div>
          <div className="space-y-1.5 max-h-56 overflow-y-auto">
            {forecast.lowStockProducts.slice(0, 6).map((item) => (
              <div
                key={item.productId}
                className="flex items-center justify-between p-2 rounded-lg bg-rose-50/50 dark:bg-rose-950/20 border border-rose-200/60 dark:border-rose-900/40 text-[11px]"
              >
                <div>
                  <div className="font-semibold text-slate-900 dark:text-white">{item.productName}</div>
                  <div className="text-slate-500 font-code">
                    موجودی: {formatNumber(item.currentStock)} · نقطه سفارش: {formatNumber(item.reorderPoint)}
                  </div>
                </div>
                <div className="text-left font-code">
                  <div className="font-bold text-rose-700 dark:text-rose-400">
                    سفارش پیشنهادی: {formatNumber(item.recommendedOrderQty)}
                  </div>
                  <div className="text-slate-500">{formatMoney(item.estimatedOrderCostIrr, unit)}</div>
                </div>
              </div>
            ))}
            {forecast.stagnantProducts.slice(0, 4).map((item) => (
              <div
                key={`stag_${item.productId}`}
                className="flex items-center justify-between p-2 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-[11px]"
              >
                <span className="font-medium">{item.productName}</span>
                <span className="text-amber-700 dark:text-amber-400 font-semibold">
                  کالای راکد (موجودی: {formatNumber(item.currentStock)})
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
