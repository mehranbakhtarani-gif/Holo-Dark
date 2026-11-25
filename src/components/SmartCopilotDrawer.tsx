import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowUpLeft,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Cpu,
  Loader2,
  RefreshCw,
  Send,
  Sparkles,
  TrendingUp,
  X,
} from 'lucide-react';
import { useAccounting } from '../context/AccountingContext';
import { ActiveModule } from '../types/accounting';
import { formatCompactMoney, toPersianDigits } from '../lib/format';
import {
  buildCopilotFinancialSnapshot,
  computeCashFlowLiquidityRadar,
  SmartCopilotSuggestedAction,
} from '../lib/smartIntelligence';
import {
  localCopilotRespond,
  LocalSlmOptimizationResult,
  runAutonomousAiOptimization,
} from '../lib/localSmallLlm';

interface CopilotMessage {
  id: string;
  role: 'user' | 'model';
  text: string;
  suggestedActions?: SmartCopilotSuggestedAction[];
  isError?: boolean;
}

const STARTER_PROMPTS = [
  'گزارش حسابرسی هوشمند دفاتر، تراز کل و معین و تطبیق انبار با ۱۰۵۰۱',
  'وضعیت چرخه عمر اسناد (پیش‌فاکتورها، حواله‌ها، واردات و کارمزدی)',
  'پیشنهادهای بهینه‌سازی فرآیند مالی و رفع مغایرت‌ها چیست؟',
  'تحلیل وضعیت نقدینگی ۳۰ روز آینده و ریسک چک‌ها',
  'کدام کالاها در خطر اتمام موجودی هستند و چقدر سفارش دهم؟',
  'بدهی مالیات ارزش افزوده این دوره چقدر است و چه کارهایی برای سامانه مودیان انجام دهم؟',
];

