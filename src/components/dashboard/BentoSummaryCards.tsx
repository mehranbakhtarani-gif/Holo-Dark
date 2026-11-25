import React, { useId } from 'react';
import { motion } from 'framer-motion';
import { MoreHorizontal } from 'lucide-react';

export type SparklineTone = 'emerald' | 'indigo' | 'coral';

export interface BentoSummaryCardItem {
  id: string;
  kicker?: string;
  title: string;
  amount: string;
  unitText: string;
  badgeText: string;
  tone: SparklineTone;
  amountAccent?: 'default' | 'indigo' | 'emerald' | 'coral';
  subtext?: string;
  sparkline: number[];
  onClick: () => void;
}

const snappySpring = {
  type: 'spring' as const,
  stiffness: 420,
  damping: 32,
  mass: 0.8,
};

function buildSmoothSparklinePaths(values: number[], width = 260, height = 46): {
  linePath: string;
  areaPath: string;
} {
  const safe = values.length >= 2 ? values : [12, 18, 15, 22, 20, 28, 26, 34];
  const min = Math.min(...safe);
  const max = Math.max(...safe);
  const range = max - min || 1;
  const padY = 6;
  const usableH = height - padY * 2;
  const stepX = width / (safe.length - 1);

  const pts = safe.map((v, i) => ({
    x: Number((i * stepX).toFixed(2)),
    y: Number((height - padY - ((v - min) / range) * usableH).toFixed(2)),
  }));

  let line = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i];
    const p1 = pts[i + 1];
    const cx = Number(((p0.x + p1.x) / 2).toFixed(2));
    line += ` C ${cx} ${p0.y}, ${cx} ${p1.y}, ${p1.x} ${p1.y}`;
  }

  const area = `${line} L ${pts[pts.length - 1].x} ${height} L ${pts[0].x} ${height} Z`;
  return { linePath: line, areaPath: area };
}

const TONE_CONFIG: Record<
  SparklineTone,
  {
    stroke: string;
    glow: string;
    badgeBg: string;
    badgeText: string;
  }
> = {
  emerald: {
    stroke: '#10B981',
    glow: 'rgba(16, 185, 129, 0.36)',
    badgeBg: 'bg-emerald-500/15 border border-emerald-500/20',
    badgeText: 'text-emerald-600 dark:text-emerald-400',
  },
  indigo: {
    stroke: '#818CF8',
    glow: 'rgba(129, 140, 248, 0.38)',
    badgeBg: 'bg-indigo-500/15 border border-indigo-500/20',
    badgeText: 'text-indigo-600 dark:text-[#818CF8]',
  },
  coral: {
    stroke: '#EF4444',
    glow: 'rgba(239, 68, 68, 0.34)',
    badgeBg: 'bg-red-500/15 border border-red-500/20',
    badgeText: 'text-red-600 dark:text-red-400',
  },
};

const SparklineSvg: React.FC<{ data: number[]; tone: SparklineTone }> = ({ data, tone }) => {
  const uid = useId().replace(/:/g, '');
  const cfg = TONE_CONFIG[tone];
  const { linePath, areaPath } = buildSmoothSparklinePaths(data);

  return (
    <div className="w-full h-11 mt-3 overflow-hidden" dir="ltr" aria-hidden="true">
      <svg
        viewBox="0 0 260 46"
        preserveAspectRatio="none"
        className="w-full h-full overflow-visible"
      >
        <defs>
          <linearGradient id={`sparkGrad-${uid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={cfg.stroke} stopOpacity="0.30" />
            <stop offset="100%" stopColor={cfg.stroke} stopOpacity="0.01" />
          </linearGradient>
          <filter id={`sparkGlow-${uid}`} x="-10%" y="-30%" width="120%" height="160%">
            <feDropShadow dx="0" dy="2" stdDeviation="3" floodColor={cfg.glow} />
          </filter>
        </defs>
        <path d={areaPath} fill={`url(#sparkGrad-${uid})`} />
        <path
          d={linePath}
          fill="none"
          stroke={cfg.stroke}
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          filter={`url(#sparkGlow-${uid})`}
        />
      </svg>
    </div>
  );
};

export const BentoSummaryCards: React.FC<{
  cards: BentoSummaryCardItem[];
}> = ({ cards }) => {
  return (
    <section
      aria-label="شاخص‌های کلیدی مالی"
      className="grid grid-cols-1 md:grid-cols-3 gap-4"
    >
      {cards.map((card, index) => {
        const cfg = TONE_CONFIG[card.tone];
        const amountColor =
          card.amountAccent === 'indigo'
            ? 'text-indigo-600 dark:text-[#818CF8]'
            : card.amountAccent === 'emerald'
              ? 'text-emerald-600 dark:text-emerald-400'
              : card.amountAccent === 'coral'
                ? 'text-red-600 dark:text-red-400'
                : 'text-[#0F172A] dark:text-white';

        return (
          <motion.div
            key={card.id}
            role="button"
            tabIndex={0}
            onClick={card.onClick}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                card.onClick();
              }
            }}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            whileHover={{ y: -2 }}
            whileTap={{ scale: 0.99 }}
            transition={{ ...snappySpring, delay: index * 0.04 }}
            className="group relative bg-white dark:bg-[#151A24] rounded-2xl border border-slate-200/80 dark:border-white/[0.07] hover:border-indigo-300/80 dark:hover:border-white/[0.14] shadow-[0_2px_12px_-4px_rgba(15,23,42,0.06)] dark:shadow-[0_10px_30px_-14px_rgba(0,0,0,0.65)] p-5 pb-3.5 flex flex-col justify-between cursor-pointer text-right transition-colors overflow-hidden"
          >
            {/* Header Row */}
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                {card.kicker && (
                  <div className="text-[13px] font-semibold text-slate-900 dark:text-slate-100 leading-tight mb-1 truncate">
                    {card.kicker}
                  </div>
                )}
                <div className="text-xs font-medium text-slate-500 dark:text-slate-400 truncate">
                  {card.title}
                </div>
              </div>
              <span
                className="p-1 -m-1 rounded-lg text-slate-400 dark:text-slate-500 group-hover:text-slate-700 dark:group-hover:text-slate-200 transition-colors shrink-0"
                aria-hidden="true"
              >
                <MoreHorizontal className="w-4 h-4" />
              </span>
            </div>

            {/* Value + Trend Pill Row */}
            <div className="mt-3 flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-baseline gap-1.5 min-w-0">
                <span
                  className={`text-2xl sm:text-[26px] font-extrabold tracking-tight tabular-nums font-code truncate ${amountColor}`}
                >
                  {card.amount}
                </span>
                <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400 shrink-0">
                  {card.unitText}
                </span>
              </div>

              <span
                className={`inline-flex items-center px-2.5 py-0.5 rounded-lg text-[11px] font-bold tabular-nums font-code whitespace-nowrap shrink-0 ${cfg.badgeBg} ${cfg.badgeText}`}
              >
                {card.badgeText}
              </span>
            </div>

            {card.subtext && (
              <div className="mt-1.5 text-[11px] text-slate-500 dark:text-slate-400 truncate tabular-nums">
                {card.subtext}
              </div>
            )}

            {/* Smooth Glowing SVG Area Sparkline */}
            <SparklineSvg data={card.sparkline} tone={card.tone} />
          </motion.div>
        );
      })}
    </section>
  );
};
