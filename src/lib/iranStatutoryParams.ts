/**
 * Configurable Iranian Tax, VAT & Social Security (SSO) Statutory Parameters Engine.
 *
 * Design Rule (Stage 8 Compliance):
 * - Never hardcode tax exemptions, progressive brackets, VAT rates, insurance caps, or labor allowances
 *   without tying them to a specific Shamsi fiscal year and citing the statutory basis.
 * - Any statutory component whose official annual decree (e.g. Supreme Labor Council circular for a
 *   newly enacted year) must be confirmed by the company's accountant is explicitly flagged via
 *   `requiresUserVerification` and `verificationNote`, and every parameter can be overridden per year.
 */

import { IranFiscalYearStatutoryParams, IranTaxBracket } from '../types/accounting';

export const IRAN_STATUTORY_PRESETS: Record<string, IranFiscalYearStatutoryParams> = {
  '1404': {
    fiscalYear: '1404',
    sourceCitation:
      'قانون بودجه سال ۱۴۰۴ کل کشور (سقف معافیت ماهانه ۲۴۰ میلیون ریال و نرخ ۱۰٪ ارزش افزوده) + قانون تأمین اجتماعی (۳۰٪)',
    requiresUserVerification: true,
    verificationNote:
      'نرخ مالیات حقوق پلکانی و ارزش افزوده ۱۰٪ بر اساس قانون بودجه ۱۴۰۴ تنظیم شده است؛ سقف دستمزد مشمول بیمه و حق اولاد را مطابق بخشنامه نهایی شورای عالی کار ۱۴۰۴ کنترل یا ویرایش کنید.',
    vatRate: 0.1,
    monthlyTaxExemptionIrr: 240_000_000, // 24 میلیون تومان ماهانه (288 میلیون تومان سالانه)
    monthlyTaxBrackets: [
      { upToMonthlyIrr: 300_000_000, rate: 0.1 }, // مازاد ۲۴ تا ۳۰ میلیون تومان: ۱۰٪
      { upToMonthlyIrr: 380_000_000, rate: 0.15 }, // مازاد ۳۰ تا ۳۸ میلیون تومان: ۱۵٪
      { upToMonthlyIrr: 500_000_000, rate: 0.2 }, // مازاد ۳۸ تا ۵۰ میلیون تومان: ۲۰٪
      { upToMonthlyIrr: 666_666_667, rate: 0.25 }, // مازاد ۵۰ تا ۶۶.۶۷ میلیون تومان: ۲۵٪
      { upToMonthlyIrr: null, rate: 0.3 }, // مازاد ۶۶.۶۷ میلیون تومان: ۳۰٪
    ],
    employeeInsuranceRate: 0.07,
    employerInsuranceRate: 0.23, // 20% کارفرما + 3% بیمه بیکاری
    insurableWageCeilingIrr: 727_366_850, // برآورد ۷ برابر حداقل مزد ماهانه ۱۴۰۴ — قابل ویرایش مطابق بخشنامه رسمی تأمین اجتماعی
    childAllowancePerChildIrr: 10_390_968, // ۳ برابر حداقل مزد روزانه ۱۴۰۴ — قابل ویرایش مطابق مصوبه شورای عالی کار
    overtimeMultiplier: 1.4, // ماده ۵۹ قانون کار
    monthlyWorkingHoursBase: 220, // مبنای ساعات کار ماهانه قانون کار
  },
  '1405': {
    fiscalYear: '1405',
    sourceCitation:
      'قانون بودجه سال ۱۴۰۵ کل کشور (سقف معافیت ماهانه ۴۰۰ میلیون ریال، جدول ۵ پله‌ای ۱۰٪ تا ۳۰٪، ارزش افزوده ۱۰٪) + قانون تأمین اجتماعی',
    requiresUserVerification: true,
    verificationNote:
      'سقف معافیت حقوق (۴۰۰ میلیون ریال ماهانه)، پله‌های مالیاتی ۱۰٪ تا ۳۰٪ و ارزش افزوده ۱۰٪ مطابق قانون بودجه ۱۴۰۵ است. مبلغ دقیق سقف دستمزد مشمول بیمه و حق اولاد ۱۴۰۵ را مطابق بخشنامه رسمی شورای عالی کار و سازمان تأمین اجتماعی در تنظیمات سال مالی تأیید/به‌روزرسانی کنید.',
    vatRate: 0.1,
    monthlyTaxExemptionIrr: 400_000_000, // 40 میلیون تومان ماهانه (480 میلیون تومان سالانه)
    monthlyTaxBrackets: [
      { upToMonthlyIrr: 800_000_000, rate: 0.1 }, // مازاد ۴۰ تا ۸۰ میلیون تومان: ۱۰٪
      { upToMonthlyIrr: 1_000_000_000, rate: 0.15 }, // مازاد ۸۰ تا ۱۰۰ میلیون تومان: ۱۵٪
      { upToMonthlyIrr: 1_200_000_000, rate: 0.2 }, // مازاد ۱۰۰ تا ۱۲۰ میلیون تومان: ۲۰٪
      { upToMonthlyIrr: 1_400_000_000, rate: 0.25 }, // مازاد ۱۲۰ تا ۱۴۰ میلیون تومان: ۲۵٪
      { upToMonthlyIrr: null, rate: 0.3 }, // مازاد ۱۴۰ میلیون تومان: ۳۰٪
    ],
    employeeInsuranceRate: 0.07,
    employerInsuranceRate: 0.23, // 20% کارفرما + 3% بیمه بیکاری
    insurableWageCeilingIrr: 950_000_000, // مقدار پیش‌فرض قابل تنظیم — نیازمند تطبیق با بخشنامه رسمی دستمزد ۱۴۰۵
    childAllowancePerChildIrr: 14_000_000, // مقدار پیش‌فرض قابل تنظیم — نیازمند تطبیق با مصوبه شورای عالی کار ۱۴۰۵
    overtimeMultiplier: 1.4,
    monthlyWorkingHoursBase: 220,
  },
};

