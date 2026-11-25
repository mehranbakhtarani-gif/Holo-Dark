import React from 'react';
import { MessageCircle, MessageSquare, Send, Share2 } from 'lucide-react';
import {
  buildBaleShareUrl,
  buildRubikaShareUrl,
  buildTelegramShareUrl,
  buildWhatsAppShareUrl,
} from '../lib/format';

interface MessengerShareActionsProps {
  text: string;
  phone?: string;
  compact?: boolean;
  labelPrefix?: string;
  onShared?: (platformLabel: string) => void;
}

/**
 * Unified 4-Platform Messenger Share Bar:
 * Always includes WhatsApp, Telegram, Bale (بله), and Rubika (روبیکا) for invoices,
 * receipts, customer statements, and payment/cheque reminders.
 */
export const MessengerShareActions: React.FC<MessengerShareActionsProps> = ({
  text,
  phone,
  compact = false,
  labelPrefix = 'ارسال در',
  onShared,
}) => {
  const whatsappUrl = buildWhatsAppShareUrl(text, phone);
  const telegramUrl = buildTelegramShareUrl(text);
  const baleUrl = buildBaleShareUrl(text);
  const rubikaUrl = buildRubikaShareUrl(text);

  const handleCopyFallback = (platformLabel: string) => {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        void navigator.clipboard.writeText(text).catch(() => {});
      }
    } catch {
      // Ignore clipboard permission restrictions
    }
    onShared?.(platformLabel);
  };

  if (compact) {
    return (
      <div className="inline-flex items-center gap-1 flex-wrap">
        <a
          href={whatsappUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => handleCopyFallback('واتساپ')}
          title={`${labelPrefix} واتساپ`}
          className="inline-flex items-center justify-center p-1.5 rounded border border-emerald-200 dark:border-emerald-900 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950/40 transition-colors"
        >
          <MessageCircle className="w-3.5 h-3.5" />
        </a>
        <a
          href={telegramUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => handleCopyFallback('تلگرام')}
          title={`${labelPrefix} تلگرام`}
          className="inline-flex items-center justify-center p-1.5 rounded border border-sky-200 dark:border-sky-900 text-sky-700 dark:text-sky-400 hover:bg-sky-50 dark:hover:bg-sky-950/40 transition-colors"
        >
          <Send className="w-3.5 h-3.5" />
        </a>
        <a
          href={baleUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => handleCopyFallback('بله')}
          title={`${labelPrefix} پیام‌رسان بله`}
          className="inline-flex items-center justify-center px-1.5 py-1 rounded border border-cyan-200 dark:border-cyan-900 text-cyan-700 dark:text-cyan-400 hover:bg-cyan-50 dark:hover:bg-cyan-950/40 text-[10px] font-bold leading-none transition-colors"
        >
          بله
        </a>
        <a
          href={rubikaUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => handleCopyFallback('روبیکا')}
          title={`${labelPrefix} روبیکا`}
          className="inline-flex items-center justify-center px-1.5 py-1 rounded border border-purple-200 dark:border-purple-900 text-purple-700 dark:text-purple-400 hover:bg-purple-50 dark:hover:bg-purple-950/40 text-[10px] font-bold leading-none transition-colors"
        >
          روبیکا
        </a>
      </div>
    );
  }

  return (
    <div className="inline-flex flex-wrap items-center gap-1.5">
      <a
        href={whatsappUrl}
        target="_blank"
        rel="noopener noreferrer"
        onClick={() => handleCopyFallback('واتساپ')}
        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg transition-colors whitespace-nowrap"
      >
        <MessageCircle className="w-3.5 h-3.5" />
        <span>واتساپ</span>
      </a>
      <a
        href={telegramUrl}
        target="_blank"
        rel="noopener noreferrer"
        onClick={() => handleCopyFallback('تلگرام')}
        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold text-white bg-sky-600 hover:bg-sky-700 rounded-lg transition-colors whitespace-nowrap"
      >
        <Send className="w-3.5 h-3.5" />
        <span>تلگرام</span>
      </a>
      <a
        href={baleUrl}
        target="_blank"
        rel="noopener noreferrer"
        onClick={() => handleCopyFallback('بله')}
        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold text-white bg-cyan-600 hover:bg-cyan-700 rounded-lg transition-colors whitespace-nowrap"
      >
        <MessageSquare className="w-3.5 h-3.5" />
        <span>بله</span>
      </a>
      <a
        href={rubikaUrl}
        target="_blank"
        rel="noopener noreferrer"
        onClick={() => handleCopyFallback('روبیکا')}
        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold text-white bg-purple-600 hover:bg-purple-700 rounded-lg transition-colors whitespace-nowrap"
      >
        <Share2 className="w-3.5 h-3.5" />
        <span>روبیکا</span>
      </a>
    </div>
  );
};
