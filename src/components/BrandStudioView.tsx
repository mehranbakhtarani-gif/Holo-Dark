import React, { useState } from 'react';
import { AlertCircle, Download, Image as ImageIcon, Loader2, ShieldCheck, Wand2 } from 'lucide-react';
import { useAccounting } from '../context/AccountingContext';

const IMAGE_SIZES = ['1K', '2K', '4K'] as const;
const ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9', '21:9'] as const;

type PaletteTheme = 'emerald_slate' | 'cobalt_gold' | 'obsidian_teal';

const STUDIO_PRESETS = [
  {
    label: 'سربرگ رسمی فاکتور شرکتی',
    ratio: '21:9' as const,
    theme: 'emerald_slate' as PaletteTheme,
    prompt: 'سربرگ رسمی فاکتور و صورتحساب الکترونیکی با خطوط معماری مدرن و هویت بصری شرکتی',
  },
  {
    label: 'کارت کاتالوگ محصولات انبار',
    ratio: '4:3' as const,
    theme: 'cobalt_gold' as PaletteTheme,
    prompt: 'قالب استاندارد معرفی کالا، مشخصات فنی و کدینگ انبار برای کاتالوگ فروش سازمانی',
  },
  {
    label: 'جلد گزارش مالی سالانه هیئت‌مدیره',
    ratio: '3:4' as const,
    theme: 'obsidian_teal' as PaletteTheme,
    prompt: 'جلد رسمی گزارش صورت‌های مالی حسابرسی‌شده و ترازنامه پایان دوره مالی',
  },
  {
    label: 'بنر معرفی خدمات بازرگانی',
    ratio: '16:9' as const,
    theme: 'emerald_slate' as PaletteTheme,
    prompt: 'بنر معرفی مجموعه بازرگانی و تولیدی با طراحی مینیمال، خوانا و آماده چاپ',
  },
];

const PALETTES: Record<
  PaletteTheme,
  {
    label: string;
    bg1: string;
    bg2: string;
    accent: string;
    secondary: string;
    ink: string;
    muted: string;
  }
> = {
  emerald_slate: {
    label: 'زمردی و سرمه‌ای شرکتی',
    bg1: '#0B172A',
    bg2: '#132A3E',
    accent: '#14B8A6',
    secondary: '#38BDF8',
    ink: '#F8FAFC',
    muted: '#CBD5E1',
  },
  cobalt_gold: {
    label: 'کبالتی و طلایی مالی',
    bg1: '#111827',
    bg2: '#1E3A5F',
    accent: '#F59E0B',
    secondary: '#60A5FA',
    ink: '#F8FAFC',
    muted: '#CBD5E1',
  },
  obsidian_teal: {
    label: 'مینیمال روشن آماده چاپ',
    bg1: '#F8FAFC',
    bg2: '#E2E8F0',
    accent: '#0F766E',
    secondary: '#2563EB',
    ink: '#0F172A',
    muted: '#475569',
  },
};

function computeCanvasDimensions(
  imageSize: (typeof IMAGE_SIZES)[number],
  aspectRatio: (typeof ASPECT_RATIOS)[number]
): { width: number; height: number } {
  const baseLongEdge = imageSize === '4K' ? 2400 : imageSize === '2K' ? 1600 : 1024;
  const [rw, rh] = aspectRatio.split(':').map(Number);
  if (rw >= rh) {
    return {
      width: baseLongEdge,
      height: Math.round((baseLongEdge * rh) / rw),
    };
  }
  return {
    width: Math.round((baseLongEdge * rw) / rh),
    height: baseLongEdge,
  };
}

/**
 * 100% Local Offline Studio Renderer (HTML5 Canvas 2D)
 * Generates crisp architectural corporate visuals completely inside the browser
 * with zero external cloud AI calls.
 */
