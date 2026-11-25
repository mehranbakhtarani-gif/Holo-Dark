/**
 * Offline-Native Web Audio API Feedback Engine for Holoo Apex 9.6
 * Zero external audio assets — synthesizes crisp, subtle, studio-grade tones
 * directly via browser AudioContext so it works 100% offline with <2ms latency.
 */

export type AudioFeedbackTone = 'success' | 'error' | 'warning' | 'neutral';

const AUDIO_PREF_KEY = 'holoo_apex_audio_feedback_v1';

let sharedAudioCtx: AudioContext | null = null;
let lastPlayedAt = 0;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;

  try {
    if (!sharedAudioCtx || sharedAudioCtx.state === 'closed') {
      sharedAudioCtx = new Ctor();
    }
    if (sharedAudioCtx.state === 'suspended') {
      void sharedAudioCtx.resume().catch(() => {});
    }
    return sharedAudioCtx;
  } catch {
    return null;
  }
}

export function isAudioFeedbackEnabled(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    const raw = window.localStorage.getItem(AUDIO_PREF_KEY);
    if (raw === null) return true; // Enabled by default
    return raw !== '0' && raw !== 'false';
  } catch {
    return true;
  }
}

export function setAudioFeedbackEnabled(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(AUDIO_PREF_KEY, enabled ? '1' : '0');
  } catch {
    // Ignore storage quota errors
  }
}

function scheduleNote(
  ctx: AudioContext,
  opts: {
    freq: number;
    endFreq?: number;
    startOffset: number;
    duration: number;
    gainPeak: number;
    type: OscillatorType;
    filterFreq?: number;
  }
): void {
  const now = ctx.currentTime + opts.startOffset;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = opts.type;
  osc.frequency.setValueAtTime(opts.freq, now);
  if (opts.endFreq && opts.endFreq !== opts.freq) {
    osc.frequency.exponentialRampToValueAtTime(opts.endFreq, now + opts.duration);
  }

  // Smooth zero-click ADSR envelope
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.linearRampToValueAtTime(opts.gainPeak, now + 0.014);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + opts.duration);

  if (opts.filterFreq) {
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(opts.filterFreq, now);
    osc.connect(filter);
    filter.connect(gain);
  } else {
    osc.connect(gain);
  }

  gain.connect(ctx.destination);
  osc.start(now);
  osc.stop(now + opts.duration + 0.02);
}

/**
 * Modern, gentle ascending crystal chime for successful vouchers, invoices, saves & syncs.
 */
export function playSuccessChime(force = false): void {
  if (!force && !isAudioFeedbackEnabled()) return;
  const nowMs = Date.now();
  if (!force && nowMs - lastPlayedAt < 90) return;
  lastPlayedAt = nowMs;

  const ctx = getAudioContext();
  if (!ctx) return;

  try {
    // Crisp modern ascending fifth (E5 -> B5) with subtle warm harmonic shimmer
    scheduleNote(ctx, {
      freq: 659.25,
      startOffset: 0,
      duration: 0.14,
      gainPeak: 0.095,
      type: 'sine',
      filterFreq: 2800,
    });
    scheduleNote(ctx, {
      freq: 987.77,
      startOffset: 0.075,
      duration: 0.22,
      gainPeak: 0.085,
      type: 'sine',
      filterFreq: 3200,
    });
    scheduleNote(ctx, {
      freq: 1318.51,
      startOffset: 0.075,
      duration: 0.19,
      gainPeak: 0.028,
      type: 'triangle',
      filterFreq: 2600,
    });
  } catch {
    // Fail silently if browser autoplay policy blocks sound before first gesture
  }
}

/**
 * Distinct, non-harsh descending minor interval for errors, mismatches & rejected operations.
 */
export function playErrorTone(force = false): void {
  if (!force && !isAudioFeedbackEnabled()) return;
  const nowMs = Date.now();
  if (!force && nowMs - lastPlayedAt < 90) return;
  lastPlayedAt = nowMs;

  const ctx = getAudioContext();
  if (!ctx) return;

  try {
    // Soft descending minor-third pulse (D4 -> B3) with warm low-pass filter
    scheduleNote(ctx, {
      freq: 311.13,
      endFreq: 293.66,
      startOffset: 0,
      duration: 0.13,
      gainPeak: 0.09,
      type: 'triangle',
      filterFreq: 950,
    });
    scheduleNote(ctx, {
      freq: 246.94,
      endFreq: 220.0,
      startOffset: 0.115,
      duration: 0.18,
      gainPeak: 0.085,
      type: 'triangle',
      filterFreq: 850,
    });
  } catch {
    // Fail silently
  }
}

/**
 * Soft double-tap neutral chime for warnings, conflicts, or caution notices.
 */
export function playWarningTone(force = false): void {
  if (!force && !isAudioFeedbackEnabled()) return;
  const nowMs = Date.now();
  if (!force && nowMs - lastPlayedAt < 90) return;
  lastPlayedAt = nowMs;

  const ctx = getAudioContext();
  if (!ctx) return;

  try {
    scheduleNote(ctx, {
      freq: 440.0,
      startOffset: 0,
      duration: 0.11,
      gainPeak: 0.07,
      type: 'sine',
      filterFreq: 1600,
    });
    scheduleNote(ctx, {
      freq: 392.0,
      startOffset: 0.105,
      duration: 0.15,
      gainPeak: 0.065,
      type: 'sine',
      filterFreq: 1500,
    });
  } catch {
    // Fail silently
  }
}

const ERROR_KEYWORDS = [
  'خطا',
  'ناموفق',
  'کافی نیست',
  'تداخل',
  'منفی',
  'مجاز نیست',
  'غیرمجاز',
  'نامعتبر',
  'یافت نشد',
  'عدم توازن',
  'تراز نیست',
  'مغایرت',
  'رد شد',
  'مسدود',
  'امکان',
  'نمی‌توان',
  'نمی‌شود',
  'برقرار نشد',
  'انجام نشد',
  'باید دقیقاً',
  'باید بزرگ‌تر',
  'باید بیشتر',
  'الزامی است',
  'اشتباه',
  'لغو شد',
];

const WARNING_KEYWORDS = [
  'هشدار',
  'سقف اعتبار',
  'برگشتی',
  'موقت',
  'آفلاین',
  'تغییر یافت',
  'حذف شد',
  'ابطال',
  'خارج شدید',
  'لطفاً',
  'انتخاب کنید',
  'وارد کنید',
];

/**
 * Classifies Persian toast notifications into semantic audio tones so every
 * module in the application receives accurate audio feedback automatically.
 */
export function inferToastTone(message: string): AudioFeedbackTone {
  const clean = (message || '').trim();
  if (!clean) return 'neutral';
  if (ERROR_KEYWORDS.some((kw) => clean.includes(kw))) return 'error';
  if (WARNING_KEYWORDS.some((kw) => clean.includes(kw))) return 'warning';
  return 'success';
}

export function playFeedbackForTone(tone: AudioFeedbackTone): void {
  if (tone === 'error') {
    playErrorTone();
  } else if (tone === 'warning') {
    playWarningTone();
  } else if (tone === 'success') {
    playSuccessChime();
  }
}
