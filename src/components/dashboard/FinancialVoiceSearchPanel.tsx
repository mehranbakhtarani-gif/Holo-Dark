import React, { useEffect, useMemo, useRef } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ArrowLeft,
  BarChart3,
  BookOpen,
  FileText,
  Landmark,
  Mic,
  Package,
  Search,
  Square,
  Users,
  Wallet,
  X,
} from 'lucide-react';
import type { ActiveModule } from '../../types/accounting';
import {
  executeFinancialVoiceSearch,
  type FinancialVoiceSearchDataset,
  type FinancialVoiceSearchResultItem,
  VOICE_SEARCH_EXAMPLES,
} from '../../lib/financialVoiceSearch';
import { usePersianSpeechRecognition } from '../../hooks/usePersianSpeechRecognition';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { HighlightedText } from '../FuzzyTableSearch';
import { toPersianDigits } from '../../lib/format';

interface FinancialVoiceSearchPanelProps {
  open: boolean;
  onClose: () => void;
  query: string;
  onQueryChange: (next: string) => void;
  dataset: FinancialVoiceSearchDataset;
  onNavigate: (mod: ActiveModule, intent?: string, subKey?: string) => void;
  onApplyDashboardFilter?: (filterText: string) => void;
  autoStartListening?: boolean;
}

const panelSpring = {
  type: 'spring' as const,
  stiffness: 420,
  damping: 34,
  mass: 0.8,
};

function getDomainIcon(domain: FinancialVoiceSearchResultItem['domain']) {
  switch (domain) {
    case 'invoices':
    case 'proforma':
      return FileText;
    case 'cheques':
      return Landmark;
    case 'parties':
      return Users;
    case 'inventory':
      return Package;
    case 'accounts':
      return Wallet;
    case 'vouchers':
      return BookOpen;
    case 'reports':
      return BarChart3;
  }
}