function renderLocalCorporateGraphic(params: {
  title: string;
  subtitle: string;
  companyName: string;
  fiscalYear: string;
  imageSize: (typeof IMAGE_SIZES)[number];
  aspectRatio: (typeof ASPECT_RATIOS)[number];
  theme: PaletteTheme;
}): string {
  const { width, height } = computeCanvasDimensions(params.imageSize, params.aspectRatio);
  const pal = PALETTES[params.theme];
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('مرورگر از رندر گرافیکی محلی پشتیبانی نمی‌کند.');
  }

  // Background gradient
  const grad = ctx.createLinearGradient(0, 0, width, height);
  grad.addColorStop(0, pal.bg1);
  grad.addColorStop(1, pal.bg2);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);

  // Subtle architectural grid
  const gridStep = Math.max(36, Math.round(Math.min(width, height) / 14));
  ctx.strokeStyle =
    params.theme === 'obsidian_teal' ? 'rgba(15, 23, 42, 0.05)' : 'rgba(248, 250, 252, 0.05)';
  ctx.lineWidth = 1;
  for (let x = 0; x <= width; x += gridStep) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let y = 0; y <= height; y += gridStep) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  // Decorative geometric rings & diagonal ribbons
  const minSide = Math.min(width, height);
  ctx.save();
  ctx.globalAlpha = 0.14;
  const glow = ctx.createRadialGradient(
    width * 0.18,
    height * 0.25,
    minSide * 0.05,
    width * 0.18,
    height * 0.25,
    minSide * 0.72
  );
  glow.addColorStop(0, pal.accent);
  glow.addColorStop(1, 'transparent');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);

  const glow2 = ctx.createRadialGradient(
    width * 0.85,
    height * 0.8,
    minSide * 0.05,
    width * 0.85,
    height * 0.8,
    minSide * 0.6
  );
  glow2.addColorStop(0, pal.secondary);
  glow2.addColorStop(1, 'transparent');
  ctx.fillStyle = glow2;
  ctx.fillRect(0, 0, width, height);
  ctx.restore();

  // Architectural corner framing lines
  const pad = Math.round(minSide * 0.075);
  ctx.strokeStyle = pal.accent;
  ctx.lineWidth = Math.max(2, Math.round(minSide * 0.005));
  ctx.strokeRect(pad, pad, width - pad * 2, height - pad * 2);

  // Accent bar on right (RTL anchor)
  const barW = Math.max(8, Math.round(minSide * 0.018));
  ctx.fillStyle = pal.accent;
  ctx.fillRect(width - pad - barW, pad, barW, height - pad * 2);

  // Typography (RTL Persian safe)
  ctx.direction = 'rtl';
  ctx.textAlign = 'right';
  const textRightX = width - pad - barW - Math.round(minSide * 0.055);
  const maxTextWidth = width - pad * 2 - barW - Math.round(minSide * 0.12);

  // Company kicker
  const kickerSize = Math.max(16, Math.round(minSide * 0.036));
  ctx.font = `600 ${kickerSize}px Vazirmatn, Tahoma, sans-serif`;
  ctx.fillStyle = pal.accent;
  ctx.fillText(
    `${params.companyName || 'سیستم حسابداری هلو شرکتی'}  •  سال مالی ${params.fiscalYear || '۱۴۰۴'}`,
    textRightX,
    pad + Math.round(minSide * 0.11)
  );

  // Main prompt title wrapped cleanly
  const titleSize = Math.max(24, Math.round(minSide * 0.068));
  ctx.font = `800 ${titleSize}px Vazirmatn, Tahoma, sans-serif`;
  ctx.fillStyle = pal.ink;

  const words = params.title.trim().split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const w of words) {
    const test = current ? `${current} ${w}` : w;
    if (ctx.measureText(test).width > maxTextWidth && current) {
      lines.push(current);
      current = w;
      if (lines.length >= 3) break;
    } else {
      current = test;
    }
  }
  if (current && lines.length < 3) lines.push(current);

  const startY = Math.round(height * 0.44);
  const lineH = Math.round(titleSize * 1.48);
  lines.forEach((line, idx) => {
    ctx.fillText(line, textRightX, startY + idx * lineH);
  });

  // Subtitle / footer metadata
  const subSize = Math.max(14, Math.round(minSide * 0.03));
  ctx.font = `500 ${subSize}px Vazirmatn, Tahoma, sans-serif`;
  ctx.fillStyle = pal.muted;
  ctx.fillText(params.subtitle, textRightX, height - pad - Math.round(minSide * 0.06));

  return canvas.toDataURL('image/png');
}

