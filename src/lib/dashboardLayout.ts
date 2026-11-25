/**
 * Persistent Dashboard Layout Engine (Drag-and-Drop Card Order & Visibility)
 * Stores user workspace customization locally in `localStorage` under `holoo_dashboard_layout_v1`
 * (automatically cleared by `clearHolooLocalStorageKeys` during full factory reset).
 */

export type DashboardKpiCardId = 'balance' | 'receivables' | 'inventory';

export type DashboardWidgetCardId =
  | 'recent_invoices'
  | 'quick_actions'
  | 'liquidity_pulse'
  | 'urgent_cheques';

export interface DashboardLayoutConfig {
  kpiOrder: DashboardKpiCardId[];
  widgetOrder: DashboardWidgetCardId[];
  hiddenWidgets: DashboardWidgetCardId[];
}

export const DASHBOARD_LAYOUT_STORAGE_KEY = 'holoo_dashboard_layout_v1';

export const DEFAULT_KPI_ORDER: readonly DashboardKpiCardId[] = [
  'balance',
  'receivables',
  'inventory',
] as const;

export const DEFAULT_WIDGET_ORDER: readonly DashboardWidgetCardId[] = [
  'recent_invoices',
  'quick_actions',
  'liquidity_pulse',
  'urgent_cheques',
] as const;

export const DASHBOARD_WIDGET_META: Record<
  DashboardWidgetCardId,
  {
    title: string;
    colSpanClass: string;
  }
> = {
  recent_invoices: {
    title: 'آخرین اسناد و فاکتورها',
    colSpanClass: 'lg:col-span-8',
  },
  quick_actions: {
    title: 'دسترسی سریع و هشدار انبار',
    colSpanClass: 'lg:col-span-4',
  },
  liquidity_pulse: {
    title: 'نبض نقدینگی ماهانه',
    colSpanClass: 'lg:col-span-7',
  },
  urgent_cheques: {
    title: 'سررسید چک‌های اولویت‌دار',
    colSpanClass: 'lg:col-span-5',
  },
};

export function createDefaultDashboardLayout(): DashboardLayoutConfig {
  return {
    kpiOrder: [...DEFAULT_KPI_ORDER],
    widgetOrder: [...DEFAULT_WIDGET_ORDER],
    hiddenWidgets: [],
  };
}

function normalizeIdList<T extends string>(raw: unknown, allowed: readonly T[]): T[] {
  const allowedSet = new Set<string>(allowed);
  const seen = new Set<T>();
  const result: T[] = [];

  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === 'string' && allowedSet.has(item) && !seen.has(item as T)) {
        seen.add(item as T);
        result.push(item as T);
      }
    }
  }

  for (const fallback of allowed) {
    if (!seen.has(fallback)) {
      result.push(fallback);
    }
  }
  return result;
}

export function normalizeDashboardLayout(raw: unknown): DashboardLayoutConfig {
  if (!raw || typeof raw !== 'object') {
    return createDefaultDashboardLayout();
  }
  const obj = raw as Record<string, unknown>;
  const kpiOrder = normalizeIdList(obj.kpiOrder, DEFAULT_KPI_ORDER);
  const widgetOrder = normalizeIdList(obj.widgetOrder, DEFAULT_WIDGET_ORDER);

  const allowedWidgetSet = new Set<string>(DEFAULT_WIDGET_ORDER);
  const hiddenSet = new Set<DashboardWidgetCardId>();
  if (Array.isArray(obj.hiddenWidgets)) {
    for (const id of obj.hiddenWidgets) {
      if (typeof id === 'string' && allowedWidgetSet.has(id)) {
        hiddenSet.add(id as DashboardWidgetCardId);
      }
    }
  }

  // Guarantee at least one widget remains visible
  if (hiddenSet.size >= DEFAULT_WIDGET_ORDER.length) {
    hiddenSet.delete(widgetOrder[0]);
  }

  return {
    kpiOrder,
    widgetOrder,
    hiddenWidgets: Array.from(hiddenSet),
  };
}

export function loadDashboardLayout(): DashboardLayoutConfig {
  if (typeof window === 'undefined' || !window.localStorage) {
    return createDefaultDashboardLayout();
  }
  try {
    const raw = window.localStorage.getItem(DASHBOARD_LAYOUT_STORAGE_KEY);
    if (!raw) return createDefaultDashboardLayout();
    const parsed: unknown = JSON.parse(raw);
    return normalizeDashboardLayout(parsed);
  } catch {
    return createDefaultDashboardLayout();
  }
}

export function saveDashboardLayout(config: DashboardLayoutConfig): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    const clean = normalizeDashboardLayout(config);
    window.localStorage.setItem(DASHBOARD_LAYOUT_STORAGE_KEY, JSON.stringify(clean));
  } catch {
    // Ignore quota or storage restriction errors silently
  }
}

export function resetDashboardLayoutStorage(): DashboardLayoutConfig {
  const def = createDefaultDashboardLayout();
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      window.localStorage.removeItem(DASHBOARD_LAYOUT_STORAGE_KEY);
    } catch {
      // Ignore storage access errors
    }
  }
  return def;
}

export function reorderIds<T extends string>(
  items: readonly T[],
  activeId: T,
  overId: T
): T[] {
  if (activeId === overId) return [...items];
  const oldIndex = items.indexOf(activeId);
  const newIndex = items.indexOf(overId);
  if (oldIndex === -1 || newIndex === -1) return [...items];
  const next = [...items];
  const [moved] = next.splice(oldIndex, 1);
  next.splice(newIndex, 0, moved);
  return next;
}

export function toggleDashboardWidgetVisibility(
  config: DashboardLayoutConfig,
  widgetId: DashboardWidgetCardId
): DashboardLayoutConfig {
  const isHidden = config.hiddenWidgets.includes(widgetId);
  if (isHidden) {
    return {
      ...config,
      hiddenWidgets: config.hiddenWidgets.filter((id) => id !== widgetId),
    };
  }
  const visibleCount = config.widgetOrder.length - config.hiddenWidgets.length;
  if (visibleCount <= 1) {
    return config;
  }
  return {
    ...config,
    hiddenWidgets: [...config.hiddenWidgets, widgetId],
  };
}

export function isDefaultDashboardLayout(config: DashboardLayoutConfig): boolean {
  if (config.hiddenWidgets.length > 0) return false;
  for (let i = 0; i < DEFAULT_KPI_ORDER.length; i++) {
    if (config.kpiOrder[i] !== DEFAULT_KPI_ORDER[i]) return false;
  }
  for (let i = 0; i < DEFAULT_WIDGET_ORDER.length; i++) {
    if (config.widgetOrder[i] !== DEFAULT_WIDGET_ORDER[i]) return false;
  }
  return true;
}
