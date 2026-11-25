import { CompanyProfile, CurrencyUnit } from '../types/accounting';
import { exportToCsv, getTodayShamsi, toPersianDigits } from './format';

export type ReportOrientation = 'portrait' | 'landscape';

export interface ReportColumnDef {
  key: string;
  label: string;
  align?: 'right' | 'left' | 'center';
  isNumeric?: boolean;
  isCode?: boolean;
  defaultVisible: boolean;
  essential?: boolean;
  widthHint?: string;
}

export interface ReportDataRow {
  id: string;
  cells: Record<string, string>;
  rowType?: 'normal' | 'section' | 'subtotal' | 'total';
  highlight?: 'positive' | 'negative' | 'accent';
}

export interface ReportKpiItem {
  label: string;
  value: string;
  tone?: 'neutral' | 'positive' | 'negative' | 'accent';
}

export interface StandardAccountingReportSpec {
  reportId: string;
  fileNamePrefix: string;
  title: string;
  subtitle?: string;
  periodLabel: string;
  voucherScopeLabel: string;
  currencyUnit: CurrencyUnit;
  recommendedOrientation: ReportOrientation;
  columns: ReportColumnDef[];
  rows: ReportDataRow[];
  footerTotals?: Record<string, string>;
  footerLabel?: string;
  kpis?: ReportKpiItem[];
  notes?: string[];
}

export interface AccountingReportPrintOptions {
  orientation: ReportOrientation;
  showRowNumbers: boolean;
  showSignatures: boolean;
  showKpis: boolean;
  compactDensity: boolean;
  customSubtitle?: string;
  preparedBy?: string;
}

export interface SavedReportColumnState {
  selectedKeys: string[];
  orderedKeys: string[];
}

const STORAGE_KEY = 'holoo_apex_report_columns_v1';

export function escapeHtml(input: string | number | null | undefined): string {
  const s = String(input ?? '');
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function getDefaultColumnState(columns: ReportColumnDef[]): SavedReportColumnState {
  const orderedKeys = columns.map((c) => c.key);
  const selectedKeys = columns.filter((c) => c.defaultVisible).map((c) => c.key);
  return {
    orderedKeys,
    selectedKeys: selectedKeys.length > 0 ? selectedKeys : orderedKeys.slice(0, 1),
  };
}

export function normalizeColumnState(
  columns: ReportColumnDef[],
  saved?: Partial<SavedReportColumnState> | null
): SavedReportColumnState {
  const validKeySet = new Set(columns.map((c) => c.key));
  const defaults = getDefaultColumnState(columns);
  if (!saved) return defaults;

  const savedOrdered = Array.isArray(saved.orderedKeys)
    ? saved.orderedKeys.filter((k) => validKeySet.has(k))
    : [];
  const missingFromOrder = columns
    .map((c) => c.key)
    .filter((k) => !savedOrdered.includes(k));
  const orderedKeys = [...savedOrdered, ...missingFromOrder];

  const savedSelected = Array.isArray(saved.selectedKeys)
    ? saved.selectedKeys.filter((k) => validKeySet.has(k))
    : [];
  const selectedKeys =
    savedSelected.length > 0
      ? orderedKeys.filter((k) => savedSelected.includes(k))
      : defaults.selectedKeys;

  return { orderedKeys, selectedKeys };
}

export function loadSavedReportColumnState(
  reportId: string,
  columns: ReportColumnDef[]
): SavedReportColumnState {
  try {
    if (typeof window === 'undefined' || !window.localStorage) {
      return getDefaultColumnState(columns);
    }
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return getDefaultColumnState(columns);
    const parsed = JSON.parse(raw) as Record<string, Partial<SavedReportColumnState>>;
    return normalizeColumnState(columns, parsed?.[reportId]);
  } catch {
    return getDefaultColumnState(columns);
  }
}

export function saveReportColumnState(
  reportId: string,
  state: SavedReportColumnState
): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const existing: Record<string, SavedReportColumnState> = raw ? JSON.parse(raw) : {};
    existing[reportId] = {
      orderedKeys: [...state.orderedKeys],
      selectedKeys: [...state.selectedKeys],
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(existing));
  } catch {
    // Ignore storage quota / private mode failures gracefully
  }
}