export const SmartCopilotDrawer: React.FC<{
  open: boolean;
  onClose: () => void;
  onNavigate: (mod: ActiveModule, intent?: string, subKey?: string) => void;
}> = ({ open, onClose, onNavigate }) => {
  const {
    profile,
    accounts,
    trialBalance,
    incomeStatement,
    balanceSheet,
    products,
    parties,
    partyBalances,
    cheques,
    vouchers,
    invoices,
    salesOrders,
    importDossiers,
    subcontractJobs,
    auditReport,
  } = useAccounting();

  const unit = profile.currencyUnit;
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [messages, setMessages] = useState<CopilotMessage[]>([]);
  const [aiOptResult, setAiOptResult] = useState<LocalSlmOptimizationResult | null>(null);
  const [showAiOptPanel, setShowAiOptPanel] = useState(false);
  const [optimizingAi, setOptimizingAi] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const executeAutonomousEvaluation = () => {
    setOptimizingAi(true);
    try {
      const res = runAutonomousAiOptimization({
        workspaceAccountTitles: accounts.map((a) => a.title),
        workspacePartyNames: parties.map((p) => p.name),
        workspaceProductNames: products.map((p) => p.name),
        persist: true,
      });
      setAiOptResult(res);
    } finally {
      setOptimizingAi(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    executeAutonomousEvaluation();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, accounts.length, parties.length, products.length]);

  const liquidity = useMemo(
    () =>
      trialBalance
        .filter((r) => r.accountCode.startsWith('101') || r.accountCode.startsWith('102'))
        .reduce((s, r) => s + r.balanceDebit - r.balanceCredit, 0),
    [trialBalance]
  );

  const radar = useMemo(
    () => computeCashFlowLiquidityRadar({ currentLiquidity: liquidity, cheques }),
    [liquidity, cheques]
  );

  const draftVouchersCount = useMemo(
    () => vouchers.filter((v) => v.status === 'draft').length,
    [vouchers]
  );

  const lowStockCount = useMemo(
    () => products.filter((p) => p.stock <= p.reorderPoint).length,
    [products]
  );

  const snapshot = useMemo(
    () =>
      buildCopilotFinancialSnapshot({
        companyName: profile.companyName,
        fiscalYear: profile.fiscalYear,
        currencyUnit: profile.currencyUnit,
        liquidity,
        netSales: incomeStatement.netSales,
        grossProfit: incomeStatement.grossProfit,
        netProfit: incomeStatement.netProfit,
        grossMarginPct: incomeStatement.grossMarginPct,
        netMarginPct: incomeStatement.netMarginPct,
        totalAssets: balanceSheet.totalAssets,
        totalLiabilities: balanceSheet.totalLiabilities,
        totalEquity: balanceSheet.totalEquity,
        trialBalance,
        products,
        parties,
        partyBalances,
        cheques,
        vouchers,
        invoices,
        auditScore: auditReport.score,
        auditErrors: auditReport.errorCount,
        auditWarnings: auditReport.warningCount,
        auditFindings: auditReport.checks
          .filter((c) => c.status !== 'pass')
          .map((c) => ({
            id: c.id,
            title: c.title,
            severity: c.status === 'error' ? ('error' as const) : ('warning' as const),
            details: c.details.length > 0 ? c.details.join('؛ ') : c.summary,
          })),
        openSalesOrdersCount: salesOrders.filter(
          (o) => o.status !== 'invoiced' && o.status !== 'cancelled'
        ).length,
        dispatchedUninvoicedOrdersCount: salesOrders.filter((o) => o.status === 'dispatched').length,
        openImportDossiersCount: importDossiers.filter((d) => d.status !== 'cleared').length,
        activeSubcontractJobsCount: subcontractJobs.filter((j) => j.status === 'sent').length,
      }),
    [
      profile,
      liquidity,
      incomeStatement,
      balanceSheet,
      trialBalance,
      products,
      parties,
      partyBalances,
      cheques,
      vouchers,
      invoices,
      salesOrders,
      importDossiers,
      subcontractJobs,
      auditReport,
    ]
  );

  if (!open) return null;

  const sendQuestion = async (questionText: string) => {
    const trimmed = questionText.trim();
    if (!trimmed || loading) return;

    const userMsg: CopilotMessage = {
      id: `u-${Date.now()}`,
      role: 'user',
      text: trimmed,
    };
    const nextHistory = [...messages, userMsg];
    setMessages(nextHistory);
    setInput('');
    setLoading(true);

    setTimeout(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    }, 40);

    try {
      const data = localCopilotRespond({
        message: trimmed,
        snapshot,
      });
      setMessages((prev) => [
        ...prev,
        {
          id: `m-${Date.now()}`,
          role: 'model',
          text: data.reply || 'پاسخی تولید نشد.',
          suggestedActions: Array.isArray(data.suggestedActions)
            ? data.suggestedActions
            : undefined,
        },
      ]);
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          id: `e-${Date.now()}`,
          role: 'model',
          text: 'خطا در تحلیل محلی دفاتر مالی.',
          isError: true,
        },
      ]);
    } finally {
      setLoading(false);
      setTimeout(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
      }, 60);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end no-print">
      <div
        className="flex-1 bg-slate-950/40 backdrop-blur-[1px]"
        onClick={onClose}
        aria-hidden="true"
      />
      <aside className="w-full max-w-lg bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800 h-full flex flex-col shadow-2xl">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-9 h-9 rounded-lg bg-teal-700 text-white flex items-center justify-center shrink-0">
              <Sparkles className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-bold text-slate-900 dark:text-white truncate">
                دستیار بومی هوشمند مالی (Local-SLM)
              </h2>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                پردازش ۱۰۰٪ محلی و آفلاین روی دستگاه · بدون خروج داده به سرویس ابری
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
            aria-label="بستن دستیار هوشمند"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Live Deterministic Executive Radar Strip */}
        <div className="px-4 py-3 bg-slate-50 dark:bg-slate-950/70 border-b border-slate-200 dark:border-slate-800 space-y-2 text-xs">
          <div className="flex items-center justify-between text-[11px] font-semibold text-slate-600 dark:text-slate-400">
            <span>پایش هوشمند لحظه‌ای دفاتر (بدون نیاز به اینترنت)</span>
            <span className="font-code text-teal-700 dark:text-teal-400">
              امتیاز حسابرسی {toPersianDigits(auditReport.score)}٪
            </span>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <button
              type="button"
              onClick={() => {
                onClose();
                onNavigate('treasury', 'cheques', 'tr-cheques');
              }}
              className={`p-2 rounded-lg border text-right transition-colors ${
                radar.earliestDeficitDate
                  ? 'border-rose-300 dark:border-rose-800 bg-rose-50/70 dark:bg-rose-950/40'
                  : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900'
              }`}
            >
              <div className="text-[10.5px] text-slate-500">نقدینگی ۳۰ روزه</div>
              <div
                className={`font-code tabular-nums font-bold mt-0.5 ${
                  radar.earliestDeficitDate
                    ? 'text-rose-700 dark:text-rose-400'
                    : 'text-emerald-700 dark:text-emerald-400'
                }`}
              >
                {formatCompactMoney(radar.horizons[2].projectedBalance, unit)}
              </div>
            </button>
            <button
              type="button"
              onClick={() => {
                onClose();
                onNavigate('inventory', 'kardex', 'inv-kardex');
              }}
              className="p-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-right hover:border-teal-400 transition-colors"
            >
              <div className="text-[10.5px] text-slate-500">کالای زیر نقطه سفارش</div>
              <div className="font-code tabular-nums font-bold mt-0.5 text-amber-700 dark:text-amber-400">
                {toPersianDigits(lowStockCount)} قلم
              </div>
            </button>
            <button
              type="button"
              onClick={() => {
                onClose();
                onNavigate('vouchers', 'cartable', 'voucher-cartable');
              }}
              className="p-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-right hover:border-teal-400 transition-colors"
            >
              <div className="text-[10.5px] text-slate-500">اسناد موقت کارتابل</div>
              <div className="font-code tabular-nums font-bold mt-0.5 text-indigo-700 dark:text-indigo-400">
                {toPersianDigits(draftVouchersCount)} سند
              </div>
            </button>
          </div>
          {radar.earliestDeficitDate && (
            <div className="flex items-center gap-2 text-[11px] text-rose-700 dark:text-rose-400 font-medium pt-0.5">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              <span>
                هشدار شکاف نقدینگی در تاریخ {toPersianDigits(radar.earliestDeficitDate)} به مبلغ{' '}
                {formatCompactMoney(radar.earliestDeficitAmount, unit)}
              </span>
            </div>
          )}

          {/* Autonomous Offline AI Self-Evaluation & Weight Optimization Card */}
          {aiOptResult && (
            <div className="mt-1.5 rounded-lg border border-indigo-200/80 dark:border-indigo-900/70 bg-white dark:bg-slate-900 overflow-hidden">
              <button
                type="button"
                onClick={() => setShowAiOptPanel((p) => !p)}
                className="w-full px-3 py-2 flex items-center justify-between gap-2 text-[11px] hover:bg-indigo-50/50 dark:hover:bg-indigo-950/30 transition-colors"
              >
                <div className="flex items-center gap-1.5 min-w-0">
                  <Cpu className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400 shrink-0" />
                  <span className="font-bold text-slate-800 dark:text-slate-100 truncate">
                    خودارزیابی و بهینه‌سازی مدل آفلاین (نسل {toPersianDigits(aiOptResult.weights.generation)})
                  </span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="inline-flex items-center gap-1 font-code font-bold text-emerald-700 dark:text-emerald-400">
                    <CheckCircle2 className="w-3 h-3" />
                    دقت {toPersianDigits(aiOptResult.after.overallScorePct)}٪
                  </span>
                  {showAiOptPanel ? (
                    <ChevronUp className="w-3.5 h-3.5 text-slate-400" />
                  ) : (
                    <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
                  )}
                </div>
              </button>

              {showAiOptPanel && (
                <div className="px-3 pb-3 pt-1.5 border-t border-slate-100 dark:border-slate-800 space-y-2 text-[11px]">
                  <div className="grid grid-cols-3 gap-1.5 font-code">
                    <div className="p-1.5 rounded bg-slate-50 dark:bg-slate-950 border border-slate-100 dark:border-slate-800">
                      <div className="text-[10px] text-slate-500 font-sans">تراز دوبل اسناد</div>
                      <div className="font-bold text-emerald-700 dark:text-emerald-400">
                        {toPersianDigits(aiOptResult.after.doubleEntryBalanceRatePct)}٪
                      </div>
                    </div>
                    <div className="p-1.5 rounded bg-slate-50 dark:bg-slate-950 border border-slate-100 dark:border-slate-800">
                      <div className="text-[10px] text-slate-500 font-sans">امتیاز F1 تحلیل</div>
                      <div className="font-bold text-indigo-700 dark:text-indigo-400">
                        {toPersianDigits(aiOptResult.after.copilotIntentF1Pct)}٪
                      </div>
                    </div>
                    <div className="p-1.5 rounded bg-slate-50 dark:bg-slate-950 border border-slate-100 dark:border-slate-800">
                      <div className="text-[10px] text-slate-500 font-sans">واژگان بومی شرکت</div>
                      <div className="font-bold text-teal-700 dark:text-teal-400">
                        {toPersianDigits(aiOptResult.weights.workspaceLexiconTerms.length)} واژه
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-2 text-[10.5px] text-slate-500">
                    <span>
                      آزمون‌های موفق: {toPersianDigits(aiOptResult.after.passedCases)} از{' '}
                      {toPersianDigits(aiOptResult.after.totalCases)} · زمان میانگین:{' '}
                      {toPersianDigits(aiOptResult.after.avgLatencyMs)} ms
                    </span>
                    <button
                      type="button"
                      disabled={optimizingAi}
                      onClick={executeAutonomousEvaluation}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded border border-indigo-200 dark:border-indigo-800 bg-indigo-50/70 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300 font-semibold hover:bg-indigo-100 dark:hover:bg-indigo-900/50 disabled:opacity-50"
                    >
                      <RefreshCw className={`w-3 h-3 ${optimizingAi ? 'animate-spin' : ''}`} />
                      <span>بهینه‌سازی مجدد</span>
                    </button>
                  </div>
                  {aiOptResult.appliedChanges.length > 0 && (
                    <div className="text-[10.5px] text-emerald-700 dark:text-emerald-400 leading-5">
                      آخرین بهبود خودکار: {aiOptResult.appliedChanges.join(' · ')}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Conversation Area */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4">
          {messages.length === 0 ? (
            <div className="space-y-4">
              <div className="p-4 rounded-xl bg-teal-50/60 dark:bg-teal-950/30 border border-teal-200/80 dark:border-teal-900 text-xs leading-6 text-slate-700 dark:text-slate-300">
                <div className="font-bold text-teal-900 dark:text-teal-200 flex items-center gap-1.5 mb-1">
                  <Bot className="w-4 h-4" />
                  <span>مشاور مالی هوشمند متصل به دفاتر واقعی شرکت</span>
                </div>
                هر سؤالی درباره سود و زیان، وضعیت نقدینگی، چک‌های پیش‌رو، سفارش مجدد نخ، ارزش افزوده و سامانه مودیان بپرسید تا بر اساس اعداد زنده سیستم تحلیل شود.
              </div>
              <div className="space-y-2">
                <div className="text-[11px] font-semibold text-slate-500">
                  سؤالات پیشنهادی آماده (کلیک کنید):
                </div>
                {STARTER_PROMPTS.map((q) => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => void sendQuestion(q)}
                    className="w-full text-right p-2.5 rounded-lg border border-slate-200 dark:border-slate-800 hover:border-teal-400 dark:hover:border-teal-700 hover:bg-slate-50 dark:hover:bg-slate-800/60 text-xs text-slate-700 dark:text-slate-200 flex items-center justify-between gap-2 transition-colors"
                  >
                    <span>{q}</span>
                    <ArrowUpLeft className="w-3.5 h-3.5 text-teal-600 shrink-0" />
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex flex-col ${msg.role === 'user' ? 'items-start' : 'items-end'}`}
              >
                <div
                  className={`max-w-[92%] rounded-xl px-3.5 py-2.5 text-xs leading-6 whitespace-pre-wrap ${
                    msg.role === 'user'
                      ? 'bg-teal-700 text-white'
                      : msg.isError
                        ? 'bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800 text-rose-800 dark:text-rose-200'
                        : 'bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-100 border border-slate-200/80 dark:border-slate-700'
                  }`}
                >
                  {msg.text}
                </div>
                {msg.suggestedActions && msg.suggestedActions.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {msg.suggestedActions.map((act, idx) => (
                      <button
                        key={idx}
                        type="button"
                        onClick={() => {
                          onClose();
                          onNavigate(act.module, act.intent);
                        }}
                        className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold rounded-md border border-teal-300 dark:border-teal-800 bg-teal-50 dark:bg-teal-950/40 text-teal-800 dark:text-teal-300 hover:bg-teal-100 dark:hover:bg-teal-950/70 transition-colors"
                      >
                        <TrendingUp className="w-3 h-3" />
                        <span>{act.label}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))
          )}
          {loading && (
            <div className="flex items-center gap-2 text-xs text-teal-700 dark:text-teal-400 py-2">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>در حال تحلیل دفاتر مالی و تدوین پاسخ دقیق...</span>
            </div>
          )}
        </div>

        {/* Prompt Input Footer */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void sendQuestion(input);
          }}
          className="p-3.5 border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex items-center gap-2"
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="سؤال مالی، مالیاتی یا تحلیلی خود را بنویسید..."
            className="flex-1 px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 focus:outline-none focus:border-teal-600"
          />
          <button
            type="submit"
            disabled={!input.trim() || loading}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 disabled:opacity-50 rounded-lg whitespace-nowrap shrink-0"
          >
            <Send className="w-3.5 h-3.5" />
            <span>ارسال</span>
          </button>
        </form>
      </aside>
    </div>
  );
};