export const FinancialVoiceSearchPanel: React.FC<FinancialVoiceSearchPanelProps> = ({
  open,
  onClose,
  query,
  onQueryChange,
  dataset,
  onNavigate,
  onApplyDashboardFilter,
  autoStartListening = false,
}) => {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const autoStartedRef = useRef(false);

  const speech = usePersianSpeechRecognition({
    onInterim: (liveText) => {
      onQueryChange(liveText);
    },
    onFinal: (finalText) => {
      onQueryChange(finalText);
    },
  });

  useEffect(() => {
    if (!open) {
      autoStartedRef.current = false;
      speech.stopListening();
      return;
    }

    const focusTimer = window.setTimeout(() => {
      inputRef.current?.focus();
    }, 60);

    if (autoStartListening && !autoStartedRef.current && speech.isSupported) {
      autoStartedRef.current = true;
      speech.startListening();
    }

    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        speech.stopListening();
        onClose();
      }
    };
    window.addEventListener('keydown', handleEsc);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener('keydown', handleEsc);
    };
  }, [open, autoStartListening, speech.isSupported, speech.startListening, speech.stopListening, onClose]);

  const debouncedQuery = useDebouncedValue(query, 80);

  const { parsed, results } = useMemo(
    () => executeFinancialVoiceSearch(debouncedQuery, dataset, 14),
    [debouncedQuery, dataset]
  );

  const handleSelectResult = (item: FinancialVoiceSearchResultItem) => {
    speech.stopListening();
    if (item.filterText && onApplyDashboardFilter) {
      onApplyDashboardFilter(item.filterText);
    }
    onNavigate(item.module, item.intent, item.subKey);
    onClose();
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          dir="rtl"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
          onClick={onClose}
          className="fixed inset-0 z-50 bg-slate-950/55 backdrop-blur-sm flex items-start justify-center p-3 sm:p-6 pt-12 sm:pt-20 no-print"
          role="dialog"
          aria-modal="true"
          aria-label="جستجوی صوتی مالی هوشمند"
        >
          <motion.div
            initial={{ opacity: 0, y: -14, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.98 }}
            transition={panelSpring}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-2xl rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-2xl overflow-hidden flex flex-col max-h-[82vh]"
          >
            {/* Header */}
            <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between gap-3 bg-slate-50/70 dark:bg-slate-950/60">
              <div className="flex items-center gap-3 min-w-0">
                <button
                  type="button"
                  onClick={speech.toggleListening}
                  aria-pressed={speech.isListening}
                  aria-label={speech.isListening ? 'توقف شنیدن صدا' : 'شروع جستجوی صوتی فارسی'}
                  className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0 transition-colors cursor-pointer ${
                    speech.isListening
                      ? 'bg-rose-600 text-white hover:bg-rose-700 shadow-md shadow-rose-500/25'
                      : 'bg-indigo-600 text-white hover:bg-indigo-700 shadow-sm'
                  }`}
                >
                  {speech.isListening ? (
                    <Square className="w-4 h-4 fill-current" />
                  ) : (
                    <Mic className="w-5 h-5" />
                  )}
                </button>
                <div className="min-w-0">
                  <h2 className="text-sm sm:text-base font-bold text-slate-900 dark:text-white truncate">
                    جستجوی صوتی مالی هوشمند
                  </h2>
                  <p className="text-xs text-slate-500 dark:text-slate-400 truncate mt-0.5">
                    {speech.isListening
                      ? 'در حال شنیدن صدای شما به فارسی... عبارت مالی خود را بیان کنید'
                      : 'نام مشتری، شماره فاکتور، چک صیادی، کالای انبار یا گزارش مالی را بگویید یا تایپ کنید'}
                  </p>
                </div>
              </div>

              <button
                type="button"
                onClick={() => {
                  speech.stopListening();
                  onClose();
                }}
                aria-label="بستن جستجوی صوتی"
                className="h-9 w-9 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 inline-flex items-center justify-center shrink-0 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Live Transcript / Search Input + Active Audio Waveform */}
            <div className="p-4 border-b border-slate-100 dark:border-slate-800 space-y-3">
              <div className="flex items-center gap-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50/70 dark:bg-slate-950/70 px-3 min-h-[46px] focus-within:border-indigo-500 focus-within:ring-2 focus-within:ring-indigo-500/20 transition-all">
                <Search className="w-4 h-4 text-slate-400 shrink-0" />
                <input
                  ref={inputRef}
                  type="text"
                  value={query}
                  onChange={(e) => {
                    speech.clearError();
                    onQueryChange(e.target.value);
                  }}
                  placeholder="مثلاً: «فاکتورهای البرز»، «چک‌های سررسید»، «موجودی نخ پلی‌استر»، «گزارش سود و زیان»..."
                  className="flex-1 min-w-0 bg-transparent text-sm text-slate-900 dark:text-white placeholder:text-slate-400 py-2.5 focus:outline-none"
                  autoComplete="off"
                />

                {/* Live Voice Bars only while microphone is actively capturing */}
                {speech.isListening && (
                  <div className="flex items-center gap-0.5 h-5 px-1.5 shrink-0" aria-hidden="true">
                    {[0.4, 0.9, 0.6, 1, 0.5].map((heightRatio, idx) => (
                      <motion.span
                        key={idx}
                        className="w-1 rounded-full bg-rose-500"
                        animate={{
                          height: ['6px', `${Math.round(heightRatio * 18)}px`, '6px'],
                        }}
                        transition={{
                          duration: 0.65,
                          repeat: Infinity,
                          delay: idx * 0.09,
                          ease: 'easeInOut',
                        }}
                      />
                    ))}
                  </div>
                )}

                {query && (
                  <button
                    type="button"
                    onClick={() => onQueryChange('')}
                    aria-label="پاک کردن عبارت جستجو"
                    className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 cursor-pointer shrink-0"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}

                <button
                  type="button"
                  onClick={speech.toggleListening}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
                    speech.isListening
                      ? 'bg-rose-600 text-white hover:bg-rose-700'
                      : 'bg-indigo-50 dark:bg-indigo-950/70 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-100 dark:hover:bg-indigo-900/70'
                  }`}
                >
                  {speech.isListening ? (
                    <>
                      <Square className="w-3 h-3 fill-current" />
                      <span>توقف</span>
                    </>
                  ) : (
                    <>
                      <Mic className="w-3.5 h-3.5" />
                      <span>شروع صحبت</span>
                    </>
                  )}
                </button>
              </div>

              {speech.errorMessage && (
                <div className="text-xs text-rose-700 dark:text-rose-300 bg-rose-50/80 dark:bg-rose-950/30 border border-rose-200/80 dark:border-rose-900/70 rounded-xl px-3.5 py-2.5 leading-relaxed">
                  {speech.errorMessage}
                </div>
              )}

              {/* Detected Financial Domain Hint + Quick Voice Examples */}
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                {parsed.normalizedQuery ? (
                  <div className="flex flex-wrap items-center gap-2 text-slate-500 dark:text-slate-400">
                    <span>حوزه تشخیص‌داده‌شده:</span>
                    <span className="font-semibold text-indigo-700 dark:text-indigo-300">
                      {parsed.domainLabel}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span className="tabular-nums font-code">
                      {toPersianDigits(results.length)} نتیجه مالی
                    </span>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[11px] text-slate-500 dark:text-slate-400 ml-1">
                      نمونه فرمان‌های صوتی:
                    </span>
                    {VOICE_SEARCH_EXAMPLES.map((ex) => (
                      <button
                        key={ex.query}
                        type="button"
                        onClick={() => onQueryChange(ex.query)}
                        className="px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-indigo-50 dark:hover:bg-indigo-950/60 text-slate-700 dark:text-slate-200 hover:text-indigo-700 dark:hover:text-indigo-300 text-[11px] font-medium transition-colors whitespace-nowrap cursor-pointer"
                      >
                        {ex.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Instant Categorized Multi-Entity Financial Results */}
            <div className="flex-1 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800/80">
              {!parsed.normalizedQuery ? (
                <div className="p-8 text-center space-y-2">
                  <p className="text-sm font-semibold text-slate-800 dark:text-slate-200">
                    آماده جستجوی صوتی در تمام داده‌های مالی شما
                  </p>
                  <p className="text-xs text-slate-500 dark:text-slate-400 max-w-md mx-auto leading-relaxed">
                    فاکتورها، پیش‌فاکتورها، چک‌های صیادی، مانده طرف‌حساب‌ها، موجودی انبار، کدینگ حساب‌ها و گزارش‌های سود و زیان به‌صورت آنی و آفلاین جستجو می‌شوند.
                  </p>
                </div>
              ) : results.length === 0 ? (
                <div className="p-8 text-center space-y-1.5">
                  <p className="text-sm font-semibold text-slate-800 dark:text-slate-200">
                    رکورد مالی منطبق با «{query}» یافت نشد
                  </p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    نام طرف‌حساب، شماره فاکتور، نام کالا یا عنوان گزارش را کوتاه‌تر بیان یا تایپ کنید.
                  </p>
                </div>
              ) : (
                results.map((item) => {
                  const Icon = getDomainIcon(item.domain);
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => handleSelectResult(item)}
                      className="w-full px-5 py-3.5 text-right hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors flex items-center justify-between gap-3 cursor-pointer"
                    >
                      <div className="flex items-start gap-3 min-w-0">
                        <span className="w-9 h-9 rounded-xl bg-slate-100 dark:bg-slate-800 text-indigo-600 dark:text-indigo-400 flex items-center justify-center shrink-0 mt-0.5">
                          <Icon className="w-4 h-4" />
                        </span>
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-1.5 text-xs sm:text-sm font-semibold text-slate-900 dark:text-white">
                            <span className="truncate">
                              <HighlightedText
                                text={item.title}
                                query={parsed.cleanedKeywords || query}
                              />
                            </span>
                          </div>
                          <div className="text-[11.5px] text-slate-500 dark:text-slate-400 mt-0.5 flex flex-wrap items-center gap-1.5">
                            <span className="font-medium text-indigo-600 dark:text-indigo-400">
                              {item.domainLabel}
                            </span>
                            <span aria-hidden="true">·</span>
                            <span className="truncate">
                              <HighlightedText
                                text={item.subtitle}
                                query={parsed.cleanedKeywords || query}
                              />
                            </span>
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-2.5 shrink-0">
                        {item.amountText && (
                          <span
                            className={`font-code tabular-nums text-xs font-bold whitespace-nowrap ${
                              item.amountTone === 'positive'
                                ? 'text-emerald-700 dark:text-emerald-400'
                                : item.amountTone === 'negative'
                                  ? 'text-rose-700 dark:text-rose-400'
                                  : item.amountTone === 'warning'
                                    ? 'text-amber-700 dark:text-amber-400'
                                    : 'text-slate-800 dark:text-slate-200'
                            }`}
                          >
                            {item.amountText}
                          </span>
                        )}
                        <ArrowLeft className="w-4 h-4 text-slate-400 shrink-0" />
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