export function toggleReportColumnSelection(
  state: SavedReportColumnState,
  columnKey: string
): SavedReportColumnState {
  const isSelected = state.selectedKeys.includes(columnKey);
  if (isSelected) {
    // Enforce at least 1 visible column in any report
    if (state.selectedKeys.length <= 1) return state;
    return {
      ...state,
      selectedKeys: state.selectedKeys.filter((k) => k !== columnKey),
    };
  }
  const nextSet = new Set([...state.selectedKeys, columnKey]);
  return {
    ...state,
    selectedKeys: state.orderedKeys.filter((k) => nextSet.has(k)),
  };
}

export function moveReportColumnOrder(
  state: SavedReportColumnState,
  columnKey: string,
  direction: 'up' | 'down'
): SavedReportColumnState {
  const idx = state.orderedKeys.indexOf(columnKey);
  if (idx < 0) return state;
  const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
  if (targetIdx < 0 || targetIdx >= state.orderedKeys.length) return state;

  const nextOrder = [...state.orderedKeys];
  const [moved] = nextOrder.splice(idx, 1);
  nextOrder.splice(targetIdx, 0, moved);

  const selectedSet = new Set(state.selectedKeys);
  return {
    orderedKeys: nextOrder,
    selectedKeys: nextOrder.filter((k) => selectedSet.has(k)),
  };
}

export function resolveVisibleColumns(
  columns: ReportColumnDef[],
  state: SavedReportColumnState
): ReportColumnDef[] {
  const byKey = new Map(columns.map((c) => [c.key, c]));
  const normalized = normalizeColumnState(columns, state);
  const selectedSet = new Set(normalized.selectedKeys);
  const resolved = normalized.orderedKeys
    .filter((k) => selectedSet.has(k))
    .map((k) => byKey.get(k))
    .filter((c): c is ReportColumnDef => Boolean(c));
  return resolved.length > 0 ? resolved : columns.slice(0, 1);
}

export function resolveOrderedColumns(
  columns: ReportColumnDef[],
  state: SavedReportColumnState
): ReportColumnDef[] {
  const byKey = new Map(columns.map((c) => [c.key, c]));
  const normalized = normalizeColumnState(columns, state);
  return normalized.orderedKeys
    .map((k) => byKey.get(k))
    .filter((c): c is ReportColumnDef => Boolean(c));
}

export function buildSelectedColumnsCsvData(
  spec: StandardAccountingReportSpec,
  visibleColumns: ReportColumnDef[],
  includeRowNumbers: boolean
): { headers: string[]; rows: string[][] } {
  const headers = [
    ...(includeRowNumbers ? ['ردیف'] : []),
    ...visibleColumns.map((c) => c.label),
  ];

  let seq = 0;
  const rows: string[][] = spec.rows.map((row) => {
    const isNormal = !row.rowType || row.rowType === 'normal';
    if (isNormal) seq += 1;
    return [
      ...(includeRowNumbers ? [isNormal ? String(seq) : ''] : []),
      ...visibleColumns.map((c) => row.cells[c.key] ?? ''),
    ];
  });

  if (spec.footerTotals) {
    const totalRow = [
      ...(includeRowNumbers ? [''] : []),
      ...visibleColumns.map((c, idx) => {
        if (spec.footerTotals && spec.footerTotals[c.key] !== undefined) {
          return spec.footerTotals[c.key];
        }
        return idx === 0 ? (spec.footerLabel ?? 'جمع کل') : '';
      }),
    ];
    rows.push(totalRow);
  }

  return { headers, rows };
}

export function exportSelectedColumnsCsv(
  spec: StandardAccountingReportSpec,
  visibleColumns: ReportColumnDef[],
  includeRowNumbers: boolean,
  fiscalYear: string
): void {
  const { headers, rows } = buildSelectedColumnsCsvData(spec, visibleColumns, includeRowNumbers);
  exportToCsv(`${spec.fileNamePrefix}-${fiscalYear}.csv`, headers, rows);
}

