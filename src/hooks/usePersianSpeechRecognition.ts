import { useCallback, useEffect, useRef, useState } from 'react';

interface SpeechRecognitionAlternativeLike {
  transcript: string;
  confidence?: number;
}

interface SpeechRecognitionResultLike {
  isFinal: boolean;
  0: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
}

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives?: number;
  onresult: ((ev: SpeechRecognitionEventLike) => void) | null;
  onerror: ((ev: { error?: string }) => void) | null;
  onend: (() => void) | null;
  onstart?: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort?: () => void;
}

export interface UsePersianSpeechOptions {
  onInterim?: (text: string) => void;
  onFinal?: (text: string) => void;
  onError?: (message: string) => void;
}

export interface PersianSpeechController {
  isSupported: boolean;
  isListening: boolean;
  interimTranscript: string;
  errorMessage: string | null;
  startListening: () => void;
  stopListening: () => void;
  toggleListening: () => void;
  clearError: () => void;
}

function getSpeechRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === 'undefined') return null;
  const win = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return win.SpeechRecognition || win.webkitSpeechRecognition || null;
}

/**
 * Reusable Persian (fa-IR) Web Speech API hook with live interim transcription,
 * clean unmount cancellation, and localized Persian error reporting.
 */
export function usePersianSpeechRecognition(
  options: UsePersianSpeechOptions = {}
): PersianSpeechController {
  const { onInterim, onFinal, onError } = options;
  const [isListening, setIsListening] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const callbacksRef = useRef({ onInterim, onFinal, onError });
  callbacksRef.current = { onInterim, onFinal, onError };

  const isSupported = getSpeechRecognitionCtor() !== null;

  const stopListening = useCallback(() => {
    try {
      recognitionRef.current?.stop();
    } catch {
      // ignore if already stopped
    }
    setIsListening(false);
  }, []);

  useEffect(() => {
    return () => {
      try {
        recognitionRef.current?.abort?.();
        recognitionRef.current?.stop();
      } catch {
        // ignore cleanup error
      }
      recognitionRef.current = null;
    };
  }, []);

  const startListening = useCallback(() => {
    const SpeechRec = getSpeechRecognitionCtor();
    if (!SpeechRec) {
      const msg =
        'مرورگر فعلی از تشخیص گفتار فارسی (Web Speech API) پشتیبانی نمی‌کند. می‌توانید عبارت مالی را تایپ کنید یا از نمونه فرمان‌های آماده استفاده نمایید.';
      setErrorMessage(msg);
      callbacksRef.current.onError?.(msg);
      return;
    }

    try {
      if (recognitionRef.current) {
        try {
          recognitionRef.current.abort?.();
        } catch {
          // ignore
        }
      }

      const rec = new SpeechRec();
      rec.lang = 'fa-IR';
      rec.continuous = false;
      rec.interimResults = true;
      rec.maxAlternatives = 1;

      setErrorMessage(null);
      setInterimTranscript('');

      rec.onstart = () => {
        setIsListening(true);
      };

      rec.onresult = (ev) => {
        let finalText = '';
        let interimText = '';

        for (let i = 0; i < ev.results.length; i++) {
          const res = ev.results[i];
          const seg = res?.[0]?.transcript ?? '';
          if (!seg) continue;
          if (res.isFinal) {
            finalText += `${seg} `;
          } else {
            interimText += `${seg} `;
          }
        }

        const combinedLive = `${finalText}${interimText}`.trim();
        setInterimTranscript(combinedLive);
        if (combinedLive) {
          callbacksRef.current.onInterim?.(combinedLive);
        }

        const cleanedFinal = finalText.trim();
        if (cleanedFinal) {
          callbacksRef.current.onFinal?.(cleanedFinal);
        }
      };

      rec.onerror = (ev) => {
        setIsListening(false);
        const code = ev?.error || 'unknown';
        if (code === 'aborted') return;
        let msg: string;
        if (code === 'not-allowed' || code === 'service-not-allowed') {
          msg =
            'دسترسی میکروفون مسدود است. لطفاً مجوز میکروفون را در تنظیمات مرورگر فعال کنید.';
        } else if (code === 'no-speech') {
          msg = 'صدایی دریافت نشد. لطفاً نزدیک‌تر به میکروفون صحبت کنید و دوباره تلاش نمایید.';
        } else if (code === 'audio-capture') {
          msg = 'میکروفون متصل یافت نشد. اتصال میکروفون دستگاه را بررسی کنید.';
        } else if (code === 'network') {
          msg = 'سرویس تشخیص گفتار مرورگر در دسترس نیست؛ می‌توانید عبارت را مستقیم تایپ کنید.';
        } else {
          msg = `خطا در تشخیص گفتار فارسی (${code}). لطفاً مجدداً تلاش کنید.`;
        }
        setErrorMessage(msg);
        callbacksRef.current.onError?.(msg);
      };

      rec.onend = () => {
        setIsListening(false);
      };

      recognitionRef.current = rec;
      setIsListening(true);
      rec.start();
    } catch {
      setIsListening(false);
      const msg = 'امکان فعال‌سازی میکروفون در این محیط وجود ندارد.';
      setErrorMessage(msg);
      callbacksRef.current.onError?.(msg);
    }
  }, []);

  const toggleListening = useCallback(() => {
    if (isListening) {
      stopListening();
    } else {
      startListening();
    }
  }, [isListening, startListening, stopListening]);

  const clearError = useCallback(() => {
    setErrorMessage(null);
  }, []);

  return {
    isSupported,
    isListening,
    interimTranscript,
    errorMessage,
    startListening,
    stopListening,
    toggleListening,
    clearError,
  };
}
