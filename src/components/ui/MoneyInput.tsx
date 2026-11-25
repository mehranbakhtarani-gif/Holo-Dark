import React, { useEffect, useRef, useState } from 'react';
import {
  formatGroupedNumberInput,
  normalizeDigitsToAscii,
  parseGroupedNumberInput,
} from '../../lib/format';

export interface MoneyInputProps {
  /** Controlled numeric or string value. When 0 or '', displays empty so placeholder is visible. */
  value: number | string;
  /** Emits the clean numeric value and clean ungrouped canonical string ('' when cleared). */
  onValueChange: (numericValue: number, rawCleanString: string) => void;
  /** Faded Persian activity placeholder (disappears immediately when focused). */
  placeholder?: string;
  /** Inline unit badge displayed alongside the number (e.g. "ریال", "کیلوگرم", "کارتن", "%"). */
  unitLabel?: string;
  /** Optional concise field guidance shown neatly below the input. */
  hint?: string;
  /** Allow decimals (e.g. weights in kg or percentages). Defaults to false (integer IRR). */
  allowDecimal?: boolean;
  /** Allow negative numbers. Defaults to false. */
  allowNegative?: boolean;
  /** Keep "0" visible instead of empty placeholder. Defaults to false. */
  showZero?: boolean;
  /** Outer wrapper className */
  wrapperClassName?: string;
  /** Input element className */
  className?: string;
  disabled?: boolean;
  readOnly?: boolean;
  required?: boolean;
  autoFocus?: boolean;
  id?: string;
  name?: string;
  'aria-label'?: string;
  onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>;
  onBlur?: React.FocusEventHandler<HTMLInputElement>;
  onFocus?: React.FocusEventHandler<HTMLInputElement>;
  inputRef?: React.RefObject<HTMLInputElement | null>;
}

/**
 * Reusable 3-digit thousand-separated numeric/IRR input for Holoo Sherkati Apex.
 * - Keeps empty state clean so faded Persian placeholders appear and vanish on focus.
 * - Accepts Persian (۰-۹), Arabic (٠-٩), and ASCII (0-9) digits seamlessly.
 * - Formats live with 3-digit separators (e.g. 25,000,000) and displays an inline unit tag (ریال / کیلوگرم / کارتن).
 */
export const MoneyInput: React.FC<MoneyInputProps> = ({
  value,
  onValueChange,
  placeholder,
  unitLabel,
  hint,
  allowDecimal = false,
  allowNegative = false,
  showZero = false,
  wrapperClassName = '',
  className = '',
  disabled = false,
  readOnly = false,
  required = false,
  autoFocus = false,
  id,
  name,
  'aria-label': ariaLabel,
  onKeyDown,
  onBlur,
  onFocus,
  inputRef: externalRef,
}) => {
  const internalRef = useRef<HTMLInputElement | null>(null);
  const inputRef = externalRef ?? internalRef;
  const [draftText, setDraftText] = useState<string>(() =>
    formatGroupedNumberInput(value, allowDecimal, showZero)
  );
  const isFocusedRef = useRef(false);

  // Sync external value changes when not mid-typing a trailing decimal dot (e.g. "12.")
  useEffect(() => {
    const formattedExternal = formatGroupedNumberInput(value, allowDecimal, showZero);
    if (!isFocusedRef.current) {
      setDraftText(formattedExternal);
      return;
    }
    const currentParsed = parseGroupedNumberInput(draftText, allowDecimal);
    const externalParsed =
      typeof value === 'number'
        ? value
        : parseGroupedNumberInput(String(value ?? ''), allowDecimal);
    // Only overwrite while focused if external value diverged meaningfully (e.g. reset / auto-fill button)
    if (Math.abs(currentParsed - externalParsed) > 1e-9 || (value === '' && draftText !== '')) {
      setDraftText(formattedExternal);
    }
  }, [value, allowDecimal, showZero]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    const normalized = normalizeDigitsToAscii(raw).replace(/[,٬،\s]/g, '');

    if (!normalized) {
      setDraftText('');
      onValueChange(0, '');
      return;
    }

    const isNeg = allowNegative && normalized.startsWith('-');
    const unsigned = normalized.startsWith('-') ? normalized.slice(1) : normalized;
    const cleaned = allowDecimal
      ? unsigned.replace(/[^0-9.]/g, '')
      : unsigned.replace(/[^0-9]/g, '');

    if (!cleaned) {
      setDraftText(isNeg ? '-' : '');
      onValueChange(0, '');
      return;
    }

    // Keep single decimal dot if allowDecimal
    let intPart = cleaned;
    let decPart: string | null = null;
    if (allowDecimal) {
      const dotIdx = cleaned.indexOf('.');
      if (dotIdx >= 0) {
        intPart = cleaned.slice(0, dotIdx);
        decPart = cleaned.slice(dotIdx + 1).replace(/\./g, '');
      }
    }

    const cleanInt = intPart.replace(/^0+(?=\d)/, '');
    const groupedInt = (cleanInt || (decPart !== null ? '0' : '0')).replace(
      /\B(?=(\d{3})+(?!\d))/g,
      ','
    );
    const formatted =
      decPart !== null ? `${isNeg ? '-' : ''}${groupedInt}.${decPart}` : `${isNeg ? '-' : ''}${groupedInt}`;
    const canonical =
      decPart !== null ? `${isNeg ? '-' : ''}${cleanInt || '0'}.${decPart}` : `${isNeg ? '-' : ''}${cleanInt || '0'}`;

    const numeric = parseGroupedNumberInput(canonical, allowDecimal);
    setDraftText(formatted);
    onValueChange(numeric, canonical);
  };

  const handleFocus = (e: React.FocusEvent<HTMLInputElement>) => {
    isFocusedRef.current = true;
    onFocus?.(e);
  };

  const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    isFocusedRef.current = false;
    setDraftText(formatGroupedNumberInput(value, allowDecimal, showZero));
    onBlur?.(e);
  };

  const hasUnit = Boolean(unitLabel);

  return (
    <div className={`w-full ${wrapperClassName}`}>
      <div className="relative flex items-center">
        <input
          ref={inputRef}
          id={id}
          name={name}
          type="text"
          inputMode={allowDecimal ? 'decimal' : 'numeric'}
          autoComplete="off"
          dir="ltr"
          value={draftText}
          onChange={handleChange}
          onFocus={handleFocus}
          onBlur={handleBlur}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          readOnly={readOnly}
          required={required}
          autoFocus={autoFocus}
          aria-label={ariaLabel}
          className={`w-full font-code tabular-nums text-right ${
            hasUnit ? 'pl-14 pr-2.5' : 'px-2.5'
          } ${className}`}
        />
        {hasUnit && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[10px] font-sans font-medium text-slate-400 dark:text-slate-500 select-none whitespace-nowrap"
          >
            {unitLabel}
          </span>
        )}
      </div>
      {hint && (
        <div className="mt-1 text-[10px] text-slate-400 dark:text-slate-500 leading-4">
          {hint}
        </div>
      )}
    </div>
  );
};