function getPrintDocumentStyles(options: AccountingReportPrintOptions): string {
  const pageSize = options.orientation === 'landscape' ? 'A4 landscape' : 'A4 portrait';
  const cellPad = options.compactDensity ? '5px 7px' : '7px 9px';
  const fontSize = options.compactDensity ? '10.5px' : '11.5px';

  return `
    @page {
      size: ${pageSize};
      margin: 11mm 10mm 13mm 10mm;
    }
    * {
      box-sizing: border-box;
    }
    html, body {
      margin: 0;
      padding: 0;
      direction: rtl;
      font-family: 'Vazirmatn', Tahoma, system-ui, sans-serif;
      color: #0f172a;
      background: #ffffff;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .acc-sheet {
      width: 100%;
      background: #ffffff;
      color: #0f172a;
      padding: 16px 20px 18px 20px;
    }
    .acc-letterhead {
      border: 1.5px solid #0f172a;
      border-radius: 6px;
      padding: 12px 16px;
      margin-bottom: 12px;
      background: #ffffff;
    }
    .acc-letterhead-top {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 14px;
      border-bottom: 1px solid #cbd5e1;
      padding-bottom: 9px;
      margin-bottom: 9px;
    }
    .acc-company-name {
      font-size: 16px;
      font-weight: 800;
      color: #0f172a;
      margin: 0 0 3px 0;
    }
    .acc-company-meta {
      font-size: 10.5px;
      color: #475569;
      margin: 0;
    }
    .acc-report-title-wrap {
      text-align: center;
      flex: 1;
    }
    .acc-report-title {
      font-size: 15px;
      font-weight: 800;
      color: #0f766e;
      margin: 0 0 3px 0;
    }
    .acc-report-subtitle {
      font-size: 10.5px;
      color: #334155;
      margin: 0;
    }
    .acc-stamp-box {
      text-align: left;
      font-size: 10px;
      color: #334155;
      line-height: 1.7;
      min-width: 135px;
    }
    .acc-meta-strip {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      gap: 8px 18px;
      font-size: 10.5px;
      color: #334155;
    }
    .acc-meta-item strong {
      color: #0f172a;
      font-weight: 700;
    }
    .acc-kpi-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(135px, 1fr));
      gap: 8px;
      margin-bottom: 12px;
    }
    .acc-kpi-card {
      border: 1px solid #cbd5e1;
      border-radius: 5px;
      padding: 7px 10px;
      background: #f8fafc;
    }
    .acc-kpi-label {
      font-size: 9.5px;
      color: #475569;
      margin-bottom: 3px;
    }
    .acc-kpi-value {
      font-size: 12px;
      font-weight: 800;
      color: #0f172a;
      font-variant-numeric: tabular-nums;
      direction: ltr;
      text-align: right;
    }
    .acc-kpi-positive { color: #047857; }
    .acc-kpi-negative { color: #be123c; }
    .acc-kpi-accent { color: #0f766e; }

    table.acc-table {
      width: 100%;
      border-collapse: collapse;
      border: 1.5px solid #0f172a;
      font-size: ${fontSize};
      table-layout: auto;
    }
    table.acc-table thead {
      display: table-header-group;
    }
    table.acc-table tfoot {
      display: table-row-group;
    }
    table.acc-table th {
      background: #f1f5f9;
      color: #0f172a;
      font-weight: 700;
      padding: ${cellPad};
      border: 1px solid #94a3b8;
      border-bottom: 2px solid #0f172a;
      white-space: nowrap;
      vertical-align: middle;
    }
    table.acc-table td {
      padding: ${cellPad};
      border: 1px solid #cbd5e1;
      vertical-align: middle;
      color: #0f172a;
      line-height: 1.5;
    }
    table.acc-table tbody tr {
      break-inside: avoid;
      page-break-inside: avoid;
    }
    table.acc-table tbody tr:nth-child(even) td {
      background: #f8fafc;
    }
    table.acc-table tr.acc-row-section td {
      background: #e2e8f0 !important;
      font-weight: 800;
      color: #0f172a;
      border-top: 1.5px solid #64748b;
    }
    table.acc-table tr.acc-row-subtotal td {
      background: #f1f5f9 !important;
      font-weight: 700;
      border-top: 1.5px solid #475569;
      border-bottom: 1.5px solid #475569;
    }
    table.acc-table tr.acc-row-total td,
    table.acc-table tfoot tr.acc-total-row td {
      background: #f1f5f9 !important;
      font-weight: 800;
      color: #0f172a;
      border-top: 2px solid #0f172a;
      border-bottom: 3.5px double #0f172a;
    }
    .acc-num {
      font-family: 'IBM Plex Mono', 'Vazirmatn', ui-monospace, monospace;
      font-variant-numeric: tabular-nums;
      text-align: left;
      direction: ltr;
      white-space: nowrap;
    }
    .acc-code {
      font-family: 'IBM Plex Mono', 'Vazirmatn', ui-monospace, monospace;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    .acc-right { text-align: right; }
    .acc-left { text-align: left; }
    .acc-center { text-align: center; }
    .acc-positive { color: #047857 !important; }
    .acc-negative { color: #be123c !important; }
    .acc-accent { color: #0f766e !important; }

    .acc-notes {
      margin-top: 10px;
      padding: 8px 12px;
      border: 1px dashed #94a3b8;
      border-radius: 5px;
      background: #f8fafc;
      font-size: 10px;
      color: #334155;
      line-height: 1.7;
    }
    .acc-signatures {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 16px;
      margin-top: 22px;
      break-inside: avoid;
      page-break-inside: avoid;
    }
    .acc-sig-box {
      border: 1px solid #cbd5e1;
      border-radius: 5px;
      padding: 10px 12px 34px 12px;
      text-align: center;
      background: #ffffff;
    }
    .acc-sig-role {
      font-size: 10.5px;
      font-weight: 700;
      color: #0f172a;
      margin-bottom: 4px;
    }
    .acc-sig-sub {
      font-size: 9.5px;
      color: #64748b;
    }
    .acc-footer-bar {
      margin-top: 12px;
      padding-top: 7px;
      border-top: 1px solid #cbd5e1;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 9.5px;
      color: #64748b;
    }
  `;
}