export const BrandStudioView: React.FC = () => {
  const { profile, showToast } = useAccounting();
  const [prompt, setPrompt] = useState(STUDIO_PRESETS[0].prompt);
  const [imageSize, setImageSize] = useState<(typeof IMAGE_SIZES)[number]>('2K');
  const [aspectRatio, setAspectRatio] = useState<(typeof ASPECT_RATIOS)[number]>('16:9');
  const [theme, setTheme] = useState<PaletteTheme>('emerald_slate');
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedUrl, setGeneratedUrl] = useState<string | null>(null);
  const [caption, setCaption] = useState<string>('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [imgFallback, setImgFallback] = useState(false);

  const handleGenerate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim()) return;
    setIsGenerating(true);
    setErrorMsg(null);

    try {
      const dataUrl = renderLocalCorporateGraphic({
        title: prompt.trim(),
        subtitle: `طراحی و رندر ۱۰۰٪ محلی و آفلاین • ${imageSize} (${aspectRatio})`,
        companyName: profile.companyName,
        fiscalYear: profile.fiscalYear,
        imageSize,
        aspectRatio,
        theme,
      });
      setGeneratedUrl(dataUrl);
      setCaption(
        `خروجی ${imageSize} با نسبت ${aspectRatio} کاملاً درون دستگاه (بدون ارسال داده به سرور ابری) رندر شد.`
      );
      showToast('طرح گرافیکی سازمانی به صورت کاملاً محلی تولید شد.');
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'خطا در رندر محلی تصویر سازمانی رخ داد.';
      setErrorMsg(msg);
      showToast(msg);
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-white">
            استودیو طراحی بصری اسناد، کاتالوگ کالا و هویت شرکتی
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            رندر بومی و آفلاین سربرگ فاکتور رسمی، کاتالوگ انبار و جلد گزارش‌های هیئت‌مدیره در وضوح ۱K تا ۴K
          </p>
        </div>
        <div className="inline-flex items-center gap-1.5 text-[11px] font-medium text-teal-800 dark:text-teal-300 bg-teal-50 dark:bg-teal-950/50 border border-teal-200 dark:border-teal-800 rounded-lg px-3 py-1.5">
          <ShieldCheck className="w-3.5 h-3.5" />
          <span>پردازش ۱۰۰٪ محلی و آفلاین (بدون ارسال داده به فضای ابری)</span>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
        {/* Controls Column */}
        <form
          onSubmit={handleGenerate}
          className="xl:col-span-5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-5"
        >
          <div className="space-y-2">
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
              الگوهای آماده سازمانی
            </label>
            <div className="grid grid-cols-2 gap-2">
              {STUDIO_PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  onClick={() => {
                    setPrompt(preset.prompt);
                    setAspectRatio(preset.ratio);
                    setTheme(preset.theme);
                  }}
                  className="text-right p-2.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 hover:border-teal-600 dark:hover:border-teal-500 bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-200 transition-colors"
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
              تیتر یا شرح طرح مورد نظر
            </label>
            <textarea
              rows={3}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="عنوان سربرگ فاکتور، جلد گزارش مالی سالانه یا بنر معرفی شرکت..."
              className="w-full p-3 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white leading-6 focus:outline-none focus:ring-2 focus:ring-teal-600/30"
            />
          </div>

          {/* Local Palette Theme Selector */}
          <div className="space-y-1.5">
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
              پالت رنگی هویت بصری
            </label>
            <div className="grid grid-cols-3 gap-2">
              {(Object.keys(PALETTES) as PaletteTheme[]).map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setTheme(key)}
                  className={`px-2.5 py-2 text-[11px] font-medium rounded-lg border transition-colors ${
                    theme === key
                      ? 'border-teal-700 bg-teal-50 dark:bg-teal-950/40 text-teal-900 dark:text-teal-200'
                      : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400'
                  }`}
                >
                  {PALETTES[key].label}
                </button>
              ))}
            </div>
          </div>

          {/* Resolution (1K / 2K / 4K) */}
          <div className="space-y-1.5">
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
              وضوح خروجی تصویر (Resolution)
            </label>
            <div className="grid grid-cols-3 gap-2" dir="ltr">
              {IMAGE_SIZES.map((sz) => (
                <button
                  key={sz}
                  type="button"
                  onClick={() => setImageSize(sz)}
                  className={`py-2 text-xs font-code font-semibold rounded-lg border transition-colors ${
                    imageSize === sz
                      ? 'border-teal-700 bg-teal-700 text-white'
                      : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
                  }`}
                >
                  {sz}
                </button>
              ))}
            </div>
          </div>

          {/* Aspect Ratio */}
          <div className="space-y-1.5">
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
              نسبت ابعاد تصویر (Aspect Ratio)
            </label>
            <div className="grid grid-cols-4 gap-2" dir="ltr">
              {ASPECT_RATIOS.map((ar) => (
                <button
                  key={ar}
                  type="button"
                  onClick={() => setAspectRatio(ar)}
                  className={`py-2 text-xs font-code font-medium rounded-lg border transition-colors ${
                    aspectRatio === ar
                      ? 'border-teal-700 bg-teal-700 text-white'
                      : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
                  }`}
                >
                  {ar}
                </button>
              ))}
            </div>
          </div>

          <button
            type="submit"
            disabled={isGenerating}
            className="w-full inline-flex items-center justify-center gap-2 py-2.5 px-4 text-sm font-semibold text-white bg-teal-700 hover:bg-teal-800 disabled:opacity-60 rounded-lg transition-colors"
          >
            {isGenerating ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>در حال رندر محلی {imageSize} ({aspectRatio})...</span>
              </>
            ) : (
              <>
                <Wand2 className="w-4 h-4" />
                <span>تولید آفلاین تصویر سازمانی</span>
              </>
            )}
          </button>
        </form>

        {/* Preview Column */}
        <div className="xl:col-span-7 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 flex flex-col justify-between space-y-4">
          <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-3">
            <div className="text-sm font-bold text-slate-900 dark:text-white">
              پیش‌نمایش خروجی استودیو محلی
            </div>
            <div className="text-xs font-code text-slate-500">
              {imageSize} · {aspectRatio}
            </div>
          </div>

          {errorMsg && (
            <div className="p-4 rounded-lg bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 text-xs text-rose-800 dark:text-rose-200 flex items-start gap-2.5 leading-6">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{errorMsg}</span>
            </div>
          )}

          <div className="flex-1 flex items-center justify-center bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden min-h-[340px]">
            {generatedUrl ? (
              <img
                src={generatedUrl}
                alt="تصویر تولیدشده برای اسناد سازمانی"
                className="max-h-[460px] w-full object-contain"
              />
            ) : !imgFallback ? (
              <div className="relative w-full h-full min-h-[340px]">
                <img
                  src="/src/assets/images/corporate_hq_banner_1795265734976.jpg"
                  alt="نمونه هویت بصری شرکتی هلو Apex"
                  onError={() => setImgFallback(true)}
                  className="w-full h-full object-cover min-h-[340px]"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-slate-950/80 via-slate-950/20 to-transparent flex flex-col justify-end p-6 text-white">
                  <div className="text-sm font-bold">استودیوی آفلاین هویت بصری شرکتی</div>
                  <div className="text-xs text-slate-200 mt-1">
                    وضوح، نسبت ابعاد و پالت رنگی را انتخاب کنید تا خروجی استاندارد کاملاً درون دستگاه شما ساخته شود.
                  </div>
                </div>
              </div>
            ) : (
              <div className="p-8 text-center text-slate-500 space-y-2">
                <ImageIcon className="w-8 h-8 mx-auto text-slate-400" />
                <div className="text-xs">پیش‌نمایش تصویر تولیدشده در این بخش نمایش داده می‌شود.</div>
              </div>
            )}
          </div>

          {caption && (
            <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">{caption}</p>
          )}

          {generatedUrl && (
            <div className="flex justify-end">
              <a
                href={generatedUrl}
                download={`holoo-apex-asset-${imageSize}-${aspectRatio.replace(':', 'x')}.png`}
                className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-slate-900 dark:bg-teal-700 hover:bg-slate-800 rounded-lg"
              >
                <Download className="w-4 h-4" />
                <span>دانلود فایل PNG با کیفیت اصلی</span>
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
