import React, { useEffect, useMemo, useState } from 'react';
import {
  Banknote,
  Building2,
  CheckCircle2,
  Edit3,
  FileText,
  Lock,
  Plus,
  Printer,
  Trash2,
  Users,
  Wrench,
  X,
} from 'lucide-react';
import { useAccounting } from '../context/AccountingContext';
import {
  calculateEmployeePayroll,
  calculateMonthlyDepreciation,
  computeCostCenterPnL,
} from '../lib/accountingEngine';
import { getStatutoryParamsForYear, validateStatutoryParams } from '../lib/iranStatutoryParams';
import { CostCenter, Employee, FixedAsset, IranFiscalYearStatutoryParams } from '../types/accounting';
import { formatMoney, toPersianDigits } from '../lib/format';
import { MoneyInput } from './ui/MoneyInput';

interface CorporateViewProps {
  initialIntent?: string;
  clearIntent?: () => void;
}

export const CorporateView: React.FC<CorporateViewProps> = ({ initialIntent, clearIntent }) => {
  const {
    employees,
    assets,
    costCenters,
    accounts,
    vouchers,
    incomeStatement,
    profile,
    addEmployee,
    updateEmployee,
    deleteEmployee,
    postMonthlyPayrollVoucher,
    paySalariesVoucher,
    addFixedAsset,
    updateFixedAsset,
    deleteFixedAsset,
    postDepreciationVoucher,
    addCostCenter,
    updateCostCenter,
    deleteCostCenter,
    runYearEndClosing,
    updateCompanyProfile,
    showToast,
  } = useAccounting();
  const unit = profile.currencyUnit;

  const [tab, setTab] = useState<'payroll' | 'assets' | 'costcenters' | 'closing'>('payroll');
  const [payrollMonth, setPayrollMonth] = useState('آبان ۱۴۰۵');
  const [depPeriod, setDepPeriod] = useState('آبان ۱۴۰۵');

  // Bank accounts for salary payment
  const bankAccounts = useMemo(
    () =>
      accounts
        .filter((a) => a.level === 'moein' && a.code.startsWith('102'))
        .sort((a, b) => a.code.localeCompare(b.code)),
    [accounts]
  );
  const [payBankCode, setPayBankCode] = useState(bankAccounts[0]?.code ?? '10201');
  const [showPaySalaryModal, setShowPaySalaryModal] = useState(false);

  // Payslip print modal
  const [payslipEmployeeId, setPayslipEmployeeId] = useState<string | null>(null);

  // New employee form (no pre-filled defaults)
  const [empName, setEmpName] = useState('');
  const [empDept, setEmpDept] = useState('');
  const [empBase, setEmpBase] = useState(0);
  const [empCostCenter, setEmpCostCenter] = useState(costCenters[0]?.id ?? '');

  // Edit employee modal
  const [editingEmp, setEditingEmp] = useState<Employee | null>(null);

  // New asset form (no pre-filled defaults)
  const [assetTitle, setAssetTitle] = useState('');
  const [assetCost, setAssetCost] = useState(0);
  const [assetLife, setAssetLife] = useState(0);

  // Edit asset modal
  const [editingAsset, setEditingAsset] = useState<FixedAsset | null>(null);

  // New cost center form (no pre-filled defaults)
  const [ccName, setCcName] = useState('');
  const [ccBudget, setCcBudget] = useState(0);

  // Edit cost center modal
  const [editingCC, setEditingCC] = useState<CostCenter | null>(null);

  useEffect(() => {
    if (!initialIntent) return;
    if (
      initialIntent === 'payroll' ||
      initialIntent === 'assets' ||
      initialIntent === 'costcenters' ||
      initialIntent === 'closing'
    ) {
      setTab(initialIntent);
    }
    clearIntent?.();
  }, [initialIntent, clearIntent]);

  const activeStatutory = useMemo(
    () => getStatutoryParamsForYear(profile.fiscalYear, profile.statutoryParamsByYear),
    [profile.fiscalYear, profile.statutoryParamsByYear]
  );
  const [showStatutoryEditor, setShowStatutoryEditor] = useState(false);
  const [statutoryDraft, setStatutoryDraft] = useState<IranFiscalYearStatutoryParams>(activeStatutory);

  useEffect(() => {
    setStatutoryDraft(activeStatutory);
  }, [activeStatutory]);

  const payrollCalcs = useMemo(
    () =>
      employees
        .filter((e) => e.active)
        .map((emp) =>
          calculateEmployeePayroll(emp, profile.fiscalYear, profile.statutoryParamsByYear)
        ),
    [employees, profile.fiscalYear, profile.statutoryParamsByYear]
  );

  const payrollStatutoryErrors = useMemo(() => {
    const errors = validateStatutoryParams(activeStatutory);
    if (activeStatutory.requiresUserVerification && !activeStatutory.verifiedByUser) {
      errors.unshift(
        activeStatutory.verificationNote || 'پارامترهای قانونی این سال مالی هنوز تأیید نشده‌اند.'
      );
    }
    return errors;
  }, [activeStatutory]);

  const payrollTotals = useMemo(
    () => ({
      gross: payrollCalcs.reduce((s, c) => s + c.grossPay, 0),
      empIns: payrollCalcs.reduce((s, c) => s + c.employeeInsurance, 0),
      erIns: payrollCalcs.reduce((s, c) => s + c.employerInsurance, 0),
      tax: payrollCalcs.reduce((s, c) => s + c.incomeTax, 0),
      net: payrollCalcs.reduce((s, c) => s + c.netPay, 0),
    }),
    [payrollCalcs]
  );

  const costCenterPnLs = useMemo(
    () => computeCostCenterPnL(costCenters, vouchers),
    [costCenters, vouchers]
  );

  const selectedPayslip = useMemo(
    () => payrollCalcs.find((p) => p.employee.id === payslipEmployeeId) ?? null,
    [payrollCalcs, payslipEmployeeId]
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 no-print">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-white">
            ماژول‌های شرکتی هلو Apex (F8)
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            حقوق و دستمزد (فیش حقوقی، بیمه ۳۰٪ و پرداخت بانکی)، اموال و استهلاک، سود و زیان مراکز هزینه و بستن حساب پایان سال
          </p>
        </div>

        <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-800 overflow-x-auto">
          {[
            { id: 'payroll', label: 'حقوق و دستمزد' },
            { id: 'assets', label: 'اموال و استهلاک' },
            { id: 'costcenters', label: 'مراکز هزینه و پروژه‌ها' },
            { id: 'closing', label: 'عملیات پایان سال' },
          ].map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id as typeof tab)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap ${
                tab === t.id
                  ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-sm'
                  : 'text-slate-600 dark:text-slate-400'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Payroll Tab */}
      {tab === 'payroll' && (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 no-print">
            <div className="flex flex-wrap items-center gap-3 text-xs">
              <Users className="w-4 h-4 text-teal-700 dark:text-teal-400" />
              <span className="font-semibold text-slate-900 dark:text-white">
                دوره لیست حقوق ماهانه:
              </span>
              <input
                value={payrollMonth}
                onChange={(e) => setPayrollMonth(e.target.value)}
                className="w-36 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => postMonthlyPayrollVoucher(payrollMonth)}
                disabled={payrollStatutoryErrors.length > 0}
                title={payrollStatutoryErrors[0] || 'صدور سند حقوق'}
                className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-lg whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <CheckCircle2 className="w-4 h-4" />
                <span>صدور سند حقوق {payrollMonth}</span>
              </button>
              <button
                onClick={() => setShowStatutoryEditor((v) => !v)}
                className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-lg whitespace-nowrap"
              >
                <Wrench className="w-3.5 h-3.5" />
                <span>تنظیم پارامترهای قانونی سال {toPersianDigits(profile.fiscalYear)}</span>
              </button>
              <button
                onClick={() => setShowPaySalaryModal(true)}
                className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold border border-teal-700 text-teal-700 dark:text-teal-400 hover:bg-teal-50 dark:hover:bg-teal-950/40 rounded-lg whitespace-nowrap"
              >
                <Banknote className="w-4 h-4" />
                <span>پرداخت حقوق از بانک</span>
              </button>
            </div>
          </div>

          {payrollStatutoryErrors.length > 0 && (
            <div role="alert" className="rounded-xl border border-rose-300 bg-rose-50 dark:bg-rose-950/30 p-3 text-xs text-rose-800 dark:text-rose-200">
              صدور سند حقوق تا رفع خطای پارامترهای قانونی متوقف است: {payrollStatutoryErrors[0]}
            </div>
          )}
          <div className="bg-amber-50/70 dark:bg-amber-950/20 border border-amber-200/80 dark:border-amber-900/60 rounded-xl p-3.5 text-xs space-y-1.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-semibold text-slate-800 dark:text-slate-100">
                مبنای قانونی فعال ({toPersianDigits(activeStatutory.fiscalYear)}): {activeStatutory.sourceCitation}
              </span>
              <span className="font-code text-[11px] text-amber-800 dark:text-amber-300">
                معافیت ماهانه: {formatMoney(activeStatutory.monthlyTaxExemptionIrr, unit)} · سقف بیمه: {formatMoney(activeStatutory.insurableWageCeilingIrr, unit)}
              </span>
            </div>
            {activeStatutory.requiresUserVerification && !activeStatutory.verifiedByUser && activeStatutory.verificationNote && (
              <p className="text-[11px] text-amber-800 dark:text-amber-300">
                {activeStatutory.verificationNote}
              </p>
            )}
          </div>

          {showStatutoryEditor && (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const errs = validateStatutoryParams(statutoryDraft);
                if (errs.length > 0) {
                  showToast(errs[0], 'error');
                  return;
                }
                const nextMap = {
                  ...(profile.statutoryParamsByYear || {}),
                  [statutoryDraft.fiscalYear]: {
                    ...statutoryDraft,
                    verifiedByUser: true,
                    requiresUserVerification: false,
                  },
                };
                await updateCompanyProfile({ statutoryParamsByYear: nextMap });
                setShowStatutoryEditor(false);
              }}
              className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 space-y-3 text-xs no-print"
            >
              <div className="flex items-center justify-between">
                <h3 className="font-bold text-slate-900 dark:text-white">
                  ویرایش پارامترهای مالیات حقوق، بیمه و ارزش افزوده سال {toPersianDigits(statutoryDraft.fiscalYear)}
                </h3>
                <button
                  type="button"
                  onClick={() => setShowStatutoryEditor(false)}
                  className="p-1 text-slate-400 hover:text-slate-600"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                <div className="space-y-1">
                  <label className="block text-slate-500">سقف معافیت مالیات حقوق ماهانه</label>
                  <MoneyInput
                    value={statutoryDraft.monthlyTaxExemptionIrr}
                    onValueChange={(n) =>
                      setStatutoryDraft((s) => ({
                        ...s,
                        monthlyTaxExemptionIrr: Math.max(0, Math.round(n)),
                      }))
                    }
                    placeholder="سقف معافیت ماهانه به ریال"
                    unitLabel="ریال"
                    className="py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                  />
                </div>
                <div className="space-y-1">
                  <label className="block text-slate-500">سقف دستمزد مشمول بیمه ماهانه</label>
                  <MoneyInput
                    value={statutoryDraft.insurableWageCeilingIrr}
                    onValueChange={(n) =>
                      setStatutoryDraft((s) => ({
                        ...s,
                        insurableWageCeilingIrr: Math.max(1, Math.round(n)),
                      }))
                    }
                    placeholder="سقف دستمزد بیمه به ریال"
                    unitLabel="ریال"
                    className="py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                  />
                </div>
                <div className="space-y-1">
                  <label className="block text-slate-500">حق اولاد ماهانه هر فرزند</label>
                  <MoneyInput
                    value={statutoryDraft.childAllowancePerChildIrr}
                    onValueChange={(n) =>
                      setStatutoryDraft((s) => ({
                        ...s,
                        childAllowancePerChildIrr: Math.max(0, Math.round(n)),
                      }))
                    }
                    placeholder="مبلغ حق اولاد به ریال"
                    unitLabel="ریال"
                    className="py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                  />
                </div>
                <div className="space-y-1">
                  <label className="block text-slate-500">نرخ ارزش افزوده</label>
                  <MoneyInput
                    allowDecimal
                    value={Number((statutoryDraft.vatRate * 100).toFixed(2))}
                    onValueChange={(n) =>
                      setStatutoryDraft((s) => ({
                        ...s,
                        vatRate: Math.max(0, Math.min(0.5, n / 100)),
                      }))
                    }
                    placeholder="درصد مالیات ارزش افزوده"
                    unitLabel="٪"
                    className="py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                  />
                </div>
                <div className="space-y-1">
                  <label className="block text-slate-500">نرخ بیمه سهم کارگر</label>
                  <MoneyInput
                    allowDecimal
                    value={Number((statutoryDraft.employeeInsuranceRate * 100).toFixed(2))}
                    onValueChange={(n) =>
                      setStatutoryDraft((s) => ({
                        ...s,
                        employeeInsuranceRate: Math.max(0, Math.min(0.3, n / 100)),
                      }))
                    }
                    placeholder="درصد سهم کارگر"
                    unitLabel="٪"
                    className="py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                  />
                </div>
                <div className="space-y-1">
                  <label className="block text-slate-500">نرخ بیمه سهم کارفرما</label>
                  <MoneyInput
                    allowDecimal
                    value={Number((statutoryDraft.employerInsuranceRate * 100).toFixed(2))}
                    onValueChange={(n) =>
                      setStatutoryDraft((s) => ({
                        ...s,
                        employerInsuranceRate: Math.max(0, Math.min(0.5, n / 100)),
                      }))
                    }
                    placeholder="درصد سهم کارفرما"
                    unitLabel="٪"
                    className="py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                  />
                </div>
              </div>
              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="submit"
                  className="px-4 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-lg"
                >
                  تأیید و ذخیره پارامترهای سال {toPersianDigits(statutoryDraft.fiscalYear)}
                </button>
              </div>
            </form>
          )}

          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-right text-xs border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/60 text-slate-500">
                    <th className="py-3 px-4">کد پرسنلی</th>
                    <th className="py-3 px-4">نام و واحد</th>
                    <th className="py-3 px-4 text-left">ناخالص حقوق و مزایا</th>
                    <th className="py-3 px-4 text-left">بیمه کارمند (۷٪)</th>
                    <th className="py-3 px-4 text-left">بیمه کارفرما (۲۳٪)</th>
                    <th className="py-3 px-4 text-left">مالیات حقوق</th>
                    <th className="py-3 px-4 text-left">خالص پرداختی</th>
                    <th className="py-3 px-4 text-center no-print">عملیات</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {payrollCalcs.map((c) => (
                    <tr key={c.employee.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                      <td className="py-3 px-4 font-code font-semibold text-teal-800 dark:text-teal-400">
                        {c.employee.personnelCode}
                      </td>
                      <td className="py-3 px-4">
                        <div className="font-semibold text-slate-900 dark:text-white">
                          {c.employee.fullName}
                        </div>
                        <div className="text-[11px] text-slate-500">
                          {c.employee.department}
                          {c.employee.overtimeHours > 0
                            ? ` · اضافه‌کار ${toPersianDigits(c.employee.overtimeHours)} ساعت`
                            : ''}
                        </div>
                      </td>
                      <td className="py-3 px-4 text-left font-code tabular-nums">
                        {formatMoney(c.grossPay, unit, false)}
                      </td>
                      <td className="py-3 px-4 text-left font-code tabular-nums text-amber-700 dark:text-amber-400">
                        {formatMoney(c.employeeInsurance, unit, false)}
                      </td>
                      <td className="py-3 px-4 text-left font-code tabular-nums text-slate-600 dark:text-slate-300">
                        {formatMoney(c.employerInsurance, unit, false)}
                      </td>
                      <td className="py-3 px-4 text-left font-code tabular-nums text-rose-700 dark:text-rose-400">
                        {formatMoney(c.incomeTax, unit, false)}
                      </td>
                      <td className="py-3 px-4 text-left font-code tabular-nums font-bold text-emerald-700 dark:text-emerald-400">
                        {formatMoney(c.netPay, unit, false)}
                      </td>
                      <td className="py-3 px-4 text-center no-print">
                        <div className="inline-flex items-center gap-1">
                          <button
                            onClick={() => setPayslipEmployeeId(c.employee.id)}
                            title="مشاهده و چاپ فیش حقوقی"
                            className="p-1.5 rounded-lg text-slate-500 hover:text-teal-700 hover:bg-slate-100 dark:hover:bg-slate-800"
                          >
                            <FileText className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => setEditingEmp({ ...c.employee })}
                            title="ویرایش مشخصات و حقوق پرسنل"
                            className="p-1.5 rounded-lg text-slate-500 hover:text-teal-700 hover:bg-slate-100 dark:hover:bg-slate-800"
                          >
                            <Edit3 className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => deleteEmployee(c.employee.id)}
                            title="حذف پرسنل"
                            className="p-1.5 rounded-lg text-slate-500 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 font-bold">
                    <td colSpan={2} className="py-3 px-4">
                      جمع کل لیست حقوق ({toPersianDigits(payrollCalcs.length)} نفر)
                    </td>
                    <td className="py-3 px-4 text-left font-code tabular-nums">
                      {formatMoney(payrollTotals.gross, unit, false)}
                    </td>
                    <td className="py-3 px-4 text-left font-code tabular-nums">
                      {formatMoney(payrollTotals.empIns, unit, false)}
                    </td>
                    <td className="py-3 px-4 text-left font-code tabular-nums">
                      {formatMoney(payrollTotals.erIns, unit, false)}
                    </td>
                    <td className="py-3 px-4 text-left font-code tabular-nums">
                      {formatMoney(payrollTotals.tax, unit, false)}
                    </td>
                    <td className="py-3 px-4 text-left font-code tabular-nums text-emerald-700 dark:text-emerald-400">
                      {formatMoney(payrollTotals.net, unit, false)}
                    </td>
                    <td className="no-print" />
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (!empName.trim()) return;
              await addEmployee({
                personnelCode: `P-${101 + employees.length}`,
                fullName: empName.trim(),
                department: empDept,
                baseSalary: empBase,
                housingAllowance: 45_000_000,
                foodAllowance: 35_000_000,
                childrenCount: 0,
                overtimeHours: 0,
                costCenterId: empCostCenter || costCenters[0]?.id,
                active: true,
              });
              setEmpName('');
            }}
            className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 flex flex-wrap items-end gap-3 text-xs no-print"
          >
            <div className="flex-1 min-w-[180px]">
              <label className="block text-slate-500 mb-1">افزودن پرسنل جدید</label>
              <input
                value={empName}
                onChange={(e) => setEmpName(e.target.value)}
                placeholder="ورود نام و نام خانوادگی پرسنل"
                className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>
            <div className="w-44">
              <label className="block text-slate-500 mb-1">دپارتمان / واحد</label>
              <input
                value={empDept}
                onChange={(e) => setEmpDept(e.target.value)}
                placeholder="نام واحد سازمانی"
                className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>
            <div className="w-48">
              <label className="block text-slate-500 mb-1">حقوق پایه ماهانه</label>
              <MoneyInput
                value={empBase}
                onValueChange={(n) => setEmpBase(n)}
                placeholder="مبلغ حقوق پایه به ریال"
                unitLabel="ریال"
                className="py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>
            <div className="w-44">
              <label className="block text-slate-500 mb-1">مرکز هزینه</label>
              <select
                value={empCostCenter}
                onChange={(e) => setEmpCostCenter(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
              >
                {costCenters.map((cc) => (
                  <option key={cc.id} value={cc.id}>
                    {cc.name}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="submit"
              className="inline-flex items-center gap-1.5 px-4 py-2 font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-lg"
            >
              <Plus className="w-4 h-4" />
              <span>افزودن پرسنل</span>
            </button>
          </form>
        </div>
      )}

      {/* Fixed Assets Tab */}
      {tab === 'assets' && (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
            <div className="flex items-center gap-3 text-xs">
              <Wrench className="w-4 h-4 text-teal-700 dark:text-teal-400" />
              <span className="font-semibold text-slate-900 dark:text-white">
                محاسبه استهلاک خط مستقیم دوره:
              </span>
              <input
                value={depPeriod}
                onChange={(e) => setDepPeriod(e.target.value)}
                className="w-36 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
              />
            </div>
            <button
              onClick={() => postDepreciationVoucher(depPeriod)}
              className="px-4 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-lg"
            >
              صدور سند استهلاک ماهانه
            </button>
          </div>

          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-right text-xs border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/60 text-slate-500">
                    <th className="py-3 px-4">پلاک اموال</th>
                    <th className="py-3 px-4">شرح دارایی</th>
                    <th className="py-3 px-4 text-left">بهای تمام‌شده</th>
                    <th className="py-3 px-4 text-left">عمر مفید</th>
                    <th className="py-3 px-4 text-left">استهلاک انباشته</th>
                    <th className="py-3 px-4 text-left">استهلاک ماهانه</th>
                    <th className="py-3 px-4 text-left">ارزش دفتری</th>
                    <th className="py-3 px-4 text-center">عملیات</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {assets.map((a) => {
                    const monthly = calculateMonthlyDepreciation(a);
                    const bookVal = Math.max(0, a.purchaseCost - a.accumulatedDepreciation);
                    return (
                      <tr key={a.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                        <td className="py-3 px-4 font-code font-semibold text-teal-800 dark:text-teal-400">
                          {a.assetCode}
                        </td>
                        <td className="py-3 px-4">
                          <div className="font-medium text-slate-900 dark:text-white">{a.title}</div>
                          <div className="text-[11px] text-slate-500 font-code">
                            خرید: {toPersianDigits(a.purchaseDate)}
                          </div>
                        </td>
                        <td className="py-3 px-4 text-left font-code tabular-nums">
                          {formatMoney(a.purchaseCost, unit, false)}
                        </td>
                        <td className="py-3 px-4 text-left font-code">
                          {toPersianDigits(a.usefulLifeYears)} سال
                        </td>
                        <td className="py-3 px-4 text-left font-code tabular-nums text-amber-700 dark:text-amber-400">
                          {formatMoney(a.accumulatedDepreciation, unit, false)}
                        </td>
                        <td className="py-3 px-4 text-left font-code tabular-nums">
                          {formatMoney(monthly, unit, false)}
                        </td>
                        <td className="py-3 px-4 text-left font-code tabular-nums font-bold text-slate-900 dark:text-white">
                          {formatMoney(bookVal, unit, false)}
                        </td>
                        <td className="py-3 px-4 text-center">
                          <div className="inline-flex items-center gap-1">
                            <button
                              onClick={() => setEditingAsset({ ...a })}
                              title="ویرایش دارایی ثابت"
                              className="p-1.5 rounded-lg text-slate-500 hover:text-teal-700 hover:bg-slate-100 dark:hover:bg-slate-800"
                            >
                              <Edit3 className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => deleteFixedAsset(a.id)}
                              title="حذف دارایی"
                              className="p-1.5 rounded-lg text-slate-500 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (!assetTitle.trim() || assetCost <= 0 || assetLife < 1) {
                showToast('لطفاً شرح دارایی، بهای خرید معتبر و عمر مفید حداقل ۱ سال را وارد کنید.');
                return;
              }
              await addFixedAsset({
                assetCode: `FA-${profile.fiscalYear}-0${assets.length + 1}`,
                title: assetTitle.trim(),
                purchaseDate: `${profile.fiscalYear}/08/01`,
                purchaseCost: assetCost,
                salvageValue: Math.round(assetCost * 0.1),
                usefulLifeYears: assetLife,
                accumulatedDepreciation: 0,
                costCenterId: costCenters[0]?.id,
              });
              setAssetTitle('');
              setAssetCost(0);
              setAssetLife(0);
            }}
            className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 flex flex-wrap items-end gap-3 text-xs"
          >
            <div className="flex-1 min-w-[200px]">
              <label className="block text-slate-500 mb-1">ثبت دارایی ثابت جدید</label>
              <input
                value={assetTitle}
                onChange={(e) => setAssetTitle(e.target.value)}
                placeholder="شرح دارایی، ماشین‌آلات یا تجهیزات"
                className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>
            <div className="w-52">
              <label className="block text-slate-500 mb-1">بهای خرید (ریال)</label>
              <MoneyInput
                value={assetCost}
                onValueChange={(n) => setAssetCost(n)}
                placeholder="ورود بهای تمام‌شده خرید"
                unitLabel="ریال"
                className="py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>
            <div className="w-32">
              <label className="block text-slate-500 mb-1">عمر مفید</label>
              <MoneyInput
                value={assetLife}
                onValueChange={(n) => setAssetLife(Math.max(0, Math.min(50, Math.round(n))))}
                placeholder="تعداد سال"
                unitLabel="سال"
                className="py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>
            <button
              type="submit"
              className="px-4 py-2 font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-lg"
            >
              ثبت اموال
            </button>
          </form>
        </div>
      )}

      {/* Cost Centers Tab */}
      {tab === 'costcenters' && (
        <div className="space-y-5">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {costCenterPnLs.map((row) => {
              const cc = row.costCenter;
              const pct = Math.min(100, row.budgetUsagePct);
              return (
                <div
                  key={cc.id}
                  className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-3"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-code text-xs font-bold text-teal-700 dark:text-teal-400">
                      {cc.code}
                    </span>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => setEditingCC({ ...cc })}
                        title="ویرایش مرکز هزینه"
                        className="p-1 rounded text-slate-400 hover:text-teal-700"
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => deleteCostCenter(cc.id)}
                        title="حذف مرکز هزینه"
                        className="p-1 rounded text-slate-400 hover:text-rose-600"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                      <Building2 className="w-4 h-4 text-slate-400 mr-1" />
                    </div>
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-slate-900 dark:text-white">{cc.name}</h3>
                    <p className="text-xs text-slate-500 mt-0.5">مسئول: {cc.manager || '—'}</p>
                  </div>
                  <div className="space-y-1.5 text-xs">
                    <div className="flex justify-between">
                      <span className="text-slate-500">درآمد منتسب:</span>
                      <span className="font-code tabular-nums text-emerald-700 dark:text-emerald-400">
                        {formatMoney(row.revenue, unit)}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">بهای تمام‌شده (COGS):</span>
                      <span className="font-code tabular-nums">{formatMoney(row.cogs, unit)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">هزینه‌های عملیاتی:</span>
                      <span className="font-code tabular-nums">{formatMoney(row.expenses, unit)}</span>
                    </div>
                    <div className="flex justify-between pt-1.5 border-t border-slate-100 dark:border-slate-800 font-bold">
                      <span className="text-slate-700 dark:text-slate-200">نتیجه خالص پروژه:</span>
                      <span
                        className={`font-code tabular-nums ${
                          row.netResult >= 0
                            ? 'text-emerald-700 dark:text-emerald-400'
                            : 'text-rose-700 dark:text-rose-400'
                        }`}
                      >
                        {formatMoney(row.netResult, unit)}
                      </span>
                    </div>
                    <div className="flex justify-between text-[11px] pt-1">
                      <span className="text-slate-500">بودجه مصوب:</span>
                      <span className="font-code tabular-nums">{formatMoney(cc.budget, unit)}</span>
                    </div>
                    <div className="w-full h-2 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden mt-1">
                      <div
                        className={`h-full rounded-full ${
                          row.budgetUsagePct > 100 ? 'bg-rose-600' : 'bg-teal-600'
                        }`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <div className="text-[11px] text-slate-500 text-left font-code">
                      {toPersianDigits(row.budgetUsagePct)}٪ مصرف بودجه
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (!ccName.trim()) return;
              await addCostCenter({
                code: `CC-0${costCenters.length + 1}`,
                name: ccName.trim(),
                budget: ccBudget,
                manager: profile.displayName,
                active: true,
              });
              setCcName('');
            }}
            className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 flex flex-wrap items-end gap-3 text-xs"
          >
            <div className="flex-1 min-w-[200px]">
              <label className="block text-slate-500 mb-1">عنوان مرکز هزینه یا پروژه جدید</label>
              <input
                value={ccName}
                onChange={(e) => setCcName(e.target.value)}
                placeholder="ورود نام مرکز هزینه یا پروژه"
                className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>
            <div className="w-52">
              <label className="block text-slate-500 mb-1">بودجه مصوب سالانه</label>
              <MoneyInput
                value={ccBudget}
                onValueChange={(n) => setCcBudget(n)}
                placeholder="ورود بودجه سالانه به ریال"
                unitLabel="ریال"
                className="py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>
            <button
              type="submit"
              className="px-4 py-2 font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-lg"
            >
              ایجاد مرکز هزینه
            </button>
          </form>
        </div>
      )}

      {/* Year-End Closing Tab */}
      {tab === 'closing' && (
        <div className="max-w-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-5">
          <div className="flex items-center gap-3">
            <Lock className="w-5 h-5 text-teal-700 dark:text-teal-400" />
            <div>
              <h2 className="text-base font-bold text-slate-900 dark:text-white">
                عملیات پایان سال مالی {toPersianDigits(profile.fiscalYear)} — بستن حساب‌های موقت
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                تمامی حساب‌های درآمد، برگشت از فروش، بهای تمام‌شده و هزینه‌ها به حساب سود و زیان انباشته (۵۰۲۰۱) بسته می‌شوند.
              </p>
            </div>
          </div>

          <div className="bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg p-4 space-y-2 text-xs">
            <div className="flex justify-between">
              <span className="text-slate-500">خالص فروش دوره:</span>
              <span className="font-code tabular-nums font-semibold">
                {formatMoney(incomeStatement.netSales, unit)}
              </span>
            </div>
            {incomeStatement.otherRevenue !== 0 && (
              <div className="flex justify-between">
                <span className="text-slate-500">سایر درآمدها (اضافی انبار و متفرقه):</span>
                <span className="font-code tabular-nums font-semibold text-emerald-700 dark:text-emerald-400">
                  {formatMoney(incomeStatement.otherRevenue, unit)}
                </span>
              </div>
            )}
            <div className="flex justify-between">
              <span className="text-slate-500">جمع بهای تمام‌شده و هزینه‌های عملیاتی:</span>
              <span className="font-code tabular-nums font-semibold">
                {formatMoney(incomeStatement.cogs + incomeStatement.operatingExpenses, unit)}
              </span>
            </div>
            <div className="flex justify-between pt-2 border-t border-slate-200 dark:border-slate-800 text-sm font-bold">
              <span>سود (زیان) خالص قابل انتقال به انباشته (۵۰۲۰۱):</span>
              <span
                className={`font-code tabular-nums ${
                  incomeStatement.netProfit >= 0
                    ? 'text-emerald-700 dark:text-emerald-400'
                    : 'text-rose-700 dark:text-rose-400'
                }`}
              >
                {formatMoney(incomeStatement.netProfit, unit)}
              </span>
            </div>
          </div>

          {profile.closedFiscalYears?.includes(profile.fiscalYear) ? (
            <div className="p-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 text-xs text-emerald-800 dark:text-emerald-300 font-semibold">
              سال مالی {toPersianDigits(profile.fiscalYear)} قبلاً بسته و قفل شده است (امکان ثبت یا ویرایش سند در این سال مسدود است).
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2.5">
              <button
                onClick={() => runYearEndClosing({ createNextYearOpening: false })}
                className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-semibold text-white bg-slate-900 dark:bg-slate-700 hover:bg-slate-800 rounded-lg"
              >
                <Lock className="w-4 h-4" />
                <span>بستن حساب‌های موقت و قفل سال {toPersianDigits(profile.fiscalYear)}</span>
              </button>
              <button
                onClick={() => runYearEndClosing({ createNextYearOpening: true })}
                className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-lg"
              >
                <CheckCircle2 className="w-4 h-4" />
                <span>
                  بستن سال {toPersianDigits(profile.fiscalYear)} + صدور سند افتتاحیه تراز سال{' '}
                  {toPersianDigits(Number(profile.fiscalYear) + 1)}
                </span>
              </button>
            </div>
          )}
        </div>
      )}

      {/* Pay Salary From Bank Modal */}
      {showPaySalaryModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 overflow-y-auto no-print">
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              await paySalariesVoucher(payrollMonth, payBankCode, payrollTotals.net);
              setShowPaySalaryModal(false);
            }}
            className="w-full max-w-md rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-5 space-y-4 text-xs"
          >
            <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-3">
              <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                پرداخت بانکی حقوق {payrollMonth}
              </h3>
              <button type="button" onClick={() => setShowPaySalaryModal(false)}>
                <X className="w-4 h-4 text-slate-500" />
              </button>
            </div>
            <p className="text-slate-500 leading-5">
              با تایید این عملیات، حساب <strong>حقوق پرداختنی (۳۰۴۰۱)</strong> بدهکار و حساب بانکی انتخابی بستانکار می‌گردد.
            </p>
            <div>
              <label className="block text-slate-500 mb-1">حساب بانکی پرداخت‌کننده</label>
              <select
                value={payBankCode}
                onChange={(e) => setPayBankCode(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
              >
                {bankAccounts.map((b) => (
                  <option key={b.id} value={b.code}>
                    {b.code} — {b.title}
                  </option>
                ))}
              </select>
            </div>
            <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950 flex justify-between font-bold">
              <span>مبلغ خالص قابل پرداخت:</span>
              <span className="font-code tabular-nums text-emerald-700 dark:text-emerald-400">
                {formatMoney(payrollTotals.net, unit)}
              </span>
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowPaySalaryModal(false)}
                className="px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-700"
              >
                انصراف
              </button>
              <button
                type="submit"
                className="px-5 py-2 font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-lg"
              >
                ثبت سند پرداخت حقوق
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Printable Official Payslip Modal */}
      {selectedPayslip && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4">
          <div className="w-full max-w-lg rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6 space-y-4 print-container text-xs">
            <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-3">
              <div>
                <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                  فیش حقوقی رسمی — {payrollMonth}
                </h3>
                <p className="text-[11px] text-slate-500 mt-0.5">{profile.companyName}</p>
              </div>
              <div className="flex items-center gap-1 no-print">
                <button
                  onClick={() => window.print()}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-lg"
                >
                  <Printer className="w-3.5 h-3.5" />
                  <span>چاپ فیش</span>
                </button>
                <button
                  onClick={() => setPayslipEmployeeId(null)}
                  className="p-1.5 rounded-lg text-slate-500"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2 p-3 rounded-lg bg-slate-50 dark:bg-slate-950">
              <div>نام پرسنل: <strong>{selectedPayslip.employee.fullName}</strong></div>
              <div>کد پرسنلی: <strong className="font-code">{selectedPayslip.employee.personnelCode}</strong></div>
              <div>واحد سازمانی: {selectedPayslip.employee.department}</div>
              <div>تعداد فرزندان: {toPersianDigits(selectedPayslip.employee.childrenCount)}</div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2 border border-slate-200 dark:border-slate-800 rounded-lg p-3">
                <div className="font-bold text-emerald-700 dark:text-emerald-400 border-b border-slate-100 dark:border-slate-800 pb-1.5">
                  مزایا و کارکرد
                </div>
                <div className="flex justify-between">
                  <span>حقوق پایه:</span>
                  <span className="font-code tabular-nums">
                    {formatMoney(selectedPayslip.employee.baseSalary, unit, false)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>حق مسکن:</span>
                  <span className="font-code tabular-nums">
                    {formatMoney(selectedPayslip.employee.housingAllowance, unit, false)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>بن خواربار:</span>
                  <span className="font-code tabular-nums">
                    {formatMoney(selectedPayslip.employee.foodAllowance, unit, false)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>حق اولاد و اضافه‌کار:</span>
                  <span className="font-code tabular-nums">
                    {formatMoney(
                      Math.max(
                        0,
                        selectedPayslip.grossPay -
                          selectedPayslip.employee.baseSalary -
                          selectedPayslip.employee.housingAllowance -
                          selectedPayslip.employee.foodAllowance
                      ),
                      unit,
                      false
                    )}
                  </span>
                </div>
                <div className="flex justify-between pt-1.5 border-t border-slate-100 dark:border-slate-800 font-bold">
                  <span>جمع ناخالص:</span>
                  <span className="font-code tabular-nums">
                    {formatMoney(selectedPayslip.grossPay, unit, false)}
                  </span>
                </div>
              </div>

              <div className="space-y-2 border border-slate-200 dark:border-slate-800 rounded-lg p-3">
                <div className="font-bold text-rose-700 dark:text-rose-400 border-b border-slate-100 dark:border-slate-800 pb-1.5">
                  کسورات قانونی
                </div>
                <div className="flex justify-between">
                  <span>بیمه سهم کارمند (۷٪):</span>
                  <span className="font-code tabular-nums">
                    {formatMoney(selectedPayslip.employeeInsurance, unit, false)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>مالیات حقوق:</span>
                  <span className="font-code tabular-nums">
                    {formatMoney(selectedPayslip.incomeTax, unit, false)}
                  </span>
                </div>
                <div className="flex justify-between text-slate-400">
                  <span>بیمه سهم کارفرما (اطلاعاتی):</span>
                  <span className="font-code tabular-nums">
                    {formatMoney(selectedPayslip.employerInsurance, unit, false)}
                  </span>
                </div>
                <div className="flex justify-between pt-1.5 border-t border-slate-100 dark:border-slate-800 font-bold">
                  <span>جمع کسورات:</span>
                  <span className="font-code tabular-nums">
                    {formatMoney(
                      selectedPayslip.employeeInsurance + selectedPayslip.incomeTax,
                      unit,
                      false
                    )}
                  </span>
                </div>
              </div>
            </div>

            <div className="p-3.5 rounded-lg bg-teal-50 dark:bg-teal-950/40 flex justify-between items-center text-sm font-extrabold">
              <span>خالص قابل پرداخت ({unit === 'IRT' ? 'تومان' : 'ریال'}):</span>
              <span className="font-code tabular-nums text-teal-800 dark:text-teal-300">
                {formatMoney(selectedPayslip.netPay, unit)}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Edit Employee Modal */}
      {editingEmp && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 overflow-y-auto no-print">
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              await updateEmployee(editingEmp.id, {
                fullName: editingEmp.fullName,
                department: editingEmp.department,
                baseSalary: editingEmp.baseSalary,
                housingAllowance: editingEmp.housingAllowance,
                foodAllowance: editingEmp.foodAllowance,
                childrenCount: editingEmp.childrenCount,
                overtimeHours: editingEmp.overtimeHours,
                costCenterId: editingEmp.costCenterId,
                active: editingEmp.active,
              });
              setEditingEmp(null);
            }}
            className="w-full max-w-lg rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-5 space-y-4 text-xs"
          >
            <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-3">
              <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                ویرایش حکم کارگزینی ({editingEmp.personnelCode})
              </h3>
              <button type="button" onClick={() => setEditingEmp(null)}>
                <X className="w-4 h-4 text-slate-500" />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-slate-500 mb-1">نام و نام خانوادگی</label>
                <input
                  value={editingEmp.fullName}
                  onChange={(e) => setEditingEmp({ ...editingEmp, fullName: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block text-slate-500 mb-1">واحد / دپارتمان</label>
                <input
                  value={editingEmp.department}
                  onChange={(e) => setEditingEmp({ ...editingEmp, department: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block text-slate-500 mb-1">حقوق پایه (ریال)</label>
                <MoneyInput
                  value={editingEmp.baseSalary}
                  onValueChange={(n) => setEditingEmp({ ...editingEmp, baseSalary: n })}
                  placeholder="حقوق پایه ماهانه"
                  unitLabel="ریال"
                  className="py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block text-slate-500 mb-1">حق مسکن (ریال)</label>
                <MoneyInput
                  value={editingEmp.housingAllowance}
                  onValueChange={(n) => setEditingEmp({ ...editingEmp, housingAllowance: n })}
                  placeholder="مبلغ حق مسکن"
                  unitLabel="ریال"
                  className="py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block text-slate-500 mb-1">بن خواربار (ریال)</label>
                <MoneyInput
                  value={editingEmp.foodAllowance}
                  onValueChange={(n) => setEditingEmp({ ...editingEmp, foodAllowance: n })}
                  placeholder="مبلغ بن خواربار"
                  unitLabel="ریال"
                  className="py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block text-slate-500 mb-1">تعداد فرزندان</label>
                <MoneyInput
                  value={editingEmp.childrenCount}
                  onValueChange={(n) => setEditingEmp({ ...editingEmp, childrenCount: Math.max(0, Math.round(n)) })}
                  placeholder="تعداد فرزندان مشمول"
                  unitLabel="نفر"
                  className="py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block text-slate-500 mb-1">ساعات اضافه‌کار</label>
                <MoneyInput
                  allowDecimal
                  value={editingEmp.overtimeHours}
                  onValueChange={(n) => setEditingEmp({ ...editingEmp, overtimeHours: Math.max(0, n) })}
                  placeholder="ساعت اضافه‌کار ماهانه"
                  unitLabel="ساعت"
                  className="py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block text-slate-500 mb-1">مرکز هزینه</label>
                <select
                  value={editingEmp.costCenterId ?? ''}
                  onChange={(e) => setEditingEmp({ ...editingEmp, costCenterId: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
                >
                  {costCenters.map((cc) => (
                    <option key={cc.id} value={cc.id}>
                      {cc.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setEditingEmp(null)}
                className="px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-700"
              >
                انصراف
              </button>
              <button
                type="submit"
                className="px-5 py-2 font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-lg"
              >
                ذخیره تغییرات حکم
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Edit Fixed Asset Modal */}
      {editingAsset && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 overflow-y-auto no-print">
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              await updateFixedAsset(editingAsset.id, {
                title: editingAsset.title,
                purchaseDate: editingAsset.purchaseDate,
                purchaseCost: editingAsset.purchaseCost,
                salvageValue: editingAsset.salvageValue,
                usefulLifeYears: editingAsset.usefulLifeYears,
                accumulatedDepreciation: editingAsset.accumulatedDepreciation,
                costCenterId: editingAsset.costCenterId,
              });
              setEditingAsset(null);
            }}
            className="w-full max-w-lg rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-5 space-y-4 text-xs"
          >
            <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-3">
              <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                ویرایش دارایی ثابت ({editingAsset.assetCode})
              </h3>
              <button type="button" onClick={() => setEditingAsset(null)}>
                <X className="w-4 h-4 text-slate-500" />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <label className="block text-slate-500 mb-1">شرح دارایی</label>
                <input
                  value={editingAsset.title}
                  onChange={(e) => setEditingAsset({ ...editingAsset, title: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block text-slate-500 mb-1">تاریخ خرید</label>
                <input
                  value={editingAsset.purchaseDate}
                  onChange={(e) => setEditingAsset({ ...editingAsset, purchaseDate: e.target.value })}
                  className="w-full px-3 py-2 font-code rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block text-slate-500 mb-1">عمر مفید (سال)</label>
                <MoneyInput
                  value={editingAsset.usefulLifeYears}
                  onValueChange={(n) =>
                    setEditingAsset({ ...editingAsset, usefulLifeYears: Math.max(1, Math.round(n)) })
                  }
                  placeholder="تعداد سال عمر مفید"
                  unitLabel="سال"
                  className="py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block text-slate-500 mb-1">بهای تمام‌شده (ریال)</label>
                <MoneyInput
                  value={editingAsset.purchaseCost}
                  onValueChange={(n) => setEditingAsset({ ...editingAsset, purchaseCost: n })}
                  placeholder="مبلغ بهای تمام‌شده"
                  unitLabel="ریال"
                  className="py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block text-slate-500 mb-1">ارزش اسقاط (ریال)</label>
                <MoneyInput
                  value={editingAsset.salvageValue}
                  onValueChange={(n) => setEditingAsset({ ...editingAsset, salvageValue: n })}
                  placeholder="مبلغ ارزش اسقاط"
                  unitLabel="ریال"
                  className="py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div className="col-span-2">
                <label className="block text-slate-500 mb-1">استهلاک انباشته تاکنون (ریال)</label>
                <MoneyInput
                  value={editingAsset.accumulatedDepreciation}
                  onValueChange={(n) =>
                    setEditingAsset({ ...editingAsset, accumulatedDepreciation: n })
                  }
                  placeholder="مبلغ استهلاک انباشته تا امروز"
                  unitLabel="ریال"
                  className="py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setEditingAsset(null)}
                className="px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-700"
              >
                انصراف
              </button>
              <button
                type="submit"
                className="px-5 py-2 font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-lg"
              >
                ذخیره تغییرات
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Edit Cost Center Modal */}
      {editingCC && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 overflow-y-auto no-print">
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              await updateCostCenter(editingCC.id, {
                name: editingCC.name,
                budget: editingCC.budget,
                manager: editingCC.manager,
                active: editingCC.active,
              });
              setEditingCC(null);
            }}
            className="w-full max-w-md rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-5 space-y-4 text-xs"
          >
            <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-3">
              <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                ویرایش مرکز هزینه ({editingCC.code})
              </h3>
              <button type="button" onClick={() => setEditingCC(null)}>
                <X className="w-4 h-4 text-slate-500" />
              </button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-slate-500 mb-1">عنوان مرکز هزینه / پروژه</label>
                <input
                  value={editingCC.name}
                  onChange={(e) => setEditingCC({ ...editingCC, name: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block text-slate-500 mb-1">مسئول پروژه</label>
                <input
                  value={editingCC.manager ?? ''}
                  onChange={(e) => setEditingCC({ ...editingCC, manager: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block text-slate-500 mb-1">بودجه مصوب سالانه (ریال)</label>
                <MoneyInput
                  value={editingCC.budget}
                  onValueChange={(n) => setEditingCC({ ...editingCC, budget: n })}
                  placeholder="مبلغ بودجه سالانه به ریال"
                  unitLabel="ریال"
                  className="py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setEditingCC(null)}
                className="px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-700"
              >
                انصراف
              </button>
              <button
                type="submit"
                className="px-5 py-2 font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-lg"
              >
                ذخیره تغییرات
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