export function buildStandardAccountingReportBodyHtml(
  spec: StandardAccountingReportSpec,
  visibleColumns: ReportColumnDef[],
  profile: CompanyProfile,
  options: AccountingReportPrintOptions
): string {
  const printDate = toPersianDigits(getTodayShamsi());
  const currencyLabel = spec.currencyUnit === 'IRT' ? 'تومان ایران' : 'ریال ایران';
  const subtitleText = options.customSubtitle?.trim() || spec.subtitle || '';
  const totalColumnCount = visibleColumns.length + (options.showRowNumbers ? 1 : 0);

  const companyMetaParts: string[] = [];
  if (profile.economicCode) companyMetaParts.push(`کد اقتصادی: ${toPersianDigits(profile.economicCode)}`);
  if (profile.nationalId) companyMetaParts.push(`شناسه ملی: ${toPersianDigits(profile.nationalId)}`);

  const kpiHtml =
    options.showKpis && spec.kpis && spec.kpis.length > 0
      ? `<div class="acc-kpi-grid">${spec.kpis
          .map((k) => {
            const toneClass =
              k.tone === 'positive'
                ? 'acc-kpi-positive'
                : k.tone === 'negative'
                  ? 'acc-kpi-negative'
                  : k.tone === 'accent'
                    ? 'acc-kpi-accent'
                    : '';
            return `<div class="acc-kpi-card">
              <div class="acc-kpi-label">${escapeHtml(k.label)}</div>
              <div class="acc-kpi-value ${toneClass}">${escapeHtml(k.value)}</div>
            </div>`;
          })
          .join('')}</div>`
      : '';

  const theadCells = [
    ...(options.showRowNumbers ? ['<th class="acc-center" style="width:36px;">ردیف</th>'] : []),
    ...visibleColumns.map((col) => {
      const alignClass =
        col.align === 'left' || col.isNumeric
          ? 'acc-left'
          : col.align === 'center'
            ? 'acc-center'
            : 'acc-right';
      const widthStyle = col.widthHint ? ` style="width:${escapeHtml(col.widthHint)};"` : '';
      return `<th class="${alignClass}"${widthStyle}>${escapeHtml(col.label)}</th>`;
    }),
  ].join('');

  let rowSeq = 0;
  const tbodyRows =
    spec.rows.length === 0
      ? `<tr><td colspan="${totalColumnCount}" class="acc-center" style="padding:20px;color:#64748b;">ردیفی برای نمایش در این گزارش وجود ندارد.</td></tr>`
      : spec.rows
          .map((row) => {
            const isNormal = !row.rowType || row.rowType === 'normal';
            if (isNormal) rowSeq += 1;

            const trClass =
              row.rowType === 'section'
                ? 'acc-row-section'
                : row.rowType === 'subtotal'
                  ? 'acc-row-subtotal'
                  : row.rowType === 'total'
                    ? 'acc-row-total'
                    : '';

            const hlClass =
              row.highlight === 'positive'
                ? 'acc-positive'
                : row.highlight === 'negative'
                  ? 'acc-negative'
                  : row.highlight === 'accent'
                    ? 'acc-accent'
                    : '';

            const tds = [
              ...(options.showRowNumbers
                ? [
                    `<td class="acc-center acc-code" style="color:#64748b;">${
                      isNormal ? escapeHtml(toPersianDigits(rowSeq)) : ''
                    }</td>`,
                  ]
                : []),
              ...visibleColumns.map((col) => {
                const rawVal = row.cells[col.key] ?? '—';
                const classes: string[] = [];
                if (col.isNumeric) {
                  classes.push('acc-num');
                } else if (col.isCode) {
                  classes.push('acc-code');
                  classes.push(col.align === 'center' ? 'acc-center' : col.align === 'left' ? 'acc-left' : 'acc-right');
                } else {
                  classes.push(col.align === 'center' ? 'acc-center' : col.align === 'left' ? 'acc-left' : 'acc-right');
                }
                if (hlClass && (col.isNumeric || row.rowType === 'total' || row.rowType === 'subtotal')) {
                  classes.push(hlClass);
                }
                return `<td class="${classes.join(' ')}">${escapeHtml(rawVal)}</td>`;
              }),
            ].join('');

            return `<tr class="${trClass}">${tds}</tr>`;
          })
          .join('');

  const tfootHtml = spec.footerTotals
    ? `<tfoot><tr class="acc-total-row">${[
        ...(options.showRowNumbers ? ['<td class="acc-center">—</td>'] : []),
        ...visibleColumns.map((col, idx) => {
          const val =
            spec.footerTotals?.[col.key] !== undefined
              ? spec.footerTotals[col.key]
              : idx === 0
                ? (spec.footerLabel ?? 'جمع کل')
                : '';
          const alignClass = col.isNumeric
            ? 'acc-num'
            : col.align === 'center'
              ? 'acc-center'
              : 'acc-right';
          return `<td class="${alignClass}">${escapeHtml(val)}</td>`;
        }),
      ].join('')}</tr></tfoot>`
    : '';

  const notesHtml =
    spec.notes && spec.notes.length > 0
      ? `<div class="acc-notes"><strong>توضیحات و یادداشت‌های حسابداری:</strong><br/>${spec.notes
          .map((n) => `• ${escapeHtml(n)}`)
          .join('<br/>')}</div>`
      : '';

  const signaturesHtml = options.showSignatures
    ? `<div class="acc-signatures">
        <div class="acc-sig-box">
          <div class="acc-sig-role">تنظیم‌کننده / حسابدار</div>
          <div class="acc-sig-sub">${escapeHtml(options.preparedBy || profile.displayName || 'واحد حسابداری')}</div>
        </div>
        <div class="acc-sig-box">
          <div class="acc-sig-role">رئیس حسابداری / مدیر مالی</div>
          <div class="acc-sig-sub">بررسی و تایید تطابق دفاتر</div>
        </div>
        <div class="acc-sig-box">
          <div class="acc-sig-role">مدیرعامل / مهر رسمی شرکت</div>
          <div class="acc-sig-sub">${escapeHtml(profile.companyName)}</div>
        </div>
      </div>`
    : '';

  return `<div class="acc-sheet">
    <div class="acc-letterhead">
      <div class="acc-letterhead-top">
        <div>
          <h1 class="acc-company-name">${escapeHtml(profile.companyName)}</h1>
          ${
            companyMetaParts.length > 0
              ? `<p class="acc-company-meta">${escapeHtml(companyMetaParts.join('  |  '))}</p>`
              : `<p class="acc-company-meta">گزارش رسمی مالی و دفاتر قانونی</p>`
          }
        </div>
        <div class="acc-report-title-wrap">
          <h2 class="acc-report-title">${escapeHtml(spec.title)}</h2>
          ${subtitleText ? `<p class="acc-report-subtitle">${escapeHtml(subtitleText)}</p>` : ''}
        </div>
        <div class="acc-stamp-box">
          <div>تاریخ تهیه: <strong>${printDate}</strong></div>
          <div>سال مالی: <strong>${escapeHtml(toPersianDigits(profile.fiscalYear))}</strong></div>
          <div>ستون‌ها: <strong>${escapeHtml(toPersianDigits(visibleColumns.length))} از ${escapeHtml(toPersianDigits(spec.columns.length))}</strong></div>
        </div>
      </div>
      <div class="acc-meta-strip">
        <div class="acc-meta-item">دوره / بازه: <strong>${escapeHtml(spec.periodLabel)}</strong></div>
        <div class="acc-meta-item">دامنه اسناد: <strong>${escapeHtml(spec.voucherScopeLabel)}</strong></div>
        <div class="acc-meta-item">واحد پول: <strong>${escapeHtml(currencyLabel)}</strong></div>
        <div class="acc-meta-item">تعداد ردیف: <strong>${escapeHtml(toPersianDigits(spec.rows.length))}</strong></div>
      </div>
    </div>

    ${kpiHtml}

    <table class="acc-table">
      <thead>
        <tr>${theadCells}</tr>
      </thead>
      <tbody>
        ${tbodyRows}
      </tbody>
      ${tfootHtml}
    </table>

    ${notesHtml}
    ${signaturesHtml}

    <div class="acc-footer-bar">
      <span>تهیه‌شده با استایل استاندارد حسابداری و دفاتر قانونی — ${escapeHtml(profile.companyName)}</span>
      <span>صفحه‌بندی A4 (${options.orientation === 'landscape' ? 'افقی' : 'عمودی'}) · واحد مبالغ: ${escapeHtml(currencyLabel)}</span>
    </div>
  </div>`;
}