export function getStatutoryParamsForYear(
  fiscalYear: string,
  customOverrides?: Record<string, IranFiscalYearStatutoryParams>
): IranFiscalYearStatutoryParams {
  const cleanYear = String(fiscalYear || '1405').trim();
  const custom = customOverrides?.[cleanYear];
  if (custom) {
    return custom;
  }
  const preset = IRAN_STATUTORY_PRESETS[cleanYear];
  if (preset) {
    return preset;
  }
  // Unknown/future fiscal year: inherit latest preset structure and flag mandatory user review
  return {
    ...IRAN_STATUTORY_PRESETS['1405'],
    fiscalYear: cleanYear,
    sourceCitation: `سال مالی ${cleanYear} — برگرفته از ساختار بودجه ۱۴۰۵ (نیازمند ورود نرخ‌های رسمی سال ${cleanYear})`,
    verifiedByUser: false,
    requiresUserVerification: true,
    verificationNote: `پارامترهای رسمی سال مالی ${cleanYear} به‌صورت خودکار ثبت نشده است؛ لطفاً قبل از صدور سند حقوق یا مالیات، نرخ‌ها را مطابق قانون بودجه سال ${cleanYear} تنظیم کنید.`,
  };
}

export function validateStatutoryParams(params: IranFiscalYearStatutoryParams): string[] {
  const errors: string[] = [];
  if (!/^\d{4}$/.test(String(params.fiscalYear || '').trim())) {
    errors.push('سال مالی پارامترهای قانونی باید ۴ رقم شمسی معتبر (مثلاً ۱۴۰۵) باشد.');
  }
  if (!Number.isFinite(params.vatRate) || params.vatRate < 0 || params.vatRate > 0.5) {
    errors.push('نرخ مالیات بر ارزش افزوده باید عددی بین ۰ تا ۵۰ درصد باشد.');
  }
  if (!Number.isFinite(params.monthlyTaxExemptionIrr) || params.monthlyTaxExemptionIrr < 0) {
    errors.push('سقف معافیت مالیات حقوق نمی‌تواند منفی باشد.');
  }
  if (
    !Number.isFinite(params.employeeInsuranceRate) ||
    params.employeeInsuranceRate < 0 ||
    params.employeeInsuranceRate > 0.3
  ) {
    errors.push('نرخ بیمه سهم کارگر نامعتبر است.');
  }
  if (
    !Number.isFinite(params.employerInsuranceRate) ||
    params.employerInsuranceRate < 0 ||
    params.employerInsuranceRate > 0.5
  ) {
    errors.push('نرخ بیمه سهم کارفرما نامعتبر است.');
  }
  if (!Number.isFinite(params.insurableWageCeilingIrr) || params.insurableWageCeilingIrr <= 0) {
    errors.push('سقف دستمزد مشمول بیمه باید بزرگ‌تر از صفر باشد.');
  }
  if (!Number.isFinite(params.childAllowancePerChildIrr) || params.childAllowancePerChildIrr < 0) {
    errors.push('حق اولاد هر فرزند باید عددی معتبر و غیرمنفی باشد.');
  }
  if (!Number.isFinite(params.overtimeMultiplier) || params.overtimeMultiplier <= 0 || params.overtimeMultiplier > 5) {
    errors.push('ضریب اضافه‌کاری باید عددی بزرگ‌تر از صفر و حداکثر ۵ باشد.');
  }
  if (!Number.isFinite(params.monthlyWorkingHoursBase) || params.monthlyWorkingHoursBase <= 0 || params.monthlyWorkingHoursBase > 744) {
    errors.push('مبنای ساعات کار ماهانه باید عددی بزرگ‌تر از صفر و حداکثر ۷۴۴ ساعت باشد.');
  }
  if (!Array.isArray(params.monthlyTaxBrackets) || params.monthlyTaxBrackets.length === 0) {
    errors.push('حداقل یک پله مالیاتی باید تعریف شده باشد.');
  } else {
    let prevBound = params.monthlyTaxExemptionIrr;
    for (let i = 0; i < params.monthlyTaxBrackets.length; i++) {
      const b = params.monthlyTaxBrackets[i];
      if (!Number.isFinite(b.rate) || b.rate < 0 || b.rate > 0.6) {
        errors.push(`نرخ پله مالیاتی ردیف ${i + 1} نامعتبر است.`);
      }
      if (b.upToMonthlyIrr === null) {
        if (i !== params.monthlyTaxBrackets.length - 1) {
          errors.push('پله مالیاتی بدون سقف باید آخرین پله باشد.');
        }
      } else {
        if (!Number.isFinite(b.upToMonthlyIrr) || b.upToMonthlyIrr <= prevBound) {
          errors.push(`سقف پله مالیاتی ردیف ${i + 1} باید اکیداً بزرگ‌تر از پله قبلی باشد.`);
        }
        prevBound = b.upToMonthlyIrr;
      }
    }
    if (params.monthlyTaxBrackets[params.monthlyTaxBrackets.length - 1].upToMonthlyIrr !== null) {
      errors.push('آخرین پله مالیاتی باید سقف نامحدود داشته باشد تا درآمد بالاتر از آخرین سقف بدون مالیات نماند.');
    }
  }
  return errors;
}

/**
 * Exact progressive Iranian monthly salary income tax calculation in integer Rials (IRR).
 * `grossTaxableIncomeIrr` is the monthly income subject to payroll tax (e.g., grossPay - statutory exemptions if applicable).
 */
export function calculateIranMonthlyPayrollTax(
  grossTaxableIncomeIrr: number,
  exemptionIrr: number,
  brackets: IranTaxBracket[]
): number {
  const income = Math.max(0, Math.round(Number(grossTaxableIncomeIrr) || 0));
  const exempt = Math.max(0, Math.round(Number(exemptionIrr) || 0));
  if (income <= exempt) return 0;

  let taxIrr = 0;
  let lowerBound = exempt;

  for (const bracket of brackets) {
    if (income <= lowerBound) break;
    const upperBound =
      bracket.upToMonthlyIrr === null ? income : Math.min(income, Math.round(bracket.upToMonthlyIrr));
    if (upperBound > lowerBound) {
      const slice = upperBound - lowerBound;
      taxIrr += Math.round(slice * bracket.rate);
      lowerBound = upperBound;
    }
  }

  return Math.max(0, Math.round(taxIrr));
}
