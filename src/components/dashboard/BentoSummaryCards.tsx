import React, { useId, useMemo, useState } from 'react';
import { LayoutGroup, motion } from 'framer-motion';
import {
  closestCenter,
  defaultDropAnimationSideEffects,
  DndContext,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
  DropAnimation,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  rectSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Maximize2 } from 'lucide-react';
import type { DashboardKpiCardId } from '../../lib/dashboardLayout';

export type SparklineTone = 'emerald' | 'indigo' | 'coral';

export interface BentoSummaryCardItem {
  id: DashboardKpiCardId;
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

const kpiLayoutSpring = {
  type: 'spring' as const,
  stiffness: 430,
  damping: 34,
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
    trendText: string;
  }
> = {
  emerald: {
    stroke: '#10B981',
    glow: 'rgba(16, 185, 129, 0.36)',
    trendText: 'text-emerald-600 dark:text-emerald-400',
  },
  indigo: {
    stroke: '#6366F1',
    glow: 'rgba(99, 102, 241, 0.36)',
    trendText: 'text-indigo-600 dark:text-[#818CF8]',
  },
  coral: {
    stroke: '#EF4444',
    glow: 'rgba(239, 68, 68, 0.34)',
    trendText: 'text-rose-600 dark:text-rose-400',
  },
};

const dropAnimation: DropAnimation = {
  duration: 210,
  easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
  sideEffects: defaultDropAnimationSideEffects({
    styles: {
      active: {
        opacity: '0.32',
      },
    },
  }),
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
            <stop offset="0%" stopColor={cfg.stroke} stopOpacity="0.28" />
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

interface KpiCardContentProps {
  card: BentoSummaryCardItem;
  isCustomizing: boolean;
  isDragging?: boolean;
  isOverlay?: boolean;
  onExpand?: (id: DashboardKpiCardId) => void;
  dragHandleRef?: (element: HTMLElement | null) => void;
  dragHandleProps?: React.ButtonHTMLAttributes<HTMLButtonElement>;
}

const KpiCardSurface: React.FC<KpiCardContentProps> = ({
  card,
  isCustomizing,
  isDragging = false,
  isOverlay = false,
  onExpand,
  dragHandleRef,
  dragHandleProps,
}) => {
  const cfg = TONE_CONFIG[card.tone];
  const amountColor =
    card.amountAccent === 'indigo'
      ? 'text-indigo-600 dark:text-[#818CF8]'
      : card.amountAccent === 'emerald'
        ? 'text-emerald-600 dark:text-emerald-400'
        : card.amountAccent === 'coral'
          ? 'text-rose-600 dark:text-rose-400'
          : 'text-[#0F172A] dark:text-white';

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => {
        if (!isCustomizing && !isDragging) {
          card.onClick();
        }
      }}
      onKeyDown={(e) => {
        if (!isCustomizing && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          card.onClick();
        }
      }}
      className={`group relative h-full bg-white dark:bg-[#151A24] rounded-2xl border p-5 pb-3.5 flex flex-col justify-between text-right transition-colors overflow-hidden ${
        isOverlay
          ? 'border-indigo-500 shadow-2xl cursor-grabbing ring-2 ring-indigo-500/25'
          : isDragging
            ? 'border-dashed border-indigo-400 dark:border-indigo-500 shadow-none'
            : isCustomizing
              ? 'border-dashed border-indigo-300 dark:border-indigo-600/80 shadow-[0_2px_12px_-4px_rgba(15,23,42,0.06)] select-none'
              : 'border-slate-200/80 dark:border-white/[0.07] hover:border-indigo-300/80 dark:hover:border-white/[0.14] shadow-[0_2px_12px_-4px_rgba(15,23,42,0.06)] dark:shadow-[0_10px_30px_-14px_rgba(0,0,0,0.65)] cursor-pointer'
      }`}
    >
      {/* Header Row with Functional dnd-kit Drag Handle */}
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
        <div className="inline-flex items-center gap-1 -mt-1 -ml-1 shrink-0">
          {onExpand && !isOverlay && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onExpand(card.id);
              }}
              title={`نمایش «${card.title}» در ابعاد کامل`}
              aria-label={`نمایش در ابعاد کامل ${card.title}`}
              className="h-8 w-8 rounded-lg border border-transparent text-slate-400 dark:text-slate-500 hover:text-indigo-600 dark:hover:text-indigo-300 hover:bg-slate-100 dark:hover:bg-slate-800 hover:border-slate-200 dark:hover:border-slate-700 inline-flex items-center justify-center transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40"
            >
              <Maximize2 className="w-3.5 h-3.5 shrink-0" />
            </button>
          )}
          <button
            ref={dragHandleRef}
            type="button"
            onClick={(e) => e.stopPropagation()}
            title={`کشیدن برای جابه‌جایی کارت «${card.title}»`}
            aria-label={`جابه‌جایی کارت ${card.title}`}
            {...dragHandleProps}
            className={`h-8 w-8 rounded-lg border inline-flex items-center justify-center touch-none select-none shrink-0 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40 ${
              isOverlay
                ? 'cursor-grabbing bg-indigo-600 border-indigo-600 text-white'
                : isCustomizing
                  ? 'cursor-grab bg-indigo-50 dark:bg-indigo-950/80 border-indigo-300 dark:border-indigo-700 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-100 dark:hover:bg-indigo-900/70'
                  : 'cursor-grab border-transparent text-slate-400 dark:text-slate-500 hover:text-indigo-600 dark:hover:text-indigo-300 hover:bg-slate-100 dark:hover:bg-slate-800 hover:border-slate-200 dark:hover:border-slate-700'
            }`}
          >
            <GripVertical className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Value + Clean Unboxed Trend Metadata Row */}
      <div className="mt-3 flex items-baseline justify-between gap-2 flex-wrap">
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
          className={`text-[11px] font-bold tabular-nums font-code whitespace-nowrap shrink-0 ${cfg.trendText}`}
        >
          {card.badgeText}
        </span>
      </div>

      {card.subtext && (
        <div className="mt-1.5 text-[11px] text-slate-500 dark:text-slate-400 truncate tabular-nums">
          {card.subtext}
        </div>
      )}

      {/* Smooth SVG Area Sparkline */}
      <SparklineSvg data={card.sparkline} tone={card.tone} />
    </div>
  );
};