export function buildStandardAccountingReportHtml(
  spec: StandardAccountingReportSpec,
  visibleColumns: ReportColumnDef[],
  profile: CompanyProfile,
  options: AccountingReportPrintOptions
): string {
  const styles = getPrintDocumentStyles(options);
  const bodyHtml = buildStandardAccountingReportBodyHtml(spec, visibleColumns, profile, options);

  return `<!doctype html>
<html lang="fa" dir="rtl">
  <head>
    <meta charset="UTF-8" />
    <title>${escapeHtml(spec.title)} — ${escapeHtml(profile.companyName)}</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Vazirmatn:wght@400;500;600;700;800&display=swap"
      rel="stylesheet"
    />
    <style>${styles}</style>
  </head>
  <body>
    ${bodyHtml}
  </body>
</html>`;
}

/**
 * Prints the formatted standard accounting report via a hidden same-origin iframe.
 * Avoids window.open() so it works cleanly inside embedded iframes and PWAs.
 */
export async function printStandardAccountingReport(
  spec: StandardAccountingReportSpec,
  visibleColumns: ReportColumnDef[],
  profile: CompanyProfile,
  options: AccountingReportPrintOptions
): Promise<void> {
  const fullHtml = buildStandardAccountingReportHtml(spec, visibleColumns, profile, options);

  return new Promise<void>((resolve, reject) => {
    try {
      const iframe = document.createElement('iframe');
      iframe.setAttribute('aria-hidden', 'true');
      iframe.style.position = 'fixed';
      iframe.style.right = '0';
      iframe.style.bottom = '0';
      iframe.style.width = '0';
      iframe.style.height = '0';
      iframe.style.border = '0';
      iframe.style.visibility = 'hidden';

      document.body.appendChild(iframe);

      const doc = iframe.contentDocument || iframe.contentWindow?.document;
      if (!doc || !iframe.contentWindow) {
        document.body.removeChild(iframe);
        reject(new Error('امکان آماده‌سازی پنجره چاپ در مرورگر فراهم نشد.'));
        return;
      }

      doc.open();
      doc.write(fullHtml);
      doc.close();

      let cleanedUp = false;
      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        setTimeout(() => {
          if (iframe.parentNode) {
            iframe.parentNode.removeChild(iframe);
          }
          resolve();
        }, 400);
      };

      const triggerPrint = () => {
        try {
          iframe.contentWindow?.focus();
          iframe.contentWindow?.print();
        } finally {
          cleanup();
        }
      };

      const waitFontsAndPrint = () => {
        const fontSet = doc.fonts;
        if (fontSet && typeof fontSet.ready?.then === 'function') {
          Promise.race([
            fontSet.ready,
            new Promise((r) => setTimeout(r, 1200)),
          ]).then(() => setTimeout(triggerPrint, 120));
        } else {
          setTimeout(triggerPrint, 250);
        }
      };

      iframe.onload = waitFontsAndPrint;
      // Fallback if onload already fired synchronously after doc.close()
      setTimeout(() => {
        if (!cleanedUp && doc.readyState === 'complete') {
          waitFontsAndPrint();
        }
      }, 300);
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Generates and downloads a crisp multi-page A4 PDF file with native Persian RTL typography
 * using an isolated standard-hex accounting sheet rendered via html2canvas-pro + jsPDF.
 */
export async function exportStandardAccountingReportPdf(
  spec: StandardAccountingReportSpec,
  visibleColumns: ReportColumnDef[],
  profile: CompanyProfile,
  options: AccountingReportPrintOptions
): Promise<string> {
  const [{ jsPDF }, html2canvasModule] = await Promise.all([
    import('jspdf'),
    import('html2canvas-pro'),
  ]);
  const html2canvas = html2canvasModule.default;

  const isLandscape = options.orientation === 'landscape';
  // Standard A4 pixel widths at 96dpi (210mm = 794px, 297mm = 1123px)
  const renderWidthPx = isLandscape ? 1123 : 794;

  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.style.position = 'fixed';
  host.style.left = '-10000px';
  host.style.top = '0';
  host.style.width = `${renderWidthPx}px`;
  host.style.background = '#ffffff';
  host.style.zIndex = '-1';
  host.style.pointerEvents = 'none';

  const styleTag = document.createElement('style');
  styleTag.textContent = getPrintDocumentStyles(options);
  host.appendChild(styleTag);

  const contentWrap = document.createElement('div');
  contentWrap.innerHTML = buildStandardAccountingReportBodyHtml(
    spec,
    visibleColumns,
    profile,
    options
  );
  host.appendChild(contentWrap);
  document.body.appendChild(host);

  try {
    if (document.fonts && typeof document.fonts.ready?.then === 'function') {
      await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 1200))]);
    }

    const sheetEl = (contentWrap.firstElementChild as HTMLElement) || contentWrap;
    const canvas = await html2canvas(sheetEl, {
      scale: 2,
      useCORS: true,
      backgroundColor: '#ffffff',
      logging: false,
      windowWidth: renderWidthPx,
    });

    const pdf = new jsPDF({
      orientation: isLandscape ? 'landscape' : 'portrait',
      unit: 'mm',
      format: 'a4',
      compress: true,
    });

    const pageWidthMm = pdf.internal.pageSize.getWidth();
    const pageHeightMm = pdf.internal.pageSize.getHeight();
    const marginMm = 8;
    const usableWidthMm = pageWidthMm - marginMm * 2;
    const usableHeightMm = pageHeightMm - marginMm * 2;

    const pxPerMm = canvas.width / usableWidthMm;
    const sliceHeightPx = Math.floor(usableHeightMm * pxPerMm);
    const totalPages = Math.max(1, Math.ceil(canvas.height / sliceHeightPx));

    for (let pageIdx = 0; pageIdx < totalPages; pageIdx++) {
      if (pageIdx > 0) pdf.addPage();

      const srcY = pageIdx * sliceHeightPx;
      const srcH = Math.min(sliceHeightPx, canvas.height - srcY);
      const pageCanvas = document.createElement('canvas');
      pageCanvas.width = canvas.width;
      pageCanvas.height = srcH;
      const ctx = pageCanvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, pageCanvas.width, pageCanvas.height);
        ctx.drawImage(canvas, 0, srcY, canvas.width, srcH, 0, 0, canvas.width, srcH);
      }

      const imgData = pageCanvas.toDataURL('image/png', 0.96);
      const renderedHeightMm = srcH / pxPerMm;
      pdf.addImage(imgData, 'PNG', marginMm, marginMm, usableWidthMm, renderedHeightMm, undefined, 'FAST');

      // Subtle Latin/numeric page indicator at bottom margin
      pdf.setFontSize(8);
      pdf.setTextColor(100, 116, 139);
      pdf.text(
        `Page ${pageIdx + 1} / ${totalPages}`,
        pageWidthMm / 2,
        pageHeightMm - 3.5,
        { align: 'center' }
      );
    }

    const fileName = `${spec.fileNamePrefix}-${profile.fiscalYear}.pdf`;
    pdf.save(fileName);
    return fileName;
  } finally {
    if (host.parentNode) {
      host.parentNode.removeChild(host);
    }
  }
}
