import React from 'react';
import { motion } from 'framer-motion';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { EyeOff, GripVertical, Maximize2 } from 'lucide-react';
import type { DashboardWidgetCardId } from '../../lib/dashboardLayout';

const cardLayoutSpring = {
  type: 'spring' as const,
  stiffness: 420,
  damping: 34,
  mass: 0.85,
};

interface SortableDashboardCardProps {
  id: DashboardWidgetCardId;
  title: string;
  colSpanClass: string;
  isCustomizing: boolean;
  isAnyDragging?: boolean;
  canHide: boolean;
  onHide?: (id: DashboardWidgetCardId) => void;
  onExpand?: (id: DashboardWidgetCardId) => void;
  children: (dragControls: React.ReactNode) => React.ReactNode;
}

export const SortableDashboardCard: React.FC<SortableDashboardCardProps> = ({
  id,
  title,
  colSpanClass,
  isCustomizing,
  isAnyDragging = false,
  canHide,
  onHide,
  onExpand,
  children,
}) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id,
    transition: {
      duration: 240,
      easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
    },
  });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const dragControls = (
    <div className="inline-flex items-center gap-1 shrink-0">
      <button
        ref={setActivatorNodeRef}
        type="button"
        {...attributes}
        {...listeners}
        title={`کشیدن برای جابه‌جایی «${title}»`}
        aria-label={`جابه‌جایی کارت ${title}`}
        className={`h-8 w-8 rounded-lg border inline-flex items-center justify-center touch-none select-none transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40 ${
          isDragging
            ? 'cursor-grabbing bg-indigo-600 border-indigo-600 text-white shadow-sm'
            : isCustomizing
              ? 'cursor-grab bg-indigo-50 dark:bg-indigo-950/80 border-indigo-300 dark:border-indigo-700 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-100 dark:hover:bg-indigo-900/70'
              : 'cursor-grab border-transparent text-slate-400 dark:text-slate-500 hover:text-indigo-600 dark:hover:text-indigo-300 hover:bg-slate-100 dark:hover:bg-slate-800 hover:border-slate-200 dark:hover:border-slate-700'
        }`}
      >
        <GripVertical className="w-4 h-4 shrink-0" />
      </button>

      {onExpand && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onExpand(id);
          }}
          title={`نمایش «${title}» در ابعاد کامل`}
          aria-label={`نمایش در ابعاد کامل ${title}`}
          className="h-8 w-8 rounded-lg border border-transparent text-slate-400 dark:text-slate-500 hover:text-indigo-600 dark:hover:text-indigo-300 hover:bg-slate-100 dark:hover:bg-slate-800 hover:border-slate-200 dark:hover:border-slate-700 inline-flex items-center justify-center transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40"
        >
          <Maximize2 className="w-3.5 h-3.5 shrink-0" />
        </button>
      )}

      {isCustomizing && canHide && onHide && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onHide(id);
          }}
          title={`مخفی کردن «${title}»`}
          aria-label={`مخفی کردن کارت ${title}`}
          className="h-8 w-8 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-400 hover:text-rose-600 dark:hover:text-rose-400 hover:border-rose-300 dark:hover:border-rose-700 inline-flex items-center justify-center transition-colors cursor-pointer"
        >
          <EyeOff className="w-3.5 h-3.5 shrink-0" />
        </button>
      )}
    </div>
  );

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`${colSpanClass} relative flex flex-col min-w-0 rounded-2xl ${
        isDragging ? 'z-30' : 'z-0'
      }`}
    >
      {/* Framer Motion FLIP layout transition glides cards smoothly across Bento grid rows/columns on reorder, drop, hide, restore, and reset */}
      <motion.div
        layout={isDragging || isAnyDragging ? false : 'position'}
        initial={{ opacity: 0, scale: 0.97 }}
        animate={{
          opacity: isDragging ? 0.32 : 1,
          scale: isDragging ? 0.985 : 1,
        }}
        exit={{ opacity: 0, scale: 0.96 }}
        transition={{
          layout: cardLayoutSpring,
          opacity: { duration: 0.16 },
          scale: cardLayoutSpring,
        }}
        className={`flex-1 flex flex-col min-w-0 rounded-2xl transition-shadow ${
          isDragging
            ? 'ring-2 ring-dashed ring-indigo-500/75'
            : isCustomizing
              ? 'ring-1 ring-dashed ring-indigo-400/75 dark:ring-indigo-500/60 hover:ring-indigo-500 select-none'
              : ''
        }`}
      >
        {children(dragControls)}
      </motion.div>
    </div>
  );
};