const SortableKpiCard: React.FC<{
  card: BentoSummaryCardItem;
  isCustomizing: boolean;
  isAnyDragging: boolean;
  onExpand?: (id: DashboardKpiCardId) => void;
}> = ({ card, isCustomizing, isAnyDragging, onExpand }) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: card.id,
    transition: {
      duration: 240,
      easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
    },
  });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div ref={setNodeRef} style={style} className={`min-w-0 ${isDragging ? 'z-30' : 'z-0'}`}>
      <motion.div
        layout={isDragging || isAnyDragging ? false : 'position'}
        animate={{
          opacity: isDragging ? 0.32 : 1,
          scale: isDragging ? 0.98 : 1,
        }}
        whileHover={!isCustomizing && !isAnyDragging ? { y: -2 } : undefined}
        transition={{
          layout: kpiLayoutSpring,
          opacity: { duration: 0.15 },
          scale: kpiLayoutSpring,
          y: kpiLayoutSpring,
        }}
        className="h-full"
      >
        <KpiCardSurface
          card={card}
          isCustomizing={isCustomizing}
          isDragging={isDragging}
          onExpand={onExpand}
          dragHandleRef={setActivatorNodeRef}
          dragHandleProps={{ ...attributes, ...listeners }}
        />
      </motion.div>
    </div>
  );
};

export const BentoSummaryCards: React.FC<{
  cards: BentoSummaryCardItem[];
  isCustomizing?: boolean;
  onReorder?: (activeId: DashboardKpiCardId, overId: DashboardKpiCardId) => void;
  onExpand?: (id: DashboardKpiCardId) => void;
}> = ({ cards, isCustomizing = false, onReorder, onExpand }) => {
  const [activeId, setActiveId] = useState<DashboardKpiCardId | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 180, tolerance: 6 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const itemIds = useMemo(() => cards.map((c) => c.id), [cards]);
  const activeCard = useMemo(
    () => (activeId ? cards.find((c) => c.id === activeId) ?? null : null),
    [activeId, cards]
  );

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(event.active.id as DashboardKpiCardId);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveId(null);
    if (over && active.id !== over.id) {
      onReorder?.(active.id as DashboardKpiCardId, over.id as DashboardKpiCardId);
    }
  };

  return (
    <LayoutGroup id="dashboard-kpi-cards">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setActiveId(null)}
      >
        <SortableContext items={itemIds} strategy={rectSortingStrategy}>
          <section
            aria-label="شاخص‌های کلیدی مالی قابل جابه‌جایی"
            className="grid grid-cols-1 md:grid-cols-3 gap-4"
          >
            {cards.map((card) => (
              <SortableKpiCard
                key={card.id}
                card={card}
                isCustomizing={isCustomizing}
                isAnyDragging={activeId !== null}
                onExpand={onExpand}
              />
            ))}
          </section>
        </SortableContext>

        <DragOverlay dropAnimation={dropAnimation}>
          {activeCard ? (
            <motion.div
              dir="rtl"
              initial={{ scale: 0.99, opacity: 0.94 }}
              animate={{ scale: 1.025, opacity: 1 }}
              transition={kpiLayoutSpring}
              className="w-full"
            >
              <KpiCardSurface card={activeCard} isCustomizing={isCustomizing} isOverlay />
            </motion.div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </LayoutGroup>
  );
};
