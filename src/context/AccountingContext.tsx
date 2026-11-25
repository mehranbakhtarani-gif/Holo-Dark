import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { onAuthStateChanged, User } from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import {
  auth,
  db,
  handleFirestoreError,
  isFirestoreOfflineError,
  OperationType,
  signInWithGoogle,
  signOutAccount,
  testFirestoreConnection,
} from '../lib/firebase';
import {
  Account,
  AuditActivityLog,
  Cheque,
  ChequeStatus,
  CompanyProfile,
  CostCenter,
  CurrencyDefinition,
  CurrencyUnit,
  Employee,
  ExchangeRateEntry,
  FixedAsset,
  ImportDossier,
  Invoice,
  Party,
  Product,
  RbacOperator,
  SalesOrder,
  SubcontractJob,
  Voucher,
  VoucherLine,
  VoucherStatus,
  VoucherType,
} from '../types/accounting';
import { createHolooSeedData } from '../data/holooSeed';
import { FxRevaluationRow } from '../lib/enterpriseAccounting';
import {
  AuditReport,
  calculateEmployeePayroll,
  calculateMonthlyDepreciation,
  computeAuditReport,
  computeBalanceSheet,
  computeIncomeStatement,
  computePartyBalances,
  computeTrialBalance,
  computeVoucherIntegrityHash,
  extractFiscalYearFromDate,
  getNextFiscalYearVoucherNumber,
  planAtomicInvoiceCommit,
  planChequeStatusTransition,
  planInvoiceCancellation,
  planProformaToSaleConversion,
  planStockAdjustmentWithCostLayers,
  planYearEndClosing,
  validateVoucherPayload,
} from '../lib/accountingEngine';
import {
  applyInventoryMovementStep,
  normalizeProductCostState,
} from '../lib/inventoryCostingEngine';
import { generateSafeId, getTodayShamsi } from '../lib/format';
import {
  annotateVoucherLinesWithCurrency,
  BASE_CURRENCY_CODE,
  isForeignCurrency,
  normalizeCurrencyCode,
  roundCurrency,
} from '../lib/currency';
import {
  AudioFeedbackTone,
  inferToastTone,
  isAudioFeedbackEnabled,
  playFeedbackForTone,
  playSuccessChime,
  playWarningTone,
  setAudioFeedbackEnabled,
} from '../lib/audioFeedback';
import {
  commitInvoiceOperationalTx,
  commitInventoryAdjustmentOperationalTx,
  getOperationalDbStats,
  loadOperationalWorkspace,
  OperationalDbStats,
  saveOperationalWorkspaceTx,
} from '../lib/operationalDb';
import {
  deleteLocalSnapshot,
  downloadBackupFileToDevice,
  getAutoBackupOnClosePref,
  getDeviceLabel,
  getOrCreateDeviceId,
  listLocalSnapshots,
  loadLocalSnapshotPayload,
  LocalBackupSnapshotMeta,
  readSyncCloseSnapshot,
  saveDeviceLabel,
  saveLocalSnapshot,
  saveSyncCloseSnapshot,
  setAutoBackupOnClosePref,
} from '../lib/localBackup';
import { planPeriodReopening } from '../lib/accountingIntegrityEngine';
import {
  Holo203SourcePayload,
  HoloMigrationResult,
  runHolo203Migration,
} from '../lib/holoMigrationEngine';

interface AccountingContextValue {
  user: User | null;
  authReady: boolean;
  isCloudMode: boolean;
  isSyncing: boolean;
  isSigningIn: boolean;
  deviceId: string;
  deviceLabel: string;
  setDeviceLabel: (label: string) => void;
  autoBackupOnClose: boolean;
  setAutoBackupOnClose: (enabled: boolean) => void;
  localSnapshots: LocalBackupSnapshotMeta[];
  lastLocalBackupAt: string | null;
  triggerLocalBackupNow: (alsoDownload?: boolean) => Promise<void>;
  restoreFromLocalSnapshot: (snapshotId: string) => Promise<boolean>;
  removeLocalSnapshot: (snapshotId: string) => Promise<void>;
  profile: CompanyProfile;
  accounts: Account[];
  parties: Party[];
  products: Product[];
  vouchers: Voucher[];
  invoices: Invoice[];
  cheques: Cheque[];
  employees: Employee[];
  assets: FixedAsset[];
  costCenters: CostCenter[];
  currencies: CurrencyDefinition[];
  exchangeRates: ExchangeRateEntry[];
  importDossiers: ImportDossier[];
  salesOrders: SalesOrder[];
  subcontractJobs: SubcontractJob[];
  rbacOperators: RbacOperator[];
  activeOperator: RbacOperator;
  setActiveOperatorId: (id: string) => void;
  auditLogs: AuditActivityLog[];
  trialBalance: ReturnType<typeof computeTrialBalance>;
  incomeStatement: ReturnType<typeof computeIncomeStatement>;
  balanceSheet: ReturnType<typeof computeBalanceSheet>;
  partyBalances: Map<string, number>;
  auditReport: AuditReport;
  toast: string | null;
  showToast: (msg: string, tone?: AudioFeedbackTone) => void;
  audioEnabled: boolean;
  setAudioEnabled: (enabled: boolean) => void;
  includeDraftsInReports: boolean;
  setIncludeDraftsInReports: (include: boolean) => void;
  operationalDbStats: OperationalDbStats | null;
  loginWithGoogle: () => Promise<void>;
  logout: () => Promise<void>;
  updateCompanyProfile: (patch: Partial<CompanyProfile>) => Promise<void>;
  setCurrencyUnit: (unit: CurrencyUnit) => Promise<void>;
  // Accounts CRUD
  addAccount: (acc: Omit<Account, 'id' | 'ownerId'>) => Promise<void>;
  updateAccount: (accountId: string, patch: Partial<Pick<Account, 'title' | 'parentCode' | 'category' | 'nature'>>) => Promise<void>;
  deleteAccount: (accountId: string) => Promise<boolean>;
  // Parties CRUD
  addParty: (party: Omit<Party, 'id' | 'ownerId'>) => Promise<void>;
  updateParty: (partyId: string, patch: Partial<Omit<Party, 'id' | 'ownerId' | 'code'>>) => Promise<void>;
  deleteParty: (partyId: string) => Promise<boolean>;
  // Products & Warehouse CRUD
  addProduct: (product: Omit<Product, 'id' | 'ownerId'>) => Promise<void>;
  updateProduct: (productId: string, patch: Partial<Omit<Product, 'id' | 'ownerId' | 'sku'>>) => Promise<void>;
  deleteProduct: (productId: string) => Promise<boolean>;
  adjustProductStock: (productId: string, newStock: number) => Promise<void>;
  adjustProductStockWithVoucher: (productId: string, countedStock: number, reason: string) => Promise<void>;
  bulkStocktakingWithVoucher: (
    items: { productId: string; countedStock: number }[],
    reason: string
  ) => Promise<void>;
  bulkUpdateProductPrices: (
    productIds: string[],
    target: 'sellPrice' | 'buyPrice',
    percentDelta: number
  ) => Promise<void>;
  transferProductWarehouse: (productId: string, targetWarehouse: string) => Promise<void>;
  // Vouchers CRUD & Audit ops
  createVoucher: (payload: {
    date: string;
    description: string;
    voucherType: VoucherType;
    status: VoucherStatus;
    lines: VoucherLine[];
    referenceId?: string;
    reversalOfVoucherId?: string;
    allowDuplicate?: boolean;
    currencyCode?: string;
    exchangeRate?: number;
  }) => Promise<Voucher>;
  updateVoucher: (
    voucherId: string,
    payload: {
      date: string;
      description: string;
      voucherType: VoucherType;
      status: VoucherStatus;
      lines: VoucherLine[];
      currencyCode?: string;
      exchangeRate?: number;
    }
  ) => Promise<void>;
  deleteVoucher: (voucherId: string) => Promise<boolean>;
  finalizeVoucher: (voucherId: string) => Promise<void>;
  finalizeAllDraftVouchers: () => Promise<number>;
  createReversingVoucher: (voucherId: string) => Promise<Voucher | null>;
  renumberVouchersChronologically: () => Promise<void>;
  // Multi-Currency & Daily Exchange Rates
  addCurrency: (cur: Omit<CurrencyDefinition, 'id' | 'ownerId' | 'isBase'>) => Promise<boolean>;
  updateCurrency: (
    currencyId: string,
    patch: Partial<Pick<CurrencyDefinition, 'name' | 'symbol' | 'decimalPlaces' | 'defaultRateToIrr' | 'active'>>
  ) => Promise<void>;
  deleteCurrency: (currencyId: string) => Promise<boolean>;
  upsertExchangeRate: (entry: Omit<ExchangeRateEntry, 'id' | 'ownerId'>) => Promise<void>;
  deleteExchangeRate: (rateId: string) => Promise<void>;
  // Invoices CRUD & Commercial ops
  createInvoice: (payload: Omit<Invoice, 'id' | 'ownerId' | 'voucherId'>) => Promise<Invoice>;
  cancelInvoice: (invoiceId: string) => Promise<void>;
  convertProformaToSale: (invoiceId: string) => Promise<void>;
  // Treasury & Cheques
  addCheque: (payload: Omit<Cheque, 'id' | 'ownerId'>, skipVoucher?: boolean) => Promise<void>;
  updateCheque: (
    chequeId: string,
    patch: Partial<Pick<Cheque, 'bankName' | 'branch' | 'dueDate' | 'notes'>>
  ) => Promise<void>;
  updateChequeStatus: (
    chequeId: string,
    newStatus: ChequeStatus,
    options?: { bankAccountCode?: string; endorsePartyId?: string }
  ) => Promise<void>;
  recordQuickTreasury: (payload: {
    direction: 'receipt' | 'payment';
    accountCode: string;
    partyId: string;
    amount: number;
    date: string;
    description: string;
  }) => Promise<void>;
  recordBankTransfer: (payload: {
    fromAccountCode: string;
    toAccountCode: string;
    amount: number;
    date: string;
    description: string;
  }) => Promise<void>;
  // Corporate CRUD & Vouchers
  addEmployee: (emp: Omit<Employee, 'id' | 'ownerId'>) => Promise<void>;
  updateEmployee: (empId: string, patch: Partial<Omit<Employee, 'id' | 'ownerId' | 'personnelCode'>>) => Promise<void>;
  deleteEmployee: (empId: string) => Promise<void>;
  postMonthlyPayrollVoucher: (monthName: string) => Promise<void>;
  paySalariesVoucher: (monthName: string, bankAccountCode: string, amount: number) => Promise<void>;
  addFixedAsset: (asset: Omit<FixedAsset, 'id' | 'ownerId'>) => Promise<void>;
  updateFixedAsset: (assetId: string, patch: Partial<Omit<FixedAsset, 'id' | 'ownerId' | 'assetCode'>>) => Promise<void>;
  deleteFixedAsset: (assetId: string) => Promise<void>;
  postDepreciationVoucher: (periodLabel: string) => Promise<void>;
  addCostCenter: (cc: Omit<CostCenter, 'id' | 'ownerId'>) => Promise<void>;
  updateCostCenter: (ccId: string, patch: Partial<Omit<CostCenter, 'id' | 'ownerId' | 'code'>>) => Promise<void>;
  deleteCostCenter: (ccId: string) => Promise<void>;
  runYearEndClosing: (options?: { createNextYearOpening?: boolean }) => Promise<void>;
  reopenFiscalYear: (fiscalYear: string, reason: string) => Promise<boolean>;
  commitHolo203Migration: (source: Holo203SourcePayload) => Promise<HoloMigrationResult>;
  // Enterprise Yarn Import, Weighbridge Orders, Subcontracting, FX Revaluation, RBAC & Audit Log
  addImportDossier: (dossier: Omit<ImportDossier, 'id' | 'ownerId'>) => Promise<void>;
  clearImportDossier: (dossierId: string) => Promise<void>;
  addSalesOrder: (order: Omit<SalesOrder, 'id' | 'ownerId'>) => Promise<void>;
  dispatchSalesOrder: (
    orderId: string,
    payload: {
      dispatchDate: string;
      driverName: string;
      plateNumber: string;
      items: SalesOrder['items'];
    }
  ) => Promise<void>;
  invoiceSalesOrder: (orderId: string) => Promise<void>;
  addSubcontractJob: (job: Omit<SubcontractJob, 'id' | 'ownerId'>) => Promise<void>;
  completeSubcontractJob: (
    jobId: string,
    payload: {
      returnedWeightKg: number;
      completionDate: string;
      finishedLotNumber: string;
      includeServiceVat?: boolean;
    }
  ) => Promise<void>;
  postFxRevaluationVoucher: (rows: FxRevaluationRow[], date: string) => Promise<void>;
  postBrokerCommissionVoucher: (payload: {
    partyId: string;
    partyName: string;
    amountIrr: number;
    date: string;
    periodLabel: string;
  }) => Promise<void>;
  addRbacOperator: (op: Omit<RbacOperator, 'id' | 'ownerId'>) => Promise<void>;
  updateRbacOperator: (
    opId: string,
    patch: Partial<Pick<RbacOperator, 'fullName' | 'role' | 'email' | 'active' | 'permissions'>>
  ) => Promise<void>;
  deleteRbacOperator: (opId: string) => Promise<void>;
  logActivity: (
    module: string,
    action: string,
    details: string,
    meta?: Partial<
      Pick<
        AuditActivityLog,
        | 'operationType'
        | 'beforeValue'
        | 'afterValue'
        | 'reason'
        | 'relatedVoucherId'
        | 'relatedOperationId'
      >
    >
  ) => void;
  // Backup, Restore & Comprehensive Data Reset
  exportBackupJson: () => string;
  importBackupJson: (jsonText: string) => boolean;
  resetWorkspaceTables: (options: {
    mode: 'blank' | 'demo';
    keepChartOfAccounts?: boolean;
    keepCompanyProfile?: boolean;
  }) => Promise<{ ok: boolean; summary: string }>;
}

const AccountingContext = createContext<AccountingContextValue | null>(null);

const DEMO_OWNER = 'demo_holoo_apex';

const DEFAULT_PROFILE: CompanyProfile = {
  uid: DEMO_OWNER,
  displayName: 'مهندس مهران باختری',
  email: 'finance@atlasris-yarn.ir',
  companyName: 'شرکت بازرگانی و واردات نخ نساجی اطلس‌ریس (سهامی خاص)',
  economicCode: '411589203411',
  nationalId: '14007892134',
  fiscalYear: '1405',
  currencyUnit: 'IRT',
  role: 'accountant',
};

export const AccountingProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const initialSeed = useMemo(() => createHolooSeedData(DEMO_OWNER), []);
  const deviceId = useMemo(() => getOrCreateDeviceId(), []);

  const [deviceLabel, setDeviceLabelState] = useState<string>(() => getDeviceLabel());
  const [autoBackupOnClose, setAutoBackupOnCloseState] = useState<boolean>(() =>
    getAutoBackupOnClosePref()
  );
  const [localSnapshots, setLocalSnapshots] = useState<LocalBackupSnapshotMeta[]>([]);
  const [lastLocalBackupAt, setLastLocalBackupAt] = useState<string | null>(null);

  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [audioEnabled, setAudioEnabledState] = useState<boolean>(() => isAudioFeedbackEnabled());
  const [includeDraftsInReports, setIncludeDraftsInReports] = useState<boolean>(false);
  const [operationalDbStats, setOperationalDbStats] = useState<OperationalDbStats | null>(null);

  const [profile, setProfile] = useState<CompanyProfile>(DEFAULT_PROFILE);
  const [accounts, setAccounts] = useState<Account[]>(initialSeed.accounts);
  const [parties, setParties] = useState<Party[]>(initialSeed.parties);
  const [products, setProducts] = useState<Product[]>(initialSeed.products);
  const [vouchers, setVouchers] = useState<Voucher[]>(initialSeed.vouchers);
  const [invoices, setInvoices] = useState<Invoice[]>(initialSeed.invoices);
  const [cheques, setCheques] = useState<Cheque[]>(initialSeed.cheques);
  const [employees, setEmployees] = useState<Employee[]>(initialSeed.employees);
  const [assets, setAssets] = useState<FixedAsset[]>(initialSeed.assets);
  const [costCenters, setCostCenters] = useState<CostCenter[]>(initialSeed.costCenters);
  const [currencies, setCurrencies] = useState<CurrencyDefinition[]>(initialSeed.currencies);
  const [exchangeRates, setExchangeRates] = useState<ExchangeRateEntry[]>(initialSeed.exchangeRates);
  const [importDossiers, setImportDossiers] = useState<ImportDossier[]>(initialSeed.importDossiers);
  const [salesOrders, setSalesOrders] = useState<SalesOrder[]>(initialSeed.salesOrders);
  const [subcontractJobs, setSubcontractJobs] = useState<SubcontractJob[]>(initialSeed.subcontractJobs);
  const [rbacOperators, setRbacOperators] = useState<RbacOperator[]>(initialSeed.rbacOperators);
  const [activeOperatorId, setActiveOperatorId] = useState<string>(initialSeed.rbacOperators[0].id);
  const [auditLogs, setAuditLogs] = useState<AuditActivityLog[]>(initialSeed.auditLogs);

  const activeOperator = useMemo(
    () =>
      rbacOperators.find((op) => op.id === activeOperatorId) ??
      rbacOperators[0] ??
      initialSeed.rbacOperators[0],
    [rbacOperators, activeOperatorId, initialSeed.rbacOperators]
  );

  const showToast = useCallback((msg: string, explicitTone?: AudioFeedbackTone) => {
    setToast(msg);
    const resolvedTone = explicitTone ?? inferToastTone(msg);
    playFeedbackForTone(resolvedTone);
    window.setTimeout(() => {
      setToast((prev) => (prev === msg ? null : prev));
    }, 4500);
  }, []);

  const setAudioEnabled = useCallback((enabled: boolean) => {
    setAudioFeedbackEnabled(enabled);
    setAudioEnabledState(enabled);
    if (enabled) {
      playSuccessChime(true);
    }
  }, []);

  const setDeviceLabel = useCallback(
    (label: string) => {
      const saved = saveDeviceLabel(label);
      setDeviceLabelState(saved);
      showToast(`نام این دستگاه به «${saved}» تغییر یافت.`);
    },
    [showToast]
  );

  const setAutoBackupOnClose = useCallback(
    (enabled: boolean) => {
      setAutoBackupOnClosePref(enabled);
      setAutoBackupOnCloseState(enabled);
      showToast(
        enabled
          ? 'پشتیبان‌گیری خودکار روی حافظه داخلی دستگاه هنگام بستن برنامه فعال شد.'
          : 'پشتیبان‌گیری خودکار هنگام بستن برنامه غیرفعال شد.'
      );
    },
    [showToast]
  );

  useEffect(() => {
    listLocalSnapshots()
      .then((snaps) => {
        setLocalSnapshots(snaps);
        if (snaps[0]) setLastLocalBackupAt(snaps[0].savedAtShamsi);
      })
      .catch(() => {
        // ignore IndexedDB errors
      });
  }, []);

  useEffect(() => {
    testFirestoreConnection();
    const unsub = onAuthStateChanged(auth, (firebaseUser) => {
      setUser(firebaseUser);
      setAuthReady(true);
    });
    return () => unsub();
  }, []);

  // Reserve a unique number per fiscal year. Authenticated cloud records must never
  // fall back to a cache-derived number: offline numbering cannot be globally unique.
  const reserveNextVoucherNumber = useCallback(
    async (fiscalYear: string, fallbackMax: number): Promise<number> => {
      if (!user) return fallbackMax + 1;
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        throw new Error('برای جلوگیری از شماره تکراری، ثبت سند در حالت آفلاین مجاز نیست. پس از اتصال اینترنت دوباره تلاش کنید.');
      }
      const counterRef = doc(db, 'counters', user.uid);
      try {
        return await runTransaction(db, async (tx) => {
          const snap = await tx.get(counterRef);
          const data = snap.exists() ? snap.data() : {};
          const yearCounters =
            data.voucherNumbersByFiscalYear && typeof data.voucherNumbersByFiscalYear === 'object'
              ? data.voucherNumbersByFiscalYear as Record<string, number>
              : {};
          const nextNum = getNextFiscalYearVoucherNumber(fiscalYear, yearCounters, fallbackMax);
          const globalMax = Math.max(Number(data.lastVoucherNumber) || 0, nextNum);
          const nextYearCounters = { ...yearCounters, [fiscalYear]: nextNum };
          if (!snap.exists()) {
            tx.set(counterRef, {
              ownerId: user.uid,
              lastVoucherNumber: globalMax,
              voucherNumbersByFiscalYear: nextYearCounters,
              lastInvoiceSeq: 102,
              updatedByDevice: deviceId.slice(0, 64),
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            });
          } else {
            tx.update(counterRef, {
              lastVoucherNumber: globalMax,
              voucherNumbersByFiscalYear: nextYearCounters,
              updatedByDevice: deviceId.slice(0, 64),
              updatedAt: serverTimestamp(),
            });
          }
          return nextNum;
        });
      } catch (err) {
        if (isFirestoreOfflineError(err)) {
          throw new Error('شماره سند از سرور رزرو نشد؛ برای جلوگیری از شماره تکراری، ثبت انجام نشد. اتصال اینترنت را بررسی کنید.');
        }
        throw err;
      }
    },
    [user, deviceId]
  );

  const ensureCloudSeed = useCallback(
    async (firebaseUser: User) => {
      const uid = firebaseUser.uid;
      setIsSyncing(true);
      let currentPath = `users/${uid}`;
      let currentOp = OperationType.WRITE;
      try {
        const profileRef = doc(db, 'users', uid);
        currentOp = OperationType.GET;
        const profileSnap = await getDoc(profileRef);
        if (!profileSnap.exists()) {
          currentOp = OperationType.CREATE;
          await setDoc(profileRef, {
            uid,
            displayName: (firebaseUser.displayName || 'مدیر مالی').slice(0, 120),
            email: (firebaseUser.email || '').slice(0, 200),
            companyName: DEFAULT_PROFILE.companyName,
            economicCode: DEFAULT_PROFILE.economicCode,
            nationalId: DEFAULT_PROFILE.nationalId,
            fiscalYear: DEFAULT_PROFILE.fiscalYear,
            currencyUnit: DEFAULT_PROFILE.currencyUnit,
            role: 'accountant',
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        }

        const seed = createHolooSeedData(uid);
        const now = serverTimestamp();

        const putAllInBatch = <T extends { id: string }>(
          batch: ReturnType<typeof writeBatch>,
          colName: string,
          items: T[]
        ) => {
          items.forEach((item) => {
            const { id, ...rest } = item;
            const docId = `${uid.slice(0, 10)}_${id}`;
            batch.set(doc(db, colName, docId), {
              ...rest,
              createdAt: now,
              updatedAt: now,
            });
          });
        };

        currentPath = 'accounts';
        currentOp = OperationType.LIST;
        const accQuery = query(collection(db, 'accounts'), where('ownerId', '==', uid));
        const existingAccs = await getDocs(accQuery);
        if (existingAccs.empty) {
          currentPath = 'accounts (seed batch)';
          currentOp = OperationType.CREATE;
          const batch = writeBatch(db);
          putAllInBatch(batch, 'accounts', seed.accounts);
          putAllInBatch(batch, 'parties', seed.parties);
          putAllInBatch(batch, 'products', seed.products);
          putAllInBatch(batch, 'costCenters', seed.costCenters);
          putAllInBatch(batch, 'vouchers', seed.vouchers);
          putAllInBatch(batch, 'invoices', seed.invoices);
          putAllInBatch(batch, 'cheques', seed.cheques);
          putAllInBatch(batch, 'employees', seed.employees);
          putAllInBatch(batch, 'assets', seed.assets);
          putAllInBatch(batch, 'currencies', seed.currencies);
          putAllInBatch(batch, 'exchangeRates', seed.exchangeRates);
          putAllInBatch(batch, 'importDossiers', seed.importDossiers);
          putAllInBatch(batch, 'salesOrders', seed.salesOrders);
          putAllInBatch(batch, 'subcontractJobs', seed.subcontractJobs);
          putAllInBatch(batch, 'rbacOperators', seed.rbacOperators);
          putAllInBatch(batch, 'auditLogs', seed.auditLogs);
          batch.set(doc(db, 'counters', uid), {
            ownerId: uid,
            lastVoucherNumber: seed.vouchers.length,
            lastInvoiceSeq: 102,
            updatedByDevice: deviceId.slice(0, 64),
            createdAt: now,
            updatedAt: now,
          });
          await batch.commit();
          showToast('فضای کاری شرکتی هلو Apex در فضای ابری با همگام‌سازی چنددستگاهی ایجاد شد.');
        } else {
          // Incrementally bootstrap newly added enterprise accounts/collections for existing workspaces
          const existingCodes = new Set(existingAccs.docs.map((d) => String(d.data().code || '')));
          const missingSystemAccs = seed.accounts.filter(
            (a) => (a.code === '10502' || a.code === '10503') && !existingCodes.has(a.code)
          );
          if (missingSystemAccs.length > 0) {
            currentPath = 'accounts (upgrade)';
            currentOp = OperationType.CREATE;
            const accBatch = writeBatch(db);
            putAllInBatch(accBatch, 'accounts', missingSystemAccs);
            await accBatch.commit();
          }

          const ensureColSeeded = async <T extends { id: string }>(
            colName: string,
            seedItems: T[]
          ) => {
            currentPath = colName;
            currentOp = OperationType.LIST;
            const snap = await getDocs(query(collection(db, colName), where('ownerId', '==', uid)));
            if (snap.empty && seedItems.length > 0) {
              currentOp = OperationType.CREATE;
              const b = writeBatch(db);
              putAllInBatch(b, colName, seedItems);
              await b.commit();
            }
          };

          await ensureColSeeded('currencies', seed.currencies);
          await ensureColSeeded('exchangeRates', seed.exchangeRates);
          await ensureColSeeded('importDossiers', seed.importDossiers);
          await ensureColSeeded('salesOrders', seed.salesOrders);
          await ensureColSeeded('subcontractJobs', seed.subcontractJobs);
          await ensureColSeeded('rbacOperators', seed.rbacOperators);
          await ensureColSeeded('auditLogs', seed.auditLogs);

          currentPath = `counters/${uid}`;
          currentOp = OperationType.GET;
          const counterSnap = await getDoc(doc(db, 'counters', uid));
          if (!counterSnap.exists()) {
            currentOp = OperationType.CREATE;
            await setDoc(doc(db, 'counters', uid), {
              ownerId: uid,
              lastVoucherNumber: seed.vouchers.length,
              lastInvoiceSeq: 102,
              updatedByDevice: deviceId.slice(0, 64),
              createdAt: now,
              updatedAt: now,
            });
          }
        }
      } catch (error) {
        if (isFirestoreOfflineError(error)) {
          showToast(
            'ارتباط موقت با سرور ابری برقرار نشد؛ برنامه در حالت آفلاین فعال است و پشتیبان داخلی دستگاه شما محافظت می‌شود.'
          );
          return;
        }
        handleFirestoreError(error, currentOp, currentPath);
      } finally {
        setIsSyncing(false);
      }
    },
    [showToast, deviceId]
  );

  useEffect(() => {
    if (!authReady) return;
    if (!user) {
      let cancelledLocal = false;

      const hydrateFallbackLocal = () => {
        const lastLocal = readSyncCloseSnapshot();
        if (lastLocal?.payloadJson) {
          try {
            const parsed = JSON.parse(lastLocal.payloadJson);
            if (Array.isArray(parsed.accounts) && Array.isArray(parsed.vouchers) && parsed.accounts.length > 0) {
              if (parsed.profile) setProfile({ ...DEFAULT_PROFILE, ...parsed.profile, uid: DEMO_OWNER });
              setAccounts(parsed.accounts);
              if (Array.isArray(parsed.parties)) setParties(parsed.parties);
              if (Array.isArray(parsed.products)) setProducts(parsed.products);
              setVouchers(parsed.vouchers);
              if (Array.isArray(parsed.invoices)) setInvoices(parsed.invoices);
              if (Array.isArray(parsed.cheques)) setCheques(parsed.cheques);
              if (Array.isArray(parsed.employees)) setEmployees(parsed.employees);
              if (Array.isArray(parsed.assets)) setAssets(parsed.assets);
              if (Array.isArray(parsed.costCenters)) setCostCenters(parsed.costCenters);
              if (Array.isArray(parsed.currencies) && parsed.currencies.length > 0) setCurrencies(parsed.currencies);
              if (Array.isArray(parsed.exchangeRates)) setExchangeRates(parsed.exchangeRates);
              if (Array.isArray(parsed.importDossiers)) setImportDossiers(parsed.importDossiers);
              if (Array.isArray(parsed.salesOrders)) setSalesOrders(parsed.salesOrders);
              if (Array.isArray(parsed.subcontractJobs)) setSubcontractJobs(parsed.subcontractJobs);
              if (Array.isArray(parsed.rbacOperators) && parsed.rbacOperators.length > 0) {
                setRbacOperators(parsed.rbacOperators);
              }
              if (Array.isArray(parsed.auditLogs)) setAuditLogs(parsed.auditLogs);
              return;
            }
          } catch {
            // Fall back cleanly to default seed
          }
        }

        const demo = createHolooSeedData(DEMO_OWNER);
        setProfile(DEFAULT_PROFILE);
        setAccounts(demo.accounts);
        setParties(demo.parties);
        setProducts(demo.products);
        setVouchers(demo.vouchers);
        setInvoices(demo.invoices);
        setCheques(demo.cheques);
        setEmployees(demo.employees);
        setAssets(demo.assets);
        setCostCenters(demo.costCenters);
        setCurrencies(demo.currencies);
        setExchangeRates(demo.exchangeRates);
        setImportDossiers(demo.importDossiers);
        setSalesOrders(demo.salesOrders);
        setSubcontractJobs(demo.subcontractJobs);
        setRbacOperators(demo.rbacOperators);
        setAuditLogs(demo.auditLogs);
      };

      // Primary Local Operational Database Hydration (IndexedDB object stores)
      loadOperationalWorkspace()
        .then((opData) => {
          if (cancelledLocal) return;
          if (opData && opData.accounts.length > 0) {
            setProfile({ ...DEFAULT_PROFILE, ...opData.profile, uid: DEMO_OWNER });
            setAccounts(opData.accounts);
            setParties(opData.parties);
            setProducts(opData.products);
            setVouchers(opData.vouchers);
            setInvoices(opData.invoices);
            setCheques(opData.cheques);
            setEmployees(opData.employees);
            setAssets(opData.assets);
            setCostCenters(opData.costCenters);
            if (opData.currencies.length > 0) setCurrencies(opData.currencies);
            setExchangeRates(opData.exchangeRates);
            setImportDossiers(opData.importDossiers);
            setSalesOrders(opData.salesOrders);
            setSubcontractJobs(opData.subcontractJobs);
            if (opData.rbacOperators.length > 0) setRbacOperators(opData.rbacOperators);
            setAuditLogs(opData.auditLogs);
          } else {
            hydrateFallbackLocal();
          }
          return getOperationalDbStats().then((st) => {
            if (!cancelledLocal) setOperationalDbStats(st);
          });
        })
        .catch(() => {
          if (!cancelledLocal) hydrateFallbackLocal();
        });

      return () => {
        cancelledLocal = true;
      };
    }

    let cancelled = false;
    const unsubs: (() => void)[] = [];

    // If launching completely offline while authenticated, hydrate immediately from the latest device snapshot
    // before Firestore's IndexedDB cache emits snapshots so the user never sees stale/seed data offline.
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      const lastLocal = readSyncCloseSnapshot();
      if (lastLocal?.payloadJson) {
        try {
          const parsed = JSON.parse(lastLocal.payloadJson);
          if (Array.isArray(parsed.accounts) && Array.isArray(parsed.vouchers) && parsed.accounts.length > 0) {
            if (parsed.profile) setProfile({ ...DEFAULT_PROFILE, ...parsed.profile, uid: user.uid });
            setAccounts(parsed.accounts);
            if (Array.isArray(parsed.parties)) setParties(parsed.parties);
            if (Array.isArray(parsed.products)) setProducts(parsed.products);
            setVouchers(parsed.vouchers);
            if (Array.isArray(parsed.invoices)) setInvoices(parsed.invoices);
            if (Array.isArray(parsed.cheques)) setCheques(parsed.cheques);
            if (Array.isArray(parsed.employees)) setEmployees(parsed.employees);
            if (Array.isArray(parsed.assets)) setAssets(parsed.assets);
            if (Array.isArray(parsed.costCenters)) setCostCenters(parsed.costCenters);
            if (Array.isArray(parsed.currencies) && parsed.currencies.length > 0) setCurrencies(parsed.currencies);
            if (Array.isArray(parsed.exchangeRates)) setExchangeRates(parsed.exchangeRates);
            if (Array.isArray(parsed.importDossiers)) setImportDossiers(parsed.importDossiers);
            if (Array.isArray(parsed.salesOrders)) setSalesOrders(parsed.salesOrders);
            if (Array.isArray(parsed.subcontractJobs)) setSubcontractJobs(parsed.subcontractJobs);
            if (Array.isArray(parsed.rbacOperators) && parsed.rbacOperators.length > 0) {
              setRbacOperators(parsed.rbacOperators);
            }
            if (Array.isArray(parsed.auditLogs)) setAuditLogs(parsed.auditLogs);
          }
        } catch {
          // Ignore malformed local snapshot
        }
      }
    }

    ensureCloudSeed(user)
      .then(() => {
        if (cancelled) return;
        const uid = user.uid;

        unsubs.push(
          onSnapshot(
            doc(db, 'users', uid),
            (snap) => {
              if (snap.exists()) {
                const d = snap.data();
                setProfile({
                  uid: d.uid,
                  displayName: d.displayName,
                  email: d.email,
                  companyName: d.companyName,
                  economicCode: d.economicCode,
                  nationalId: d.nationalId,
                  fiscalYear: d.fiscalYear,
                  currencyUnit: d.currencyUnit || 'IRT',
                  role: 'accountant',
                });
              }
            },
            (err) => {
              if (isFirestoreOfflineError(err)) return;
              handleFirestoreError(err, OperationType.GET, `users/${uid}`);
            }
          )
        );

        const subscribeCol = <T,>(
          colName: string,
          setter: React.Dispatch<React.SetStateAction<T[]>>
        ) => {
          const q = query(collection(db, colName), where('ownerId', '==', uid));
          unsubs.push(
            onSnapshot(
              q,
              (snap) => {
                const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }) as T);
                setter(list);
              },
              (err) => {
                if (isFirestoreOfflineError(err)) return;
                handleFirestoreError(err, OperationType.LIST, colName);
              }
            )
          );
        };

        subscribeCol<Account>('accounts', setAccounts);
        subscribeCol<Party>('parties', setParties);
        subscribeCol<Product>('products', setProducts);
        subscribeCol<Voucher>('vouchers', setVouchers);
        subscribeCol<Invoice>('invoices', setInvoices);
        subscribeCol<Cheque>('cheques', setCheques);
        subscribeCol<Employee>('employees', setEmployees);
        subscribeCol<FixedAsset>('assets', setAssets);
        subscribeCol<CostCenter>('costCenters', setCostCenters);
        subscribeCol<CurrencyDefinition>('currencies', setCurrencies);
        subscribeCol<ExchangeRateEntry>('exchangeRates', setExchangeRates);
        subscribeCol<ImportDossier>('importDossiers', setImportDossiers);
        subscribeCol<SalesOrder>('salesOrders', setSalesOrders);
        subscribeCol<SubcontractJob>('subcontractJobs', setSubcontractJobs);
        subscribeCol<RbacOperator>('rbacOperators', setRbacOperators);
        subscribeCol<AuditActivityLog>('auditLogs', setAuditLogs);
      })
      .catch((err) => {
        console.error(err);
      });

    return () => {
      cancelled = true;
      unsubs.forEach((u) => u());
    };
  }, [authReady, user, ensureCloudSeed]);

  const ownerId = user?.uid ?? DEMO_OWNER;
  const isCloudMode = !!user;

  const reportFilterOpts = useMemo(
    () => ({
      includeDrafts: includeDraftsInReports,
      fiscalYear: profile.fiscalYear,
    }),
    [includeDraftsInReports, profile.fiscalYear]
  );

  const trialBalance = useMemo(
    () => computeTrialBalance(accounts, vouchers, reportFilterOpts),
    [accounts, vouchers, reportFilterOpts]
  );
  const trialBalancePreClosing = useMemo(
    () =>
      computeTrialBalance(accounts, vouchers, {
        ...reportFilterOpts,
        excludeClosing: true,
      }),
    [accounts, vouchers, reportFilterOpts]
  );
  const incomeStatement = useMemo(
    () => computeIncomeStatement(trialBalancePreClosing),
    [trialBalancePreClosing]
  );
  const balanceSheet = useMemo(() => computeBalanceSheet(trialBalance), [trialBalance]);
  const partyBalances = useMemo(
    () => computePartyBalances(parties, vouchers, reportFilterOpts),
    [parties, vouchers, reportFilterOpts]
  );
  const auditReport = useMemo(
    () =>
      computeAuditReport({
        accounts,
        vouchers,
        invoices,
        parties,
        products,
        cheques,
        trialBalance,
        balanceSheet,
        partyBalances,
        fiscalYear: profile.fiscalYear,
        pendingOutboxCount: operationalDbStats?.pendingOutboxCount,
      }),
    [
      accounts,
      vouchers,
      invoices,
      parties,
      products,
      cheques,
      trialBalance,
      balanceSheet,
      partyBalances,
      profile.fiscalYear,
      operationalDbStats?.pendingOutboxCount,
    ]
  );

  const loginWithGoogle = useCallback(async () => {
    if (isSigningIn) return;
    setIsSigningIn(true);
    try {
      const credential = await signInWithGoogle();
      if (credential) {
        showToast('ورود با حساب گوگل انجام شد. همگام‌سازی ابری فعال است.');
      }
    } catch (err) {
      const code =
        err && typeof err === 'object' && 'code' in err
          ? String((err as { code?: unknown }).code || '')
          : '';
      if (code === 'auth/popup-blocked') {
        showToast('پنجره ورود گوگل توسط مرورگر مسدود شد؛ لطفاً باز شدن Pop-up را مجاز کنید.');
      } else if (code === 'auth/network-request-failed') {
        showToast('اتصال اینترنت برای ورود به حساب گوگل برقرار نشد.');
      } else if (code !== 'auth/cancelled-popup-request' && code !== 'auth/popup-closed-by-user') {
        showToast('ورود با حساب گوگل با خطا مواجه گردید. لطفاً دوباره تلاش کنید.');
      }
    } finally {
      setIsSigningIn(false);
    }
  }, [isSigningIn, showToast]);

  const logout = useCallback(async () => {
    await signOutAccount();
    showToast('از حساب ابری خارج شدید. محیط نمونه محلی فعال است.');
  }, [showToast]);

  const updateCompanyProfile = useCallback(
    async (patch: Partial<CompanyProfile>) => {
      const next = { ...profile, ...patch };
      setProfile(next);
      if (user) {
        const path = `users/${user.uid}`;
        try {
          await updateDoc(doc(db, 'users', user.uid), {
            displayName: next.displayName.slice(0, 120),
            companyName: next.companyName.slice(0, 160),
            economicCode: (next.economicCode || '').slice(0, 32),
            nationalId: (next.nationalId || '').slice(0, 32),
            fiscalYear: next.fiscalYear.slice(0, 16),
            currencyUnit: next.currencyUnit,
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.UPDATE, path);
        }
      }
      showToast('مشخصات شرکتی و سال مالی ذخیره شد.');
    },
    [profile, user, showToast]
  );

  const setCurrencyUnit = useCallback(
    async (unit: CurrencyUnit) => {
      await updateCompanyProfile({ currencyUnit: unit });
    },
    [updateCompanyProfile]
  );

  // ---------------- ACCOUNTS CRUD ----------------
  const addAccount = useCallback(
    async (acc: Omit<Account, 'id' | 'ownerId'>) => {
      const id = generateSafeId('acc');
      const full: Account = { ...acc, id, ownerId };
      if (user) {
        try {
          await setDoc(doc(db, 'accounts', id), {
            ownerId,
            code: acc.code.replace(/\D/g, '').slice(0, 24),
            title: acc.title.trim().slice(0, 160),
            level: acc.level,
            ...(acc.parentCode ? { parentCode: acc.parentCode.slice(0, 24) } : {}),
            category: acc.category,
            nature: acc.nature,
            isSystem: false,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.CREATE, `accounts/${id}`);
        }
      } else {
        setAccounts((prev) => [...prev, full]);
      }
      showToast(`حساب «${acc.title}» با کد ${acc.code} در کدینگ ثبت شد.`);
    },
    [ownerId, user, showToast]
  );

  const updateAccount = useCallback(
    async (
      accountId: string,
      patch: Partial<Pick<Account, 'title' | 'parentCode' | 'category' | 'nature'>>
    ) => {
      const existing = accounts.find((a) => a.id === accountId);
      if (!existing) return;
      const updatePayload: Record<string, unknown> = { updatedAt: serverTimestamp() };
      if (patch.title !== undefined) updatePayload.title = patch.title.trim().slice(0, 160);
      if (patch.parentCode !== undefined) updatePayload.parentCode = patch.parentCode.slice(0, 24);
      if (patch.category !== undefined) updatePayload.category = patch.category;
      if (patch.nature !== undefined) updatePayload.nature = patch.nature;

      if (user) {
        try {
          await updateDoc(doc(db, 'accounts', accountId), updatePayload);
        } catch (err) {
          handleFirestoreError(err, OperationType.UPDATE, `accounts/${accountId}`);
        }
      } else {
        setAccounts((prev) =>
          prev.map((a) => (a.id === accountId ? { ...a, ...patch } : a))
        );
      }
      showToast(`حساب «${patch.title ?? existing.title}» ویرایش شد.`);
    },
    [accounts, user, showToast]
  );

  const deleteAccount = useCallback(
    async (accountId: string): Promise<boolean> => {
      const acc = accounts.find((a) => a.id === accountId);
      if (!acc) return false;
      if (acc.isSystem) {
        showToast('حساب‌های سیستمی استاندارد هلو قابل حذف نیستند (فقط قابل ویرایش عنوان هستند).');
        return false;
      }
      const hasLines = vouchers.some((v) => v.lines.some((l) => l.accountCode === acc.code));
      if (hasLines) {
        showToast('این حساب دارای گردش در اسناد حسابداری است و طبق اصول حسابرسی قابل حذف نیست.');
        return false;
      }
      if (user) {
        try {
          await deleteDoc(doc(db, 'accounts', accountId));
        } catch (err) {
          handleFirestoreError(err, OperationType.DELETE, `accounts/${accountId}`);
        }
      } else {
        setAccounts((prev) => prev.filter((a) => a.id !== accountId));
      }
      showToast(`حساب «${acc.title}» از کدینگ حذف شد.`);
      return true;
    },
    [accounts, vouchers, user, showToast]
  );

  // ---------------- PARTIES CRUD ----------------
  const addParty = useCallback(
    async (party: Omit<Party, 'id' | 'ownerId'>) => {
      const id = generateSafeId('pty');
      const full: Party = { ...party, id, ownerId };
      if (user) {
        try {
          await setDoc(doc(db, 'parties', id), {
            ownerId,
            code: party.code.slice(0, 32),
            name: party.name.trim().slice(0, 160),
            partyType: party.partyType,
            ...(party.nationalId ? { nationalId: party.nationalId.slice(0, 32) } : {}),
            ...(party.economicCode ? { economicCode: party.economicCode.slice(0, 32) } : {}),
            ...(party.phone ? { phone: party.phone.slice(0, 32) } : {}),
            ...(party.address ? { address: party.address.slice(0, 300) } : {}),
            creditLimit: Math.max(0, Number(party.creditLimit) || 0),
            openingBalance: Number(party.openingBalance) || 0,
            accountCode: party.accountCode.slice(0, 24),
            ...(party.commissionRate !== undefined
              ? { commissionRate: Math.min(100, Math.max(0, Number(party.commissionRate))) }
              : {}),
            ...(party.pricingTier ? { pricingTier: party.pricingTier } : {}),
            ...(party.tierDiscountPct !== undefined
              ? { tierDiscountPct: Number(party.tierDiscountPct) || 0 }
              : {}),
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.CREATE, `parties/${id}`);
        }
      } else {
        setParties((prev) => [full, ...prev]);
      }
      showToast(`طرف‌حساب «${party.name}» با موفقیت تعریف شد.`);
    },
    [ownerId, user, showToast]
  );

  const updateParty = useCallback(
    async (partyId: string, patch: Partial<Omit<Party, 'id' | 'ownerId' | 'code'>>) => {
      const existing = parties.find((p) => p.id === partyId);
      if (!existing) return;
      const expectedVersion = existing._version ?? 1;
      if (user) {
        try {
          const payload: Record<string, unknown> = {
            _version: expectedVersion + 1,
            updatedByDevice: deviceId.slice(0, 64),
            updatedAt: serverTimestamp(),
          };
          if (patch.name !== undefined) payload.name = patch.name.trim().slice(0, 160);
          if (patch.partyType !== undefined) payload.partyType = patch.partyType;
          if (patch.nationalId !== undefined) payload.nationalId = patch.nationalId.slice(0, 32);
          if (patch.economicCode !== undefined) payload.economicCode = patch.economicCode.slice(0, 32);
          if (patch.phone !== undefined) payload.phone = patch.phone.slice(0, 32);
          if (patch.address !== undefined) payload.address = patch.address.slice(0, 300);
          if (patch.creditLimit !== undefined) payload.creditLimit = Math.max(0, Number(patch.creditLimit) || 0);
          if (patch.openingBalance !== undefined) payload.openingBalance = Number(patch.openingBalance) || 0;
          if (patch.accountCode !== undefined) payload.accountCode = patch.accountCode.slice(0, 24);
          if (patch.commissionRate !== undefined) {
            payload.commissionRate = Math.min(100, Math.max(0, Number(patch.commissionRate) || 0));
          }
          if (patch.pricingTier !== undefined) payload.pricingTier = patch.pricingTier;
          if (patch.tierDiscountPct !== undefined) {
            payload.tierDiscountPct = Math.min(50, Math.max(0, Number(patch.tierDiscountPct) || 0));
          }
          const ref = doc(db, 'parties', partyId);
          const isOfflineNow = typeof navigator !== 'undefined' && !navigator.onLine;
          if (isOfflineNow) {
            await updateDoc(ref, payload);
          } else {
            const outcome = await runTransaction(db, async (tx) => {
              const snap = await tx.get(ref);
              if (!snap.exists()) return 'missing' as const;
              const liveVer = Number(snap.data()._version) || 1;
              if (liveVer !== expectedVersion) return 'conflict' as const;
              tx.update(ref, payload);
              return 'ok' as const;
            });
            if (outcome === 'conflict') {
              showToast('تداخل همزمانی! اطلاعات این طرف‌حساب لحظاتی قبل توسط دستگاه دیگری تغییر یافته است. نسخه جدید بارگذاری شد.');
              return;
            }
          }
        } catch (err) {
          if (isFirestoreOfflineError(err)) {
            await updateDoc(doc(db, 'parties', partyId), {
              ...(patch.name !== undefined ? { name: patch.name.trim().slice(0, 160) } : {}),
              _version: expectedVersion + 1,
              updatedByDevice: deviceId.slice(0, 64),
              updatedAt: serverTimestamp(),
            }).catch(() => {});
          } else {
            handleFirestoreError(err, OperationType.UPDATE, `parties/${partyId}`);
          }
        }
      } else {
        setParties((prev) =>
          prev.map((p) =>
            p.id === partyId
              ? { ...p, ...patch, _version: expectedVersion + 1, updatedByDevice: deviceId }
              : p
          )
        );
      }
      showToast(`اطلاعات طرف‌حساب «${patch.name ?? existing.name}» به‌روزرسانی شد.`);
    },
    [parties, user, deviceId, showToast]
  );

  const deleteParty = useCallback(
    async (partyId: string): Promise<boolean> => {
      const party = parties.find((p) => p.id === partyId);
      if (!party) return false;
      const usedInVoucher = vouchers.some((v) => v.lines.some((l) => l.partyId === partyId));
      const usedInInvoice = invoices.some((i) => i.partyId === partyId);
      if (usedInVoucher || usedInInvoice) {
        showToast('این طرف‌حساب دارای سابقه سند یا فاکتور است و جهت حفظ یکپارچگی دفاتر قابل حذف نیست.');
        return false;
      }
      if (user) {
        try {
          await deleteDoc(doc(db, 'parties', partyId));
        } catch (err) {
          handleFirestoreError(err, OperationType.DELETE, `parties/${partyId}`);
        }
      } else {
        setParties((prev) => prev.filter((p) => p.id !== partyId));
      }
      showToast(`طرف‌حساب «${party.name}» حذف شد.`);
      return true;
    },
    [parties, vouchers, invoices, user, showToast]
  );

  // ---------------- VOUCHERS CRUD & AUDIT OPS ----------------
  const createVoucher = useCallback(
    async (payload: {
      date: string;
      description: string;
      voucherType: VoucherType;
      status: VoucherStatus;
      lines: VoucherLine[];
      referenceId?: string;
      reversalOfVoucherId?: string;
      allowDuplicate?: boolean;
      currencyCode?: string;
      exchangeRate?: number;
    }): Promise<Voucher> => {
      const validation = validateVoucherPayload({
        payload,
        accounts,
        parties,
        existingVouchers: vouchers,
        closedFiscalYears: profile.closedFiscalYears,
        allowDuplicate: payload.allowDuplicate,
        isReversal: Boolean(payload.reversalOfVoucherId),
      });
      if (!validation.valid) {
        const msg = validation.errors[0] || 'سند حسابداری معتبر نیست.';
        showToast(msg, 'error');
        throw new Error(msg);
      }

      const { sanitizedLines, totalDebit, totalCredit, fiscalYear: voucherFy } = validation;
      const sameYearMax = vouchers
        .filter((v) => (v.fiscalYear || extractFiscalYearFromDate(v.date)) === voucherFy)
        .reduce((max, v) => Math.max(max, v.voucherNumber || 0), 0);
      const nextNumber = await reserveNextVoucherNumber(voucherFy, sameYearMax);
      const id = generateSafeId('vch');

      const normCode = normalizeCurrencyCode(payload.currencyCode);
      const isFx = isForeignCurrency(normCode) && Number(payload.exchangeRate) > 0;
      const safeRate = isFx ? Number(payload.exchangeRate) : undefined;
      const cleanLines = sanitizedLines.slice(0, 100);
      const foreignTotalDebit = isFx
        ? roundCurrency(
            cleanLines.reduce((s, l) => s + (Number(l.foreignDebit) || 0), 0),
            2
          )
        : undefined;
      const foreignTotalCredit = isFx
        ? roundCurrency(
            cleanLines.reduce((s, l) => s + (Number(l.foreignCredit) || 0), 0),
            2
          )
        : undefined;

      const baseFull: Voucher = {
        id,
        ownerId,
        voucherNumber: nextNumber,
        date: payload.date,
        fiscalYear: voucherFy,
        description: payload.description.trim().slice(0, 300),
        voucherType: payload.voucherType,
        status: payload.status,
        totalDebit,
        totalCredit,
        ...(isFx
          ? {
              currencyCode: normCode,
              exchangeRate: safeRate,
              foreignTotalDebit,
              foreignTotalCredit,
            }
          : {}),
        referenceId: payload.referenceId,
        ...(payload.reversalOfVoucherId ? { reversalOfVoucherId: payload.reversalOfVoucherId } : {}),
        lines: cleanLines,
        _version: 1,
        updatedByDevice: deviceId,
      };
      const full: Voucher =
        baseFull.status === 'permanent'
          ? { ...baseFull, integrityHash: computeVoucherIntegrityHash(baseFull) }
          : baseFull;

      if (user) {
        try {
          await setDoc(doc(db, 'vouchers', id), {
            ownerId,
            voucherNumber: nextNumber,
            date: full.date.slice(0, 20),
            description: full.description,
            voucherType: full.voucherType,
            status: full.status,
            totalDebit,
            totalCredit,
            ...(isFx && safeRate
              ? {
                  currencyCode: normCode.slice(0, 10),
                  exchangeRate: safeRate,
                  foreignTotalDebit: foreignTotalDebit ?? 0,
                  foreignTotalCredit: foreignTotalCredit ?? 0,
                }
              : {}),
            ...(full.referenceId ? { referenceId: full.referenceId.slice(0, 128) } : {}),
            ...(full.integrityHash ? { integrityHash: full.integrityHash } : {}),
            lines: full.lines,
            _version: 1,
            updatedByDevice: deviceId.slice(0, 64),
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.CREATE, `vouchers/${id}`);
        }
      } else {
        setVouchers((prev) => [...prev, full]);
      }
      showToast(
        isFx
          ? `سند ارزی شماره ${nextNumber} (${normCode}) با موفقیت ثبت شد.`
          : `سند حسابداری شماره ${nextNumber} با موفقیت ثبت شد.`
      );
      return full;
    },
    [
      accounts,
      parties,
      vouchers,
      profile.closedFiscalYears,
      profile.fiscalYear,
      ownerId,
      user,
      deviceId,
      reserveNextVoucherNumber,
      showToast,
    ]
  );

  const updateVoucher = useCallback(
    async (
      voucherId: string,
      payload: {
        date: string;
        description: string;
        voucherType: VoucherType;
        status: VoucherStatus;
        lines: VoucherLine[];
        currencyCode?: string;
        exchangeRate?: number;
      }
    ) => {
      const existing = vouchers.find((v) => v.id === voucherId);
      if (!existing) return;
      if (existing.status === 'permanent') {
        showToast(
          'اسناد دائم طبق قانون دفاتر قابل ویرایش مستقیم نیستند؛ از دکمه «صدور سند اصلاحی/معکوس» استفاده کنید.',
          'error'
        );
        return;
      }
      const existingFy = existing.fiscalYear || extractFiscalYearFromDate(existing.date);
      if (existingFy && profile.closedFiscalYears?.includes(existingFy)) {
        showToast(`سال مالی ${existingFy} بسته شده است و امکان ویرایش سند در آن وجود ندارد.`, 'error');
        return;
      }
      const validation = validateVoucherPayload({
        payload,
        accounts,
        parties,
        existingVouchers: vouchers,
        closedFiscalYears: profile.closedFiscalYears,
        ignoreVoucherId: voucherId,
      });
      if (!validation.valid) {
        showToast(validation.errors[0] || 'سند حسابداری معتبر نیست.', 'error');
        return;
      }

      const { sanitizedLines, totalDebit, totalCredit, fiscalYear: voucherFy } = validation;
      const cleanDesc = payload.description.trim().slice(0, 300);
      const cleanLines = sanitizedLines.slice(0, 100);
      const normCode = normalizeCurrencyCode(payload.currencyCode);
      const isFx = isForeignCurrency(normCode) && Number(payload.exchangeRate) > 0;
      const safeRate = isFx ? Number(payload.exchangeRate) : 1;
      const foreignTotalDebit = isFx
        ? roundCurrency(
            cleanLines.reduce((s, l) => s + (Number(l.foreignDebit) || 0), 0),
            2
          )
        : 0;
      const foreignTotalCredit = isFx
        ? roundCurrency(
            cleanLines.reduce((s, l) => s + (Number(l.foreignCredit) || 0), 0),
            2
          )
        : 0;
      const expectedVersion = existing._version ?? 1;
      const nextHash =
        payload.status === 'permanent'
          ? computeVoucherIntegrityHash({
              voucherNumber: existing.voucherNumber,
              date: payload.date,
              voucherType: payload.voucherType,
              totalDebit,
              totalCredit,
              lines: cleanLines,
            })
          : undefined;

      if (user) {
        try {
          const ref = doc(db, 'vouchers', voucherId);
          const updateFields = {
            date: payload.date.slice(0, 20),
            description: cleanDesc,
            voucherType: payload.voucherType,
            status: payload.status,
            lines: cleanLines,
            totalDebit,
            totalCredit,
            currencyCode: isFx ? normCode.slice(0, 10) : BASE_CURRENCY_CODE,
            exchangeRate: safeRate,
            foreignTotalDebit,
            foreignTotalCredit,
            ...(nextHash ? { integrityHash: nextHash } : {}),
            _version: expectedVersion + 1,
            updatedByDevice: deviceId.slice(0, 64),
            updatedAt: serverTimestamp(),
          };
          const isOfflineNow = typeof navigator !== 'undefined' && !navigator.onLine;
          if (isOfflineNow) {
            await updateDoc(ref, updateFields);
          } else {
            const outcome = await runTransaction(db, async (tx) => {
              const snap = await tx.get(ref);
              if (!snap.exists()) return 'missing' as const;
              const live = snap.data();
              if (live.status === 'permanent') return 'permanent' as const;
              const liveVer = Number(live._version) || 1;
              if (liveVer !== expectedVersion) return 'conflict' as const;
              tx.update(ref, updateFields);
              return 'ok' as const;
            });
            if (outcome === 'permanent') {
              showToast('این سند لحظاتی قبل توسط دستگاه دیگری «دائم» شده و دیگر قابل ویرایش نیست.', 'warning');
              return;
            }
            if (outcome === 'conflict') {
              showToast(
                'تداخل همزمانی! این سند توسط دستگاه دیگری ویرایش شده است. لطفاً نسخه جدید را بررسی و مجدداً ذخیره کنید.',
                'warning'
              );
              return;
            }
          }
        } catch (err) {
          if (isFirestoreOfflineError(err)) {
            await updateDoc(doc(db, 'vouchers', voucherId), {
              date: payload.date.slice(0, 20),
              description: cleanDesc,
              voucherType: payload.voucherType,
              status: payload.status,
              lines: cleanLines,
              totalDebit,
              totalCredit,
              currencyCode: isFx ? normCode.slice(0, 10) : BASE_CURRENCY_CODE,
              exchangeRate: safeRate,
              foreignTotalDebit,
              foreignTotalCredit,
              ...(nextHash ? { integrityHash: nextHash } : {}),
              _version: expectedVersion + 1,
              updatedByDevice: deviceId.slice(0, 64),
              updatedAt: serverTimestamp(),
            }).catch(() => {});
          } else {
            handleFirestoreError(err, OperationType.UPDATE, `vouchers/${voucherId}`);
          }
        }
      } else {
        setVouchers((prev) =>
          prev.map((v) =>
            v.id === voucherId
              ? {
                  ...v,
                  date: payload.date,
                  fiscalYear: voucherFy,
                  description: cleanDesc,
                  voucherType: payload.voucherType,
                  status: payload.status,
                  lines: cleanLines,
                  totalDebit,
                  totalCredit,
                  currencyCode: isFx ? normCode : undefined,
                  exchangeRate: isFx ? safeRate : undefined,
                  foreignTotalDebit: isFx ? foreignTotalDebit : undefined,
                  foreignTotalCredit: isFx ? foreignTotalCredit : undefined,
                  ...(nextHash ? { integrityHash: nextHash } : {}),
                  _version: expectedVersion + 1,
                  updatedByDevice: deviceId,
                }
              : v
          )
        );
      }
      showToast(`سند موقت شماره ${existing.voucherNumber} با موفقیت اصلاح شد.`);
    },
    [accounts, parties, vouchers, profile.closedFiscalYears, user, deviceId, showToast]
  );

  const deleteVoucher = useCallback(
    async (voucherId: string): Promise<boolean> => {
      const existing = vouchers.find((v) => v.id === voucherId);
      if (!existing) return false;
      if (existing.status === 'permanent') {
        showToast('حذف سند دائم مجاز نیست! برای ابطال اثر سند دائم، «سند معکوس» صادر کنید.', 'error');
        return false;
      }
      const existingFy = existing.fiscalYear || extractFiscalYearFromDate(existing.date);
      if (existingFy && profile.closedFiscalYears?.includes(existingFy)) {
        showToast(`سال مالی ${existingFy} بسته شده است و امکان حذف سند در آن وجود ندارد.`, 'error');
        return false;
      }
      if (user) {
        try {
          await deleteDoc(doc(db, 'vouchers', voucherId));
        } catch (err) {
          handleFirestoreError(err, OperationType.DELETE, `vouchers/${voucherId}`);
        }
      } else {
        setVouchers((prev) => prev.filter((v) => v.id !== voucherId));
      }
      showToast(`سند موقت شماره ${existing.voucherNumber} حذف شد.`);
      return true;
    },
    [vouchers, profile.closedFiscalYears, user, showToast]
  );

  const finalizeVoucher = useCallback(
    async (voucherId: string) => {
      const target = vouchers.find((v) => v.id === voucherId);
      if (!target) return;
      const fy = target.fiscalYear || extractFiscalYearFromDate(target.date);
      if (fy && profile.closedFiscalYears?.includes(fy)) {
        showToast(`سال مالی ${fy} بسته شده است و امکان تغییر وضعیت سند وجود ندارد.`, 'error');
        return;
      }
      const integrityHash = computeVoucherIntegrityHash(target);
      if (user) {
        try {
          await updateDoc(doc(db, 'vouchers', voucherId), {
            status: 'permanent',
            integrityHash,
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.UPDATE, `vouchers/${voucherId}`);
        }
      } else {
        setVouchers((prev) =>
          prev.map((v) =>
            v.id === voucherId
              ? { ...v, status: 'permanent', integrityHash }
              : v
          )
        );
      }
      showToast('سند حسابداری به وضعیت «دائم و قطعی» تبدیل و مُهر اصالت ثبت شد.');
    },
    [vouchers, profile.closedFiscalYears, user, showToast]
  );

  const createReversingVoucher = useCallback(
    async (voucherId: string): Promise<Voucher | null> => {
      const orig = vouchers.find((v) => v.id === voucherId);
      if (!orig) return null;
      const reversedLines: VoucherLine[] = orig.lines.map((l) => ({
        ...l,
        description: `برگشت/اصلاح سند #${orig.voucherNumber}: ${l.description}`,
        debit: l.credit,
        credit: l.debit,
        ...(l.foreignCredit !== undefined ? { foreignDebit: l.foreignCredit } : { foreignDebit: undefined }),
        ...(l.foreignDebit !== undefined ? { foreignCredit: l.foreignDebit } : { foreignCredit: undefined }),
      }));
      return createVoucher({
        date: getTodayShamsi(),
        description: `سند معکوس و اصلاحی بابت ابطال اثر سند شماره ${orig.voucherNumber} (${orig.date})`,
        voucherType: 'general',
        status: 'draft',
        lines: reversedLines,
        referenceId: orig.id,
        reversalOfVoucherId: orig.id,
        allowDuplicate: true,
        ...(isForeignCurrency(orig.currencyCode) && orig.exchangeRate
          ? { currencyCode: orig.currencyCode, exchangeRate: orig.exchangeRate }
          : {}),
      });
    },
    [vouchers, createVoucher]
  );

  const renumberVouchersChronologically = useCallback(async () => {
    const rank = (t: VoucherType) => (t === 'opening' ? 0 : t === 'closing' ? 2 : 1);
    const closedSet = new Set(profile.closedFiscalYears || []);
    const byYear = new Map<string, Voucher[]>();
    for (const v of vouchers) {
      const yr = v.fiscalYear || extractFiscalYearFromDate(v.date) || profile.fiscalYear;
      const list = byYear.get(yr) || [];
      list.push(v);
      byYear.set(yr, list);
    }

    const numMap = new Map<string, number>();
    for (const [yr, list] of byYear.entries()) {
      if (closedSet.has(yr)) {
        list.forEach((v) => numMap.set(v.id, v.voucherNumber));
        continue;
      }
      const ordered = [...list].sort((a, b) => {
        const rDiff = rank(a.voucherType) - rank(b.voucherType);
        if (rDiff !== 0) return rDiff;
        const dateDiff = a.date.localeCompare(b.date);
        if (dateDiff !== 0) return dateDiff;
        return a.voucherNumber - b.voucherNumber;
      });
      ordered.forEach((v, idx) => numMap.set(v.id, idx + 1));
    }

    if (user) {
      try {
        const batch = writeBatch(db);
        vouchers.forEach((v) => {
          const nextNum = numMap.get(v.id) ?? v.voucherNumber;
          if (v.voucherNumber !== nextNum) {
            batch.update(doc(db, 'vouchers', v.id), {
              voucherNumber: nextNum,
              updatedAt: serverTimestamp(),
            });
          }
        });
        await batch.commit();
      } catch (err) {
        handleFirestoreError(err, OperationType.UPDATE, 'vouchers');
      }
    } else {
      setVouchers((prev) =>
        prev.map((v) => {
          const nextNum = numMap.get(v.id) ?? v.voucherNumber;
          if (nextNum === v.voucherNumber) return v;
          const updated = { ...v, voucherNumber: nextNum };
          return updated.status === 'permanent' && updated.integrityHash
            ? { ...updated, integrityHash: computeVoucherIntegrityHash(updated) }
            : updated;
        })
      );
    }
    showToast('تمامی اسناد سال‌های مالی باز بر اساس تاریخ شمسی و به تفکیک سال مالی شماره‌گذاری مجدد شدند.');
  }, [vouchers, profile.closedFiscalYears, profile.fiscalYear, user, showToast]);

  // ---------------- PRODUCTS & WAREHOUSE CRUD ----------------
  const addProduct = useCallback(
    async (product: Omit<Product, 'id' | 'ownerId'>) => {
      const id = generateSafeId('prd');
      const full: Product = { ...product, id, ownerId };
      if (user) {
        try {
          await setDoc(doc(db, 'products', id), {
            ownerId,
            sku: product.sku.slice(0, 48),
            name: product.name.trim().slice(0, 180),
            category: product.category.slice(0, 80),
            warehouse: product.warehouse.slice(0, 80),
            unit: product.unit.slice(0, 32),
            ...(product.secondaryUnit ? { secondaryUnit: product.secondaryUnit.trim().slice(0, 32) } : {}),
            ...(product.kgPerCarton && Number(product.kgPerCarton) > 0
              ? { kgPerCarton: Math.min(10000, Number(product.kgPerCarton)) }
              : {}),
            ...(product.bobbinUnit ? { bobbinUnit: product.bobbinUnit.trim().slice(0, 32) } : {}),
            ...(product.bobbinsPerCarton !== undefined && Number(product.bobbinsPerCarton) >= 0
              ? { bobbinsPerCarton: Math.min(10000, Number(product.bobbinsPerCarton)) }
              : {}),
            ...(product.yarnCount ? { yarnCount: product.yarnCount.trim().slice(0, 48) } : {}),
            ...(product.lotNumber ? { lotNumber: product.lotNumber.trim().slice(0, 48) } : {}),
            ...(product.originCountry ? { originCountry: product.originCountry.trim().slice(0, 64) } : {}),
            buyPrice: Math.max(0, Number(product.buyPrice) || 0),
            sellPrice: Math.max(0, Number(product.sellPrice) || 0),
            stock: Number((Number(product.stock) || 0).toFixed(2)),
            reorderPoint: Math.max(0, Number(product.reorderPoint) || 0),
            vatExempt: Boolean(product.vatExempt),
            ...(product.costingMethod ? { costingMethod: product.costingMethod } : {}),
            ...(Array.isArray(product.costLayers) ? { costLayers: product.costLayers } : {}),
            ...(typeof product.inventoryValueIrr === 'number' && Number.isFinite(product.inventoryValueIrr)
              ? { inventoryValueIrr: Math.max(0, Math.round(product.inventoryValueIrr)) }
              : {}),
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.CREATE, `products/${id}`);
        }
      } else {
        setProducts((prev) => [full, ...prev]);
      }
      showToast(`نخ/کالای «${product.name}» با موفقیت در انبار ثبت شد.`);
    },
    [ownerId, user, showToast]
  );

  const updateProduct = useCallback(
    async (productId: string, patch: Partial<Omit<Product, 'id' | 'ownerId' | 'sku'>>) => {
      const existing = products.find((p) => p.id === productId);
      if (!existing) return;
      if (user) {
        try {
          const payload: Record<string, unknown> = { updatedAt: serverTimestamp() };
          if (patch.name !== undefined) payload.name = patch.name.trim().slice(0, 180);
          if (patch.category !== undefined) payload.category = patch.category.slice(0, 80);
          if (patch.warehouse !== undefined) payload.warehouse = patch.warehouse.slice(0, 80);
          if (patch.unit !== undefined) payload.unit = patch.unit.slice(0, 32);
          if (patch.secondaryUnit !== undefined) payload.secondaryUnit = patch.secondaryUnit.trim().slice(0, 32);
          if (patch.kgPerCarton !== undefined && Number(patch.kgPerCarton) > 0) {
            payload.kgPerCarton = Math.min(10000, Number(patch.kgPerCarton));
          }
          if (patch.bobbinUnit !== undefined) payload.bobbinUnit = patch.bobbinUnit.trim().slice(0, 32);
          if (patch.bobbinsPerCarton !== undefined && Number(patch.bobbinsPerCarton) >= 0) {
            payload.bobbinsPerCarton = Math.min(10000, Number(patch.bobbinsPerCarton));
          }
          if (patch.yarnCount !== undefined) payload.yarnCount = patch.yarnCount.trim().slice(0, 48);
          if (patch.lotNumber !== undefined) payload.lotNumber = patch.lotNumber.trim().slice(0, 48);
          if (patch.originCountry !== undefined) payload.originCountry = patch.originCountry.trim().slice(0, 64);
          if (patch.buyPrice !== undefined) payload.buyPrice = Math.max(0, Number(patch.buyPrice) || 0);
          if (patch.sellPrice !== undefined) payload.sellPrice = Math.max(0, Number(patch.sellPrice) || 0);
          if (patch.stock !== undefined) payload.stock = Number((Number(patch.stock) || 0).toFixed(2));
          if (patch.reorderPoint !== undefined) payload.reorderPoint = Math.max(0, Number(patch.reorderPoint) || 0);
          if (patch.vatExempt !== undefined) payload.vatExempt = Boolean(patch.vatExempt);
          if (patch.costingMethod !== undefined) payload.costingMethod = patch.costingMethod;
          if (patch.costLayers !== undefined) payload.costLayers = patch.costLayers;
          if (patch.inventoryValueIrr !== undefined && Number.isFinite(patch.inventoryValueIrr)) {
            payload.inventoryValueIrr = Math.max(0, Math.round(patch.inventoryValueIrr));
          }
          await updateDoc(doc(db, 'products', productId), payload);
        } catch (err) {
          handleFirestoreError(err, OperationType.UPDATE, `products/${productId}`);
        }
      } else {
        setProducts((prev) => prev.map((p) => (p.id === productId ? { ...p, ...patch } : p)));
      }
      showToast(`مشخصات نخ/کالا «${patch.name ?? existing.name}» ویرایش شد.`);
    },
    [products, user, showToast]
  );

  const deleteProduct = useCallback(
    async (productId: string): Promise<boolean> => {
      const prod = products.find((p) => p.id === productId);
      if (!prod) return false;
      const used = invoices.some((i) => i.items.some((it) => it.productId === productId));
      if (used) {
        showToast('این کالا دارای گردش در فاکتورها است و قابل حذف نیست.');
        return false;
      }
      if (user) {
        try {
          await deleteDoc(doc(db, 'products', productId));
        } catch (err) {
          handleFirestoreError(err, OperationType.DELETE, `products/${productId}`);
        }
      } else {
        setProducts((prev) => prev.filter((p) => p.id !== productId));
      }
      showToast(`کالا «${prod.name}» از انبار حذف شد.`);
      return true;
    },
    [products, invoices, user, showToast]
  );

  const adjustProductStock = useCallback(
    async (productId: string, newStock: number) => {
      if (user) {
        try {
          await updateDoc(doc(db, 'products', productId), {
            stock: Number(newStock),
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.UPDATE, `products/${productId}`);
        }
      } else {
        setProducts((prev) =>
          prev.map((p) => (p.id === productId ? { ...p, stock: Number(newStock) } : p))
        );
      }
    },
    [user]
  );

  const commitStockAdjustmentBatch = useCallback(
    async (
      entries: { productId: string; countedStock: number }[],
      reason: string,
      referenceId: string
    ): Promise<number> => {
      if (entries.length === 0) return 0;
      if (entries.length > 50) {
        throw new Error('هر نوبت انبارگردانی حداکثر می‌تواند ۵۰ قلم کالا داشته باشد تا تعداد آرتیکل‌های سند از سقف مجاز پایگاه داده بیشتر نشود.');
      }
      const productIds = entries.map((entry) => entry.productId);
      if (new Set(productIds).size !== productIds.length) {
        throw new Error('در یک عملیات انبارگردانی، هر کالا باید فقط یک‌بار وارد شود.');
      }

      const date = getTodayShamsi();
      const fiscalYear = extractFiscalYearFromDate(date) || profile.fiscalYear;
      const localMaxVoucherNumber = vouchers
        .filter((v) => (v.fiscalYear || extractFiscalYearFromDate(v.date)) === fiscalYear)
        .reduce((max, v) => Math.max(max, v.voucherNumber || 0), 0);
      const voucherId = generateSafeId('vch');

      const buildPlans = (sourceProducts: Product[], nextVoucherNumber: number) => {
        const productMap = new Map(sourceProducts.map((product) => [product.id, product]));
        const plans: ReturnType<typeof planStockAdjustmentWithCostLayers>[] = [];
        for (const entry of entries) {
          const product = productMap.get(entry.productId);
          if (!product) throw new Error(`کالای ${entry.productId} در اطلاعات معتبر انبار پیدا نشد.`);
          plans.push(
            planStockAdjustmentWithCostLayers({
              product,
              newStock: entry.countedStock,
              date,
              reason,
              costingMethod: profile.defaultCostingMethod ?? 'fifo',
              allowNegativeStock: false,
              closedFiscalYears: profile.closedFiscalYears ?? [],
              accounts,
              ownerId,
              referenceId: `${referenceId}_${product.id}`,
              voucherId,
              nextVoucherNumber,
              deviceId,
            })
          );
        }
        return plans.filter((plan) => Math.abs(plan.diffQty) >= 0.001);
      };

      const buildVoucher = (
        plans: ReturnType<typeof planStockAdjustmentWithCostLayers>[],
        nextVoucherNumber: number
      ): Voucher | undefined => {
        const lines = plans.flatMap((plan) => plan.voucher?.lines ?? []);
        if (lines.length === 0) return undefined;
        const totalDebit = lines.reduce((sum, line) => sum + Math.max(0, Math.round(Number(line.debit) || 0)), 0);
        const totalCredit = lines.reduce((sum, line) => sum + Math.max(0, Math.round(Number(line.credit) || 0)), 0);
        if (totalDebit <= 0 || totalDebit !== totalCredit) {
          throw new Error('سند تجمیعی انبارگردانی تراز نیست؛ هیچ تغییری در موجودی ذخیره نشد.');
        }
        const baseVoucher: Voucher = {
          id: voucherId,
          ownerId,
          voucherNumber: nextVoucherNumber,
          date,
          fiscalYear,
          description: `سند تجمیعی انبارگردانی (${plans.length} قلم کالا) — ${reason || 'اصلاح موجودی فیزیکی'}`,
          voucherType: 'general',
          status: 'permanent',
          totalDebit,
          totalCredit,
          referenceId,
          lines,
          _version: 1,
          updatedByDevice: deviceId,
        };
        return { ...baseVoucher, integrityHash: computeVoucherIntegrityHash(baseVoucher) };
      };

      try {
        if (user) {
          if (typeof navigator !== 'undefined' && !navigator.onLine) {
            throw new Error('برای جلوگیری از مغایرت موجودی و دفتر کل، انبارگردانی مالی در حالت آفلاین مجاز نیست.');
          }
          const committed = await runTransaction(db, async (tx) => {
            const counterRef = doc(db, 'counters', user.uid);
            const counterSnap = await tx.get(counterRef);
            const counterData = counterSnap.exists() ? counterSnap.data() : {};
            const yearCounters =
              counterData.voucherNumbersByFiscalYear &&
              typeof counterData.voucherNumbersByFiscalYear === 'object'
                ? counterData.voucherNumbersByFiscalYear as Record<string, number>
                : {};

            const liveProducts: Product[] = [];
            for (const productId of productIds) {
              const productRef = doc(db, 'products', productId);
              const productSnap = await tx.get(productRef);
              if (!productSnap.exists()) {
                throw new Error(`کالا با شناسه ${productId} در سرور وجود ندارد؛ انبارگردانی لغو شد.`);
              }
              const cachedProduct = products.find((product) => product.id === productId);
              if (!cachedProduct) {
                throw new Error(`اطلاعات پایه کالای ${productId} در حافظه برنامه موجود نیست.`);
              }
              const data = productSnap.data();
              liveProducts.push({
                ...cachedProduct,
                stock: Number(data.stock) || 0,
                buyPrice: Number(data.buyPrice) || 0,
                ...(data.costingMethod ? { costingMethod: data.costingMethod } : {}),
                ...(Array.isArray(data.costLayers) ? { costLayers: data.costLayers } : {}),
                ...(typeof data.inventoryValueIrr === 'number' ? { inventoryValueIrr: data.inventoryValueIrr } : {}),
                _version: Number(data._version) || 1,
              });
            }

            const nextVoucherNumber = getNextFiscalYearVoucherNumber(
              fiscalYear,
              yearCounters,
              localMaxVoucherNumber
            );
            const plans = buildPlans(liveProducts, nextVoucherNumber);
            const updatedProducts = plans.map((plan) => plan.updatedProduct);
            const voucher = buildVoucher(plans, nextVoucherNumber);
            if (updatedProducts.length === 0) {
              return { updatedProducts, voucher: undefined, changedCount: 0 };
            }

            // All reads are complete. Product valuation, voucher and counter are committed together.
            for (const product of updatedProducts) {
              tx.update(doc(db, 'products', product.id), {
                stock: product.stock,
                buyPrice: product.buyPrice,
                ...(product.costingMethod ? { costingMethod: product.costingMethod } : {}),
                ...(product.costLayers ? { costLayers: product.costLayers } : {}),
                ...(typeof product.inventoryValueIrr === 'number' ? { inventoryValueIrr: product.inventoryValueIrr } : {}),
                _version: product._version ?? 2,
                updatedByDevice: deviceId.slice(0, 64),
                updatedAt: serverTimestamp(),
              });
            }

            if (voucher) {
              const nextYearCounters = { ...yearCounters, [fiscalYear]: nextVoucherNumber };
              const globalMax = Math.max(Number(counterData.lastVoucherNumber) || 0, nextVoucherNumber);
              if (!counterSnap.exists()) {
                tx.set(counterRef, {
                  ownerId: user.uid,
                  lastVoucherNumber: globalMax,
                  voucherNumbersByFiscalYear: nextYearCounters,
                  lastInvoiceSeq: 102,
                  updatedByDevice: deviceId.slice(0, 64),
                  createdAt: serverTimestamp(),
                  updatedAt: serverTimestamp(),
                });
              } else {
                tx.update(counterRef, {
                  lastVoucherNumber: globalMax,
                  voucherNumbersByFiscalYear: nextYearCounters,
                  updatedByDevice: deviceId.slice(0, 64),
                  updatedAt: serverTimestamp(),
                });
              }
              tx.set(doc(db, 'vouchers', voucher.id), {
                ownerId,
                voucherNumber: voucher.voucherNumber,
                date: voucher.date,
                description: voucher.description,
                voucherType: voucher.voucherType,
                status: voucher.status,
                totalDebit: voucher.totalDebit,
                totalCredit: voucher.totalCredit,
                referenceId,
                integrityHash: voucher.integrityHash,
                lines: voucher.lines,
                _version: 1,
                updatedByDevice: deviceId.slice(0, 64),
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp(),
              });
            }

            return { updatedProducts, voucher, changedCount: updatedProducts.length };
          });

          if (committed.changedCount === 0) return 0;
          const updatedMap = new Map(committed.updatedProducts.map((product) => [product.id, product]));
          setProducts((previous) => previous.map((product) => updatedMap.get(product.id) ?? product));
          if (committed.voucher) setVouchers((previous) => [committed.voucher!, ...previous]);
          return committed.changedCount;
        }

        const nextVoucherNumber = getNextFiscalYearVoucherNumber(fiscalYear, undefined, localMaxVoucherNumber);
        const plans = buildPlans(products, nextVoucherNumber);
        const updatedProducts = plans.map((plan) => plan.updatedProduct);
        if (updatedProducts.length === 0) return 0;
        const voucher = buildVoucher(plans, nextVoucherNumber);
        const saved = await commitInventoryAdjustmentOperationalTx({ updatedProducts, voucher });
        if (!saved) {
          throw new Error('پایگاه داده محلی در دسترس نیست؛ برای جلوگیری از ثبت ناقص، انبارگردانی ذخیره نشد.');
        }
        const updatedMap = new Map(updatedProducts.map((product) => [product.id, product]));
        setProducts((previous) => previous.map((product) => updatedMap.get(product.id) ?? product));
        if (voucher) setVouchers((previous) => [voucher, ...previous]);
        void getOperationalDbStats().then(setOperationalDbStats).catch(() => {});
        return updatedProducts.length;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'خطا در ثبت اتمیک انبارگردانی.';
        showToast(message, 'error');
        throw err;
      }
    },
    [products, vouchers, user, profile, accounts, ownerId, deviceId, showToast]
  );

  const adjustProductStockWithVoucher = useCallback(
    async (productId: string, countedStock: number, reason: string) => {
      const referenceId = generateSafeId('stk');
      const changedCount = await commitStockAdjustmentBatch(
        [{ productId, countedStock }],
        reason,
        referenceId
      );
      if (changedCount > 0) {
        showToast('انبارگردانی و سند حسابداری با موفقیت و به‌صورت اتمیک ثبت شد.');
      } else {
        showToast('موجودی شمارش‌شده با موجودی سیستمی برابر است؛ نیازی به تعدیل نیست.');
      }
    },
    [commitStockAdjustmentBatch, showToast]
  );

  const bulkStocktakingWithVoucher = useCallback(
    async (items: { productId: string; countedStock: number }[], reason: string) => {
      const referenceId = generateSafeId('stk_bulk');
      const changedCount = await commitStockAdjustmentBatch(items, reason, referenceId);
      if (changedCount > 0) {
        showToast(`انبارگردانی ${changedCount} قلم کالا و سند تجمیعی آن به‌صورت اتمیک ثبت شد.`);
      } else {
        showToast('تغییری در موجودی شمارش‌شده نسبت به سیستم وجود نداشت.');
      }
    },
    [commitStockAdjustmentBatch, showToast]
  );

  const bulkUpdateProductPrices = useCallback(
    async (productIds: string[], target: 'sellPrice' | 'buyPrice', percentDelta: number) => {
      if (productIds.length === 0 || percentDelta === 0) return;
      const factor = 1 + percentDelta / 100;
      let count = 0;
      for (const pid of productIds) {
        const prod = products.find((p) => p.id === pid);
        if (!prod) continue;
        const newVal = Math.max(0, Math.round((prod[target] * factor) / 1000) * 1000);
        await updateProduct(pid, { [target]: newVal });
        count += 1;
      }
      showToast(
        target === 'sellPrice'
          ? `قیمت فروش ${count} کالا با تغییر ${percentDelta > 0 ? '+' : ''}${percentDelta}٪ به‌روزرسانی شد.`
          : `بهای خرید ${count} کالا به‌روزرسانی شد (توجه: تغییر مستقیم بهای خرید بدون سند، تطبیق معین ۱۰۵۰۱ را متأثر می‌کند).`
      );
    },
    [products, updateProduct, showToast]
  );

  const finalizeAllDraftVouchers = useCallback(async (): Promise<number> => {
    const drafts = vouchers.filter((v) => v.status === 'draft');
    if (drafts.length === 0) {
      showToast('هیچ سند موقتی برای دائم‌سازی وجود ندارد.');
      return 0;
    }
    let finalized = 0;
    for (const v of drafts) {
      if (v.totalDebit === v.totalCredit && v.totalDebit > 0 && v.lines.length >= 2) {
        await finalizeVoucher(v.id);
        finalized += 1;
      }
    }
    showToast(`${finalized} سند موقت تراز با موفقیت به دائم تبدیل شد.`);
    return finalized;
  }, [vouchers, finalizeVoucher, showToast]);

  const transferProductWarehouse = useCallback(
    async (productId: string, targetWarehouse: string) => {
      const prod = products.find((p) => p.id === productId);
      if (!prod || !targetWarehouse.trim()) return;
      const cleanWh = targetWarehouse.trim().slice(0, 80);
      if (user) {
        try {
          await updateDoc(doc(db, 'products', productId), {
            warehouse: cleanWh,
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.UPDATE, `products/${productId}`);
        }
      } else {
        setProducts((prev) =>
          prev.map((p) => (p.id === productId ? { ...p, warehouse: cleanWh } : p))
        );
      }
      showToast(`حواله انتقال کالای «${prod.name}» به «${cleanWh}» ثبت شد.`);
    },
    [products, user, showToast]
  );

  // ---------------- CHEQUES & TREASURY ----------------
  const addCheque = useCallback(
    async (payload: Omit<Cheque, 'id' | 'ownerId'>, skipVoucher = false) => {
      const id = generateSafeId('chq');
      const full: Cheque = { ...payload, id, ownerId };

      if (user) {
        try {
          await setDoc(doc(db, 'cheques', id), {
            ownerId,
            sayadiId: full.sayadiId.slice(0, 32),
            serial: full.serial.slice(0, 48),
            direction: full.direction,
            partyId: full.partyId.slice(0, 128),
            partyName: full.partyName.slice(0, 160),
            bankName: full.bankName.slice(0, 100),
            ...(full.branch ? { branch: full.branch.slice(0, 100) } : {}),
            amount: full.amount,
            issueDate: full.issueDate.slice(0, 20),
            dueDate: full.dueDate.slice(0, 20),
            status: full.status,
            ...(full.notes ? { notes: full.notes.slice(0, 300) } : {}),
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.CREATE, `cheques/${id}`);
        }
      } else {
        setCheques((prev) => [full, ...prev]);
      }

      if (!skipVoucher) {
        const lines: VoucherLine[] =
          payload.direction === 'receivable'
            ? [
                {
                  accountCode: '10301',
                  accountTitle: 'اسناد دریافتنی نزد صندوق',
                  partyId: payload.partyId,
                  partyName: payload.partyName,
                  description: `دریافت چک صیادی ${payload.sayadiId}`,
                  debit: payload.amount,
                  credit: 0,
                },
                {
                  accountCode: '10401',
                  accountTitle: 'بدهکاران تجاری و مشتریان',
                  partyId: payload.partyId,
                  partyName: payload.partyName,
                  description: `بستانکاری مشتری بابت چک صیادی ${payload.sayadiId}`,
                  debit: 0,
                  credit: payload.amount,
                },
              ]
            : [
                {
                  accountCode: '30101',
                  accountTitle: 'بستانکاران و تأمین‌کنندگان',
                  partyId: payload.partyId,
                  partyName: payload.partyName,
                  description: `پرداخت چک صیادی ${payload.sayadiId}`,
                  debit: payload.amount,
                  credit: 0,
                },
                {
                  accountCode: '30201',
                  accountTitle: 'اسناد پرداختنی تجاری (چک‌های صادره)',
                  partyId: payload.partyId,
                  partyName: payload.partyName,
                  description: `صدور چک صیادی ${payload.sayadiId}`,
                  debit: 0,
                  credit: payload.amount,
                },
              ];

        await createVoucher({
          date: payload.issueDate,
          description: `ثبت چک صیادی ${payload.sayadiId} — ${payload.partyName}`,
          voucherType: 'treasury',
          status: 'permanent',
          lines,
          referenceId: id,
        });
      }
    },
    [ownerId, user, createVoucher]
  );

  const updateCheque = useCallback(
    async (
      chequeId: string,
      patch: Partial<Pick<Cheque, 'bankName' | 'branch' | 'dueDate' | 'notes'>>
    ) => {
      if (user) {
        try {
          const payload: Record<string, unknown> = { updatedAt: serverTimestamp() };
          if (patch.bankName !== undefined) payload.bankName = patch.bankName.slice(0, 100);
          if (patch.branch !== undefined) payload.branch = patch.branch.slice(0, 100);
          if (patch.dueDate !== undefined) payload.dueDate = patch.dueDate.slice(0, 20);
          if (patch.notes !== undefined) payload.notes = patch.notes.slice(0, 300);
          await updateDoc(doc(db, 'cheques', chequeId), payload);
        } catch (err) {
          handleFirestoreError(err, OperationType.UPDATE, `cheques/${chequeId}`);
        }
      } else {
        setCheques((prev) => prev.map((c) => (c.id === chequeId ? { ...c, ...patch } : c)));
      }
      showToast('مشخصات چک صیادی ویرایش شد.');
    },
    [user, showToast]
  );

  const updateChequeStatus = useCallback(
    async (
      chequeId: string,
      newStatus: ChequeStatus,
      options?: { bankAccountCode?: string; endorsePartyId?: string }
    ) => {
      const cachedCheque = cheques.find((c) => c.id === chequeId);
      if (!cachedCheque || cachedCheque.status === newStatus) return;

      const transitionDate = getTodayShamsi();
      const voucherId = generateSafeId('vch');
      const buildVoucher = (
        cheque: Cheque,
        plan: ReturnType<typeof planChequeStatusTransition>,
        voucherNumber: number
      ): Voucher | undefined => {
        if (plan.lines.length < 2) return undefined;
        const validation = validateVoucherPayload({
          payload: {
            date: transitionDate,
            description: plan.description,
            voucherType: 'treasury',
            status: 'permanent',
            lines: plan.lines,
            referenceId: `${chequeId}_${newStatus}_${voucherId}`,
            allowDuplicate: true,
          },
          accounts,
          parties,
          existingVouchers: vouchers,
          closedFiscalYears: profile.closedFiscalYears,
          allowDuplicate: true,
        });
        if (!validation.valid) {
          throw new Error(validation.errors[0] || 'سند تغییر وضعیت چک معتبر نیست.');
        }
        const base: Voucher = {
          id: voucherId,
          ownerId,
          voucherNumber,
          date: transitionDate,
          fiscalYear: validation.fiscalYear,
          description: plan.description.slice(0, 300),
          voucherType: 'treasury',
          status: 'permanent',
          totalDebit: validation.totalDebit,
          totalCredit: validation.totalCredit,
          referenceId: `${chequeId}_${newStatus}_${voucherId}`,
          lines: validation.sanitizedLines.slice(0, 100),
          _version: 1,
          updatedByDevice: deviceId,
        };
        return { ...base, integrityHash: computeVoucherIntegrityHash(base) };
      };

      try {
        if (user) {
          const committedVoucher = await runTransaction(db, async (tx) => {
            const chequeRef = doc(db, 'cheques', chequeId);
            const chequeSnap = await tx.get(chequeRef);
            if (!chequeSnap.exists()) {
              throw new Error('چک در سرور پیدا نشد؛ وضعیت تغییری نکرد.');
            }
            const liveData = chequeSnap.data();
            const liveCheque: Cheque = {
              ...cachedCheque,
              ...liveData,
              id: chequeId,
              ownerId: liveData.ownerId,
            } as Cheque;
            if (liveCheque.status !== cachedCheque.status) {
              throw new Error('وضعیت چک در دستگاه دیگری تغییر کرده است؛ اطلاعات را تازه‌سازی کنید.');
            }

            const plan = planChequeStatusTransition({
              cheque: liveCheque,
              newStatus,
              accounts,
              parties,
              bankAccountCode: options?.bankAccountCode,
              endorsePartyId: options?.endorsePartyId,
            });
            if (!plan.ok) {
              throw new Error(plan.error || 'تغییر وضعیت درخواستی برای این چک مجاز نیست.');
            }

            let voucher: Voucher | undefined;
            let counterRef: ReturnType<typeof doc> | undefined;
            let counterSnap: Awaited<ReturnType<typeof tx.get>> | undefined;
            let nextVoucherNumber = 0;

            if (plan.lines.length >= 2) {
              const validation = validateVoucherPayload({
                payload: {
                  date: transitionDate,
                  description: plan.description,
                  voucherType: 'treasury',
                  status: 'permanent',
                  lines: plan.lines,
                  referenceId: `${chequeId}_${newStatus}_${voucherId}`,
                  allowDuplicate: true,
                },
                accounts,
                parties,
                existingVouchers: vouchers,
                closedFiscalYears: profile.closedFiscalYears,
                allowDuplicate: true,
              });
              if (!validation.valid) {
                throw new Error(validation.errors[0] || 'سند تغییر وضعیت چک معتبر نیست.');
              }
              const fy = validation.fiscalYear;
              const localMax = vouchers
                .filter((v) => (v.fiscalYear || extractFiscalYearFromDate(v.date)) === fy)
                .reduce((max, v) => Math.max(max, v.voucherNumber || 0), 0);
              counterRef = doc(db, 'counters', user.uid);
              counterSnap = await tx.get(counterRef);
              const counterData = counterSnap.exists() ? counterSnap.data() : {};
              const yearCounters =
                counterData.voucherNumbersByFiscalYear &&
                typeof counterData.voucherNumbersByFiscalYear === 'object'
                  ? counterData.voucherNumbersByFiscalYear as Record<string, number>
                  : {};
              nextVoucherNumber = getNextFiscalYearVoucherNumber(fy, yearCounters, localMax);
              voucher = buildVoucher(liveCheque, plan, nextVoucherNumber);
              if (!voucher) throw new Error('سند خزانه برای این تغییر وضعیت تولید نشد.');

              const nextYearCounters = { ...yearCounters, [fy]: nextVoucherNumber };
              const globalMax = Math.max(Number(counterData.lastVoucherNumber) || 0, nextVoucherNumber);
              if (!counterSnap.exists()) {
                tx.set(counterRef, {
                  ownerId: user.uid,
                  lastVoucherNumber: globalMax,
                  voucherNumbersByFiscalYear: nextYearCounters,
                  lastInvoiceSeq: 102,
                  updatedByDevice: deviceId.slice(0, 64),
                  createdAt: serverTimestamp(),
                  updatedAt: serverTimestamp(),
                });
              } else {
                tx.update(counterRef, {
                  lastVoucherNumber: globalMax,
                  voucherNumbersByFiscalYear: nextYearCounters,
                  updatedByDevice: deviceId.slice(0, 64),
                  updatedAt: serverTimestamp(),
                });
              }

              tx.set(doc(db, 'vouchers', voucher.id), {
                ownerId,
                voucherNumber: voucher.voucherNumber,
                date: voucher.date,
                description: voucher.description,
                voucherType: voucher.voucherType,
                status: voucher.status,
                totalDebit: voucher.totalDebit,
                totalCredit: voucher.totalCredit,
                ...(voucher.referenceId ? { referenceId: voucher.referenceId.slice(0, 128) } : {}),
                integrityHash: voucher.integrityHash,
                lines: voucher.lines,
                _version: 1,
                updatedByDevice: deviceId.slice(0, 64),
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp(),
              });
            }

            tx.update(chequeRef, {
              status: newStatus,
              _version: (Number(liveCheque._version) || 1) + 1,
              updatedByDevice: deviceId.slice(0, 64),
              updatedAt: serverTimestamp(),
            });
            return voucher;
          });

          setCheques((prev) =>
            prev.map((c) =>
              c.id === chequeId
                ? { ...c, status: newStatus, _version: (Number(c._version) || 1) + 1 }
                : c
            )
          );
          if (committedVoucher) setVouchers((prev) => [...prev, committedVoucher]);
          showToast(
            committedVoucher
              ? `وضعیت چک و سند خزانه شماره ${committedVoucher.voucherNumber} به‌صورت اتمیک ثبت شد.`
              : 'وضعیت چک با موفقیت ثبت شد.'
          );
          return;
        }

        const plan = planChequeStatusTransition({
          cheque: cachedCheque,
          newStatus,
          accounts,
          parties,
          bankAccountCode: options?.bankAccountCode,
          endorsePartyId: options?.endorsePartyId,
        });
        if (!plan.ok) throw new Error(plan.error || 'تغییر وضعیت درخواستی برای این چک مجاز نیست.');
        let localVoucher: Voucher | undefined;
        if (plan.lines.length >= 2) {
          const validation = validateVoucherPayload({
            payload: {
              date: transitionDate,
              description: plan.description,
              voucherType: 'treasury',
              status: 'permanent',
              lines: plan.lines,
              referenceId: `${chequeId}_${newStatus}_${voucherId}`,
              allowDuplicate: true,
            },
            accounts,
            parties,
            existingVouchers: vouchers,
            closedFiscalYears: profile.closedFiscalYears,
            allowDuplicate: true,
          });
          if (!validation.valid) throw new Error(validation.errors[0] || 'سند تغییر وضعیت چک معتبر نیست.');
          const fy = validation.fiscalYear;
          const localMax = vouchers
            .filter((v) => (v.fiscalYear || extractFiscalYearFromDate(v.date)) === fy)
            .reduce((max, v) => Math.max(max, v.voucherNumber || 0), 0);
          const nextNumber = getNextFiscalYearVoucherNumber(fy, undefined, localMax);
          localVoucher = buildVoucher(cachedCheque, plan, nextNumber);
        }
        setCheques((prev) =>
          prev.map((c) =>
            c.id === chequeId
              ? { ...c, status: newStatus, _version: (Number(c._version) || 1) + 1 }
              : c
          )
        );
        if (localVoucher) setVouchers((prev) => [...prev, localVoucher!]);
        showToast(
          localVoucher
            ? `وضعیت چک و سند خزانه شماره ${localVoucher.voucherNumber} ثبت شد.`
            : 'وضعیت چک با موفقیت ثبت شد.'
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : 'ثبت تغییر وضعیت چک ناموفق بود.';
        showToast(message, 'error');
        throw err;
      }
    },
    [
      cheques,
      accounts,
      parties,
      vouchers,
      profile.closedFiscalYears,
      ownerId,
      deviceId,
      user,
      showToast,
    ]
  );

  const recordQuickTreasury = useCallback(
    async (payload: {
      direction: 'receipt' | 'payment';
      accountCode: string;
      partyId: string;
      amount: number;
      date: string;
      description: string;
    }) => {
      const party = parties.find((p) => p.id === payload.partyId);
      if (!party) return;
      const cashAcc = accounts.find((a) => a.code === payload.accountCode);
      const cashCode = cashAcc?.code || '10201';
      const cashTitle = cashAcc?.title || 'بانک ملت — حساب جاری شرکتی';
      const partyCode = party.accountCode || (party.partyType === 'vendor' ? '30101' : '10401');
      const partyTitle =
        partyCode === '30101' ? 'بستانکاران و تأمین‌کنندگان' : 'بدهکاران تجاری و مشتریان';

      const lines: VoucherLine[] =
        payload.direction === 'receipt'
          ? [
              {
                accountCode: cashCode,
                accountTitle: cashTitle,
                description: payload.description,
                debit: payload.amount,
                credit: 0,
              },
              {
                accountCode: partyCode,
                accountTitle: partyTitle,
                partyId: party.id,
                partyName: party.name,
                description: payload.description,
                debit: 0,
                credit: payload.amount,
              },
            ]
          : [
              {
                accountCode: partyCode,
                accountTitle: partyTitle,
                partyId: party.id,
                partyName: party.name,
                description: payload.description,
                debit: payload.amount,
                credit: 0,
              },
              {
                accountCode: cashCode,
                accountTitle: cashTitle,
                description: payload.description,
                debit: 0,
                credit: payload.amount,
              },
            ];

      await createVoucher({
        date: payload.date,
        description: `${payload.direction === 'receipt' ? 'دریافت' : 'پرداخت'} خزانه — ${party.name}`,
        voucherType: 'treasury',
        status: 'permanent',
        lines,
      });
    },
    [parties, accounts, createVoucher]
  );

  const recordBankTransfer = useCallback(
    async (payload: {
      fromAccountCode: string;
      toAccountCode: string;
      amount: number;
      date: string;
      description: string;
    }) => {
      if (payload.fromAccountCode === payload.toAccountCode) {
        showToast('حساب مبدأ و مقصد انتقال وجه نمی‌تواند یکسان باشد.');
        return;
      }
      const fromAcc = accounts.find((a) => a.code === payload.fromAccountCode);
      const toAcc = accounts.find((a) => a.code === payload.toAccountCode);
      if (!fromAcc || !toAcc || payload.amount <= 0) return;

      await createVoucher({
        date: payload.date,
        description: `انتقال وجه از ${fromAcc.title} به ${toAcc.title}`,
        voucherType: 'treasury',
        status: 'permanent',
        lines: [
          {
            accountCode: toAcc.code,
            accountTitle: toAcc.title,
            description: payload.description || `واریز انتقالی از ${fromAcc.title}`,
            debit: payload.amount,
            credit: 0,
          },
          {
            accountCode: fromAcc.code,
            accountTitle: fromAcc.title,
            description: payload.description || `برداشت انتقالی به ${toAcc.title}`,
            debit: 0,
            credit: payload.amount,
          },
        ],
      });
    },
    [accounts, createVoucher, showToast]
  );

  // ---------------- INVOICES CRUD & COMMERCIAL OPS (STRICT 4-ENTITY ATOMICITY) ----------------
  const createInvoice = useCallback(
    async (payload: Omit<Invoice, 'id' | 'ownerId' | 'voucherId'>): Promise<Invoice> => {
      const id = generateSafeId('inv');
      const plannedVoucherId = generateSafeId('vch');
      const plannedChequeId = generateSafeId('chq');
      const invoiceFy = extractFiscalYearFromDate(payload.date) || profile.fiscalYear;
      const localMaxVoucherNum = vouchers
        .filter((v) => (v.fiscalYear || extractFiscalYearFromDate(v.date)) === invoiceFy)
        .reduce((m, v) => Math.max(m, v.voucherNumber), 0);
      const linkedOriginalInvoice = payload.sourceInvoiceId
        ? invoices.find((inv) => inv.id === payload.sourceInvoiceId)
        : undefined;

      const isFxInv = isForeignCurrency(payload.currencyCode) && Number(payload.exchangeRate) > 0;
      const fxCode = isFxInv ? normalizeCurrencyCode(payload.currencyCode) : undefined;
      const fxRate = isFxInv ? Number(payload.exchangeRate) : undefined;
      const fxCurDef = fxCode
        ? currencies.find((c) => normalizeCurrencyCode(c.code) === fxCode)
        : undefined;
      const fxDecimals = fxCurDef?.decimalPlaces ?? 2;

      const selectedParty = parties.find((p) => p.id === payload.partyId);
      const currentPartyBal = partyBalances.get(payload.partyId) ?? 0;

      // Helper to serialize an Invoice for Firestore rules compliance
      const serializeInvoiceForFirestore = (inv: Invoice) => ({
        ownerId,
        invoiceNumber: inv.invoiceNumber.slice(0, 48),
        ...(inv.taxSerial ? { taxSerial: inv.taxSerial.slice(0, 64) } : {}),
        invoiceType: inv.invoiceType,
        date: inv.date.slice(0, 20),
        partyId: inv.partyId.slice(0, 128),
        partyName: inv.partyName.slice(0, 160),
        ...(inv.intermediaryId ? { intermediaryId: inv.intermediaryId.slice(0, 128) } : {}),
        ...(inv.intermediaryName ? { intermediaryName: inv.intermediaryName.slice(0, 160) } : {}),
        warehouse: inv.warehouse.slice(0, 80),
        ...(inv.costCenterId ? { costCenterId: inv.costCenterId.slice(0, 128) } : {}),
        ...(isFxInv && inv.currencyCode && inv.exchangeRate
          ? {
              currencyCode: normalizeCurrencyCode(inv.currencyCode).slice(0, 10),
              exchangeRate: Number(inv.exchangeRate),
              foreignSubtotal: Number(inv.foreignSubtotal ?? 0),
              foreignDiscount: Number(inv.foreignDiscount ?? 0),
              foreignVatAmount: Number(inv.foreignVatAmount ?? 0),
              foreignGrandTotal: Number(inv.foreignGrandTotal ?? 0),
            }
          : {}),
        subtotal: inv.subtotal,
        discount: inv.discount,
        vatAmount: inv.vatAmount,
        grandTotal: inv.grandTotal,
        paidCash: inv.paidCash,
        paidBank: inv.paidBank,
        paidCheque: inv.paidCheque,
        creditAmount: inv.creditAmount,
        status: inv.status,
        ...(inv.voucherId ? { voucherId: inv.voucherId } : {}),
        items: inv.items.slice(0, 100),
        _version: 1,
        updatedByDevice: deviceId.slice(0, 64),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      const serializeVoucherForFirestore = (vch: Voucher) => {
        const annotatedLines =
          isFxInv && fxRate
            ? annotateVoucherLinesWithCurrency(vch.lines, fxRate, fxDecimals)
            : vch.lines;
        const foreignTotalDebit =
          isFxInv && fxRate
            ? roundCurrency(
                annotatedLines.reduce((s, l) => s + (Number(l.foreignDebit) || 0), 0),
                fxDecimals
              )
            : undefined;
        const foreignTotalCredit =
          isFxInv && fxRate
            ? roundCurrency(
                annotatedLines.reduce((s, l) => s + (Number(l.foreignCredit) || 0), 0),
                fxDecimals
              )
            : undefined;

        return {
          ownerId,
          voucherNumber: vch.voucherNumber,
          date: vch.date.slice(0, 20),
          description: vch.description.slice(0, 300),
          voucherType: vch.voucherType,
          status: vch.status,
          totalDebit: vch.totalDebit,
          totalCredit: vch.totalCredit,
          ...(isFxInv && fxCode && fxRate
            ? {
                currencyCode: fxCode.slice(0, 10),
                exchangeRate: fxRate,
                foreignTotalDebit,
                foreignTotalCredit,
              }
            : {}),
          ...(vch.referenceId ? { referenceId: vch.referenceId.slice(0, 128) } : {}),
          ...(vch.integrityHash ? { integrityHash: vch.integrityHash } : {}),
          lines: annotatedLines.slice(0, 100),
          _version: 1,
          updatedByDevice: deviceId.slice(0, 64),
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        };
      };

      const serializeChequeForFirestore = (chq: Cheque) => ({
        ownerId,
        sayadiId: chq.sayadiId.slice(0, 32),
        serial: chq.serial.slice(0, 48),
        direction: chq.direction,
        partyId: chq.partyId.slice(0, 128),
        partyName: chq.partyName.slice(0, 160),
        bankName: chq.bankName.slice(0, 100),
        ...(chq.branch ? { branch: chq.branch.slice(0, 100) } : {}),
        amount: chq.amount,
        issueDate: chq.issueDate.slice(0, 20),
        dueDate: chq.dueDate.slice(0, 20),
        status: chq.status,
        ...(chq.notes ? { notes: chq.notes.slice(0, 300) } : {}),
        _version: 1,
        updatedByDevice: deviceId.slice(0, 64),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      // 1. Pre-flight deterministic atomic plan (validates settlement, overdrafts, stock, balanced voucher & cheque BEFORE any write)
      let plan: ReturnType<typeof planAtomicInvoiceCommit>;
      try {
        plan = planAtomicInvoiceCommit({
          invoiceId: id,
          voucherId: plannedVoucherId,
          chequeId: plannedChequeId,
          nextVoucherNumber: localMaxVoucherNum + 1,
          ownerId,
          deviceId,
          payload,
          products,
          trialBalance,
          party: selectedParty,
          currentPartyBalance: currentPartyBal,
          enforceCashOverdraftGuard: true,
          defaultCostingMethod: profile.defaultCostingMethod,
          originalInvoice: linkedOriginalInvoice,
          existingInvoices: invoices,
          existingVouchers: vouchers,
          closedFiscalYears: profile.closedFiscalYears,
          fxDecimals,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'خطا در اعتبارسنجی اتمیک فاکتور.';
        showToast(msg, 'error');
        throw err;
      }

      // Annotate foreign currency lines if multi-currency
      if (plan.voucher && isFxInv && fxRate) {
        plan.voucher = {
          ...plan.voucher,
          lines: annotateVoucherLinesWithCurrency(plan.voucher.lines, fxRate, fxDecimals),
        };
      }

      const commitAtomicOfflineCloudBatch = async (): Promise<Invoice> => {
        const batch = writeBatch(db);
        for (const prod of plan.updatedProducts) {
          batch.update(doc(db, 'products', prod.id), {
            stock: prod.stock,
            buyPrice: prod.buyPrice,
            ...(prod.costingMethod ? { costingMethod: prod.costingMethod } : {}),
            ...(prod.costLayers ? { costLayers: prod.costLayers } : {}),
            ...(typeof prod.inventoryValueIrr === 'number' ? { inventoryValueIrr: prod.inventoryValueIrr } : {}),
            _version: prod._version ?? 2,
            updatedByDevice: deviceId.slice(0, 64),
            updatedAt: serverTimestamp(),
          });
        }
        if (plan.voucher) {
          batch.set(doc(db, 'vouchers', plan.voucher.id), serializeVoucherForFirestore(plan.voucher));
        }
        if (plan.cheque) {
          batch.set(doc(db, 'cheques', plan.cheque.id), serializeChequeForFirestore(plan.cheque));
        }
        batch.set(doc(db, 'invoices', plan.invoice.id), serializeInvoiceForFirestore(plan.invoice));
        await batch.commit();
        return plan.invoice;
      };

      let committedInvoice = plan.invoice;

      if (user) {
        const isOfflineNow = typeof navigator !== 'undefined' && !navigator.onLine;
        if (isOfflineNow) {
          if (payload.invoiceType !== 'proforma') {
            const offlineError = new Error('برای جلوگیری از شماره‌گذاری تکراری و مغایرت انبار، ثبت فاکتور مالی در حالت آفلاین متوقف شد. پس از اتصال اینترنت دوباره تلاش کنید.');
            showToast(offlineError.message, 'error');
            throw offlineError;
          }
          // Proforma invoices have no stock or ledger impact and can be queued offline.
          committedInvoice = await commitAtomicOfflineCloudBatch();
        } else {
          // Single atomic Firestore runTransaction: reads live counter & live product stocks,
          // validates & writes ALL 4 entities (products + voucher + cheque + invoice) in ONE commit!
          try {
            committedInvoice = await runTransaction(db, async (tx) => {
              const counterRef = doc(db, 'counters', user.uid);
              const counterSnap = await tx.get(counterRef);
              const counterData = counterSnap.exists() ? counterSnap.data() : {};
              const yearCounters =
                counterData.voucherNumbersByFiscalYear &&
                typeof counterData.voucherNumbersByFiscalYear === 'object'
                  ? counterData.voucherNumbersByFiscalYear as Record<string, number>
                  : {};
              const liveNextVoucherNum = getNextFiscalYearVoucherNumber(
                invoiceFy,
                yearCounters,
                localMaxVoucherNum
              );

              // Read live products for every item in the invoice
              const uniqueProductIds = Array.from(new Set(payload.items.map((it) => it.productId)));
              const liveProductsMap = new Map<string, Product>(products.map((p) => [p.id, p]));

              if (payload.invoiceType !== 'proforma') {
                for (const pid of uniqueProductIds) {
                  const pRef = doc(db, 'products', pid);
                  const pSnap = await tx.get(pRef);
                  if (pSnap.exists()) {
                    const d = pSnap.data();
                    const base = liveProductsMap.get(pid);
                    if (base) {
                      liveProductsMap.set(pid, {
                        ...base,
                        stock: Number(d.stock) || 0,
                        buyPrice: Number(d.buyPrice) || 0,
                        ...(d.costingMethod ? { costingMethod: d.costingMethod } : {}),
                        ...(Array.isArray(d.costLayers) ? { costLayers: d.costLayers } : {}),
                        ...(typeof d.inventoryValueIrr === 'number' ? { inventoryValueIrr: d.inventoryValueIrr } : {}),
                        _version: Number(d._version) || 1,
                      });
                    }
                  }
                }
              }

              // Re-plan deterministically using live Firestore stocks & atomic counter inside transaction
              const livePlan = planAtomicInvoiceCommit({
                invoiceId: id,
                voucherId: plannedVoucherId,
                chequeId: plannedChequeId,
                nextVoucherNumber: liveNextVoucherNum,
                ownerId,
                deviceId,
                payload,
                products: Array.from(liveProductsMap.values()),
                trialBalance,
                party: selectedParty,
                currentPartyBalance: currentPartyBal,
                enforceCashOverdraftGuard: true,
                defaultCostingMethod: profile.defaultCostingMethod,
                originalInvoice: linkedOriginalInvoice,
                existingInvoices: invoices,
                existingVouchers: vouchers,
                closedFiscalYears: profile.closedFiscalYears,
                fxDecimals,
              });

              if (livePlan.voucher) {
                if (!counterSnap.exists()) {
                  tx.set(counterRef, {
                    ownerId: user.uid,
                    lastVoucherNumber: Math.max(Number(counterData.lastVoucherNumber) || 0, liveNextVoucherNum),
                    voucherNumbersByFiscalYear: { ...yearCounters, [invoiceFy]: liveNextVoucherNum },
                    lastInvoiceSeq: 102,
                    updatedByDevice: deviceId.slice(0, 64),
                    createdAt: serverTimestamp(),
                    updatedAt: serverTimestamp(),
                  });
                } else {
                  tx.update(counterRef, {
                    lastVoucherNumber: Math.max(Number(counterData.lastVoucherNumber) || 0, liveNextVoucherNum),
                    voucherNumbersByFiscalYear: { ...yearCounters, [invoiceFy]: liveNextVoucherNum },
                    updatedByDevice: deviceId.slice(0, 64),
                    updatedAt: serverTimestamp(),
                  });
                }
              }

              for (const prod of livePlan.updatedProducts) {
                tx.update(doc(db, 'products', prod.id), {
                  stock: prod.stock,
                  buyPrice: prod.buyPrice,
                  ...(prod.costingMethod ? { costingMethod: prod.costingMethod } : {}),
                  ...(prod.costLayers ? { costLayers: prod.costLayers } : {}),
                  ...(typeof prod.inventoryValueIrr === 'number' ? { inventoryValueIrr: prod.inventoryValueIrr } : {}),
                  _version: prod._version ?? 2,
                  updatedByDevice: deviceId.slice(0, 64),
                  updatedAt: serverTimestamp(),
                });
              }

              if (livePlan.voucher) {
                tx.set(
                  doc(db, 'vouchers', livePlan.voucher.id),
                  serializeVoucherForFirestore(livePlan.voucher)
                );
              }
              if (livePlan.cheque) {
                tx.set(
                  doc(db, 'cheques', livePlan.cheque.id),
                  serializeChequeForFirestore(livePlan.cheque)
                );
              }
              tx.set(
                doc(db, 'invoices', livePlan.invoice.id),
                serializeInvoiceForFirestore(livePlan.invoice)
              );

              return livePlan.invoice;
            });
          } catch (err) {
            const msg =
              err instanceof Error &&
              (err.message.includes('موجودی') ||
                err.message.includes('تسویه') ||
                err.message.includes('تراز') ||
                err.message.includes('آفلاین') ||
                err.message.includes('شماره‌گذاری'))
                ? err.message
                : null;
            if (msg) {
              showToast(msg, 'error');
              throw err;
            }
            if (isFirestoreOfflineError(err)) {
              const offlineError = new Error('تراکنش فاکتور در سرور تأیید نشد؛ برای جلوگیری از ثبت ناقص یا تکراری، عملیات انجام نشد. وضعیت اتصال را بررسی و سپس فاکتور را از فهرست اسناد کنترل کنید.');
              showToast(offlineError.message, 'error');
              throw offlineError;
            }
            handleFirestoreError(err, OperationType.CREATE, `atomic-invoice/${id}`);
          }
        }
      } else {
        // Local Operational Mode: Single atomic 4-store IndexedDB transaction (products + voucher + cheque + invoice)
        try {
          await commitInvoiceOperationalTx({
            updatedProducts: plan.updatedProducts,
            voucher: plan.voucher,
            cheque: plan.cheque,
            invoice: plan.invoice,
          });
        } catch (err) {
          const msg =
            err instanceof Error
              ? `تراکنش اتمیک محلی فاکتور لغو شد (بدون ثبت ناقص): ${err.message}`
              : 'تراکنش اتمیک محلی فاکتور لغو شد.';
          showToast(msg, 'error');
          throw err;
        }

        // Apply all 4 state mutations together ONLY after IndexedDB transaction succeeds
        const updatedMap = new Map(plan.updatedProducts.map((p) => [p.id, p]));
        if (updatedMap.size > 0) {
          setProducts((prev) => prev.map((p) => updatedMap.get(p.id) ?? p));
        }
        if (plan.voucher) {
          const v = plan.voucher;
          setVouchers((prev) => [v, ...prev]);
        }
        if (plan.cheque) {
          const c = plan.cheque;
          setCheques((prev) => [c, ...prev]);
        }
        setInvoices((prev) => [plan.invoice, ...prev]);
        void getOperationalDbStats()
          .then(setOperationalDbStats)
          .catch(() => {});
      }

      if (plan.creditLimitWarning) {
        playWarningTone();
        showToast(plan.creditLimitWarning, 'warning');
      } else {
        showToast(
          payload.invoiceType === 'proforma'
            ? `پیش‌فاکتور ${committedInvoice.invoiceNumber} صادر شد (بدون تأثیر بر انبار و سند تا زمان تبدیل به فاکتور فروش).`
            : isFxInv && committedInvoice.currencyCode
              ? `فاکتور ارزی ${committedInvoice.invoiceNumber} (${committedInvoice.currencyCode}) به صورت اتمیک همراه با سند و موجودی انبار ثبت شد.`
              : `فاکتور ${committedInvoice.invoiceNumber} به صورت اتمیک (انبار + سند${plan.cheque ? ' + چک صیادی' : ''} + فاکتور) ثبت شد.`,
          'success'
        );
      }

      return committedInvoice;
    },
    [
      products,
      vouchers,
      invoices,
      parties,
      partyBalances,
      trialBalance,
      currencies,
      profile.fiscalYear,
      profile.defaultCostingMethod,
      profile.closedFiscalYears,
      ownerId,
      user,
      deviceId,
      showToast,
    ]
  );

  const cancelInvoice = useCallback(
    async (invoiceId: string) => {
      const inv = invoices.find((i) => i.id === invoiceId);
      if (!inv || inv.status === 'cancelled') return;

      const today = getTodayShamsi();
      const nextNum = vouchers.reduce((m, v) => Math.max(m, v.voucherNumber || 0), 0) + 1;
      let plan;
      try {
        plan = planInvoiceCancellation({
          invoice: inv,
          cancellationDate: today,
          products,
          vouchers,
          cheques,
          costingMethod: profile.defaultCostingMethod ?? 'fifo',
          closedFiscalYears: profile.closedFiscalYears ?? [],
          ownerId,
          reversalVoucherId: generateSafeId('vch'),
          nextVoucherNumber: nextNum,
          deviceId,
        });
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'خطا در ابطال فاکتور.');
        return;
      }

      if (inv.invoiceType !== 'proforma') {
        const applyOfflineCancelBatch = async () => {
          const batch = writeBatch(db);
          for (const [pid, delta] of plan.productDeltas.entries()) {
            batch.update(doc(db, 'products', pid), {
              stock: delta.stock,
              buyPrice: delta.buyPrice,
              costLayers: delta.costLayers,
              inventoryValueIrr: delta.inventoryValueIrr,
              _version: delta.prevVersion + 1,
              updatedByDevice: deviceId.slice(0, 64),
              updatedAt: serverTimestamp(),
            });
          }
          batch.update(doc(db, 'invoices', invoiceId), {
            status: 'cancelled',
            _version: (inv._version ?? 1) + 1,
            updatedByDevice: deviceId.slice(0, 64),
            updatedAt: serverTimestamp(),
          });
          await batch.commit();
        };

        if (user) {
          const isOfflineNow = typeof navigator !== 'undefined' && !navigator.onLine;
          if (isOfflineNow) {
            await applyOfflineCancelBatch();
          } else {
            try {
              const invRef = doc(db, 'invoices', invoiceId);
              const alreadyCancelled = await runTransaction(db, async (tx) => {
                const invSnap = await tx.get(invRef);
                if (!invSnap.exists() || invSnap.data().status === 'cancelled') return true;
                for (const [pid, delta] of plan.productDeltas.entries()) {
                  const pRef = doc(db, 'products', pid);
                  const ps = await tx.get(pRef);
                  if (ps.exists()) {
                    tx.update(pRef, {
                      stock: delta.stock,
                      buyPrice: delta.buyPrice,
                      costLayers: delta.costLayers,
                      inventoryValueIrr: delta.inventoryValueIrr,
                      _version: (Number(ps.data()._version) || 1) + 1,
                      updatedByDevice: deviceId.slice(0, 64),
                      updatedAt: serverTimestamp(),
                    });
                  }
                }
                tx.update(invRef, {
                  status: 'cancelled',
                  _version: (Number(invSnap.data()._version) || 1) + 1,
                  updatedByDevice: deviceId.slice(0, 64),
                  updatedAt: serverTimestamp(),
                });
                return false;
              });
              if (alreadyCancelled) {
                showToast('این فاکتور قبلاً توسط دستگاه دیگری ابطال شده است.');
                return;
              }
            } catch (err) {
              if (isFirestoreOfflineError(err)) {
                await applyOfflineCancelBatch();
              } else {
                handleFirestoreError(err, OperationType.UPDATE, `invoices/${invoiceId}`);
                return;
              }
            }
          }
        } else {
          setProducts((prev) =>
            prev.map((p) => {
              const delta = plan.productDeltas.get(p.id);
              if (!delta) return p;
              return {
                ...p,
                stock: delta.stock,
                buyPrice: delta.buyPrice,
                costLayers: delta.costLayers,
                inventoryValueIrr: delta.inventoryValueIrr,
                _version: delta.prevVersion + 1,
                updatedByDevice: deviceId,
              };
            })
          );
          setInvoices((prev) =>
            prev.map((i) =>
              i.id === invoiceId
                ? { ...i, status: 'cancelled', _version: (i._version ?? 1) + 1 }
                : i
            )
          );
        }

        // Issue sealed reversing voucher with explicit reversalOfVoucherId (no duplicate referenceId!)
        if (plan.reversalVoucher) {
          const revV = plan.reversalVoucher;
          const origVoucher = vouchers.find((v) => v.id === revV.reversalOfVoucherId);
          const fxLines =
            origVoucher && isForeignCurrency(origVoucher.currencyCode) && origVoucher.exchangeRate
              ? origVoucher.lines.map((l) => ({
                  ...l,
                  description: `ابطال و معکوس: ${l.description || origVoucher.description}`,
                  debit: Math.max(0, Math.round(Number(l.credit) || 0)),
                  credit: Math.max(0, Math.round(Number(l.debit) || 0)),
                  ...(l.foreignCredit !== undefined ? { foreignDebit: l.foreignCredit } : {}),
                  ...(l.foreignDebit !== undefined ? { foreignCredit: l.foreignDebit } : {}),
                }))
              : revV.lines;
          await createVoucher({
            date: revV.date,
            description: revV.description,
            voucherType: revV.voucherType,
            status: 'permanent',
            lines: fxLines,
            referenceId: revV.referenceId,
            reversalOfVoucherId: revV.reversalOfVoucherId,
            ...(revV.currencyCode && revV.exchangeRate
              ? { currencyCode: revV.currencyCode, exchangeRate: revV.exchangeRate }
              : {}),
          });
        }

        // Cancel linked in_box Sayadi cheques atomically
        for (const chqId of plan.chequeIdsToCancel) {
          const chq = cheques.find((c) => c.id === chqId);
          if (!chq) continue;
          if (user) {
            try {
              await updateDoc(doc(db, 'cheques', chq.id), {
                status: 'cancelled',
                notes: `${chq.notes || ''} (ابطال خودکار همراه فاکتور ${inv.invoiceNumber})`.slice(0, 300),
                updatedAt: serverTimestamp(),
              });
            } catch {
              // non-blocking
            }
          } else {
            setCheques((prev) =>
              prev.map((c) =>
                c.id === chq.id
                  ? { ...c, status: 'cancelled', notes: `${c.notes || ''} (ابطال همراه فاکتور)` }
                  : c
              )
            );
          }
        }
      } else {
        if (user) {
          try {
            await updateDoc(doc(db, 'invoices', invoiceId), {
              status: 'cancelled',
              updatedAt: serverTimestamp(),
            });
          } catch (err) {
            handleFirestoreError(err, OperationType.UPDATE, `invoices/${invoiceId}`);
          }
        } else {
          setInvoices((prev) =>
            prev.map((i) => (i.id === invoiceId ? { ...i, status: 'cancelled' } : i))
          );
        }
      }
      showToast(`فاکتور ${inv.invoiceNumber} ابطال شد، لایه‌های بهای تمام‌شده انبار بازگردانی و سند معکوس ثبت گردید.`);
    },
    [invoices, products, vouchers, cheques, profile, ownerId, createVoucher, user, deviceId, showToast]
  );

  const convertProformaToSale = useCallback(
    async (invoiceId: string) => {
      if (!activeOperator.permissions.canIssueInvoice) {
        showToast('نقش فعال مجوز تبدیل پیش‌فاکتور و صدور فاکتور فروش قطعی را ندارد.');
        return;
      }
      const inv = invoices.find((i) => i.id === invoiceId);
      if (!inv || inv.invoiceType !== 'proforma' || inv.status === 'cancelled') return;

      const conversionDate = getTodayShamsi();
      const nextNum = vouchers.reduce((m, v) => Math.max(m, v.voucherNumber || 0), 0) + 1;
      let plan;
      try {
        plan = planProformaToSaleConversion({
          proforma: inv,
          conversionDate,
          products,
          parties,
          existingInvoices: invoices,
          existingVouchers: vouchers,
          costingMethod: profile.defaultCostingMethod ?? 'fifo',
          allowNegativeStock: false,
          closedFiscalYears: profile.closedFiscalYears ?? [],
          ownerId,
          voucherId: generateSafeId('vch'),
          nextVoucherNumber: nextNum,
          chequeId: `chq_inv_${inv.id}`,
          deviceId,
          partyBalances,
        });
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'خطا در تبدیل پیش‌فاکتور به فاکتور فروش.');
        return;
      }

      // Apply exact FIFO/MWA product updates (stock, buyPrice, costLayers, inventoryValueIrr)
      for (const [pid, delta] of plan.productDeltas.entries()) {
        await updateProduct(pid, {
          stock: delta.stock,
          buyPrice: delta.buyPrice,
          costLayers: delta.costLayers,
          inventoryValueIrr: delta.inventoryValueIrr,
        });
      }

      // Issue FX-aware sealed permanent voucher
      let createdVoucherId = plan.voucher?.id;
      if (plan.voucher) {
        const isFx = isForeignCurrency(inv.currencyCode) && Number(inv.exchangeRate) > 0;
        const vLines =
          isFx && inv.exchangeRate
            ? annotateVoucherLinesWithCurrency(plan.voucher.lines, inv.exchangeRate, 2)
            : plan.voucher.lines;
        const createdVoucher = await createVoucher({
          date: plan.voucher.date,
          description: `سند اتوماتیک تبدیل پیش‌فاکتور به فروش رسمی ${plan.invoice.invoiceNumber} — ${inv.partyName}`,
          voucherType: 'sales',
          status: 'permanent',
          lines: vLines,
          referenceId: inv.id,
          ...(isFx && inv.currencyCode && inv.exchangeRate
            ? { currencyCode: inv.currencyCode, exchangeRate: inv.exchangeRate }
            : {}),
        });
        createdVoucherId = createdVoucher.id;
      }

      // Register Sayadi receivable cheque if proforma had paidCheque > 0 (keeps GL 10301 reconciled!)
      if (plan.cheque) {
        if (user) {
          try {
            await setDoc(doc(db, 'cheques', plan.cheque.id), {
              ...plan.cheque,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            });
          } catch (err) {
            handleFirestoreError(err, OperationType.CREATE, `cheques/${plan.cheque.id}`);
          }
        } else {
          setCheques((prev) => [plan.cheque!, ...prev]);
        }
      }

      const finalInvoice: Invoice = {
        ...plan.invoice,
        voucherId: createdVoucherId,
      };

      if (user) {
        try {
          await updateDoc(doc(db, 'invoices', invoiceId), {
            invoiceNumber: finalInvoice.invoiceNumber,
            invoiceType: 'sale',
            date: finalInvoice.date,
            status: finalInvoice.status,
            voucherId: createdVoucherId ?? null,
            items: finalInvoice.items.slice(0, 100),
            _version: finalInvoice._version ?? (inv._version ?? 1) + 1,
            updatedByDevice: deviceId.slice(0, 64),
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.UPDATE, `invoices/${invoiceId}`);
        }
      } else {
        setInvoices((prev) => prev.map((i) => (i.id === invoiceId ? finalInvoice : i)));
      }
      showToast(
        `پیش‌فاکتور با موفقیت به فاکتور فروش رسمی ${finalInvoice.invoiceNumber} تبدیل، موجودی لایه‌ای کسر و سند قطعی صادر شد.${
          plan.cheque ? ' (چک صیادی نیز در خزانه‌داری ثبت شد)' : ''
        }`
      );
    },
    [
      activeOperator,
      invoices,
      products,
      parties,
      vouchers,
      profile,
      ownerId,
      deviceId,
      partyBalances,
      updateProduct,
      createVoucher,
      user,
      showToast,
    ]
  );

  // ---------------- CORPORATE MODULES CRUD ----------------
  const addEmployee = useCallback(
    async (emp: Omit<Employee, 'id' | 'ownerId'>) => {
      const id = generateSafeId('emp');
      const full: Employee = { ...emp, id, ownerId };
      if (user) {
        try {
          await setDoc(doc(db, 'employees', id), {
            ownerId,
            personnelCode: emp.personnelCode.slice(0, 32),
            fullName: emp.fullName.trim().slice(0, 140),
            department: emp.department.slice(0, 80),
            baseSalary: Math.max(0, Number(emp.baseSalary) || 0),
            housingAllowance: Math.max(0, Number(emp.housingAllowance) || 0),
            foodAllowance: Math.max(0, Number(emp.foodAllowance) || 0),
            childrenCount: Math.min(20, Math.max(0, Number(emp.childrenCount) || 0)),
            overtimeHours: Math.max(0, Number(emp.overtimeHours) || 0),
            ...(emp.costCenterId ? { costCenterId: emp.costCenterId.slice(0, 128) } : {}),
            active: emp.active,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.CREATE, `employees/${id}`);
        }
      } else {
        setEmployees((prev) => [...prev, full]);
      }
      showToast(`پرسنل «${emp.fullName}» به لیست حقوق و دستمزد افزوده شد.`);
    },
    [ownerId, user, showToast]
  );

  const updateEmployee = useCallback(
    async (empId: string, patch: Partial<Omit<Employee, 'id' | 'ownerId' | 'personnelCode'>>) => {
      if (user) {
        try {
          const payload: Record<string, unknown> = { updatedAt: serverTimestamp() };
          if (patch.fullName !== undefined) payload.fullName = patch.fullName.trim().slice(0, 140);
          if (patch.department !== undefined) payload.department = patch.department.slice(0, 80);
          if (patch.baseSalary !== undefined) payload.baseSalary = Math.max(0, Number(patch.baseSalary) || 0);
          if (patch.housingAllowance !== undefined) payload.housingAllowance = Math.max(0, Number(patch.housingAllowance) || 0);
          if (patch.foodAllowance !== undefined) payload.foodAllowance = Math.max(0, Number(patch.foodAllowance) || 0);
          if (patch.childrenCount !== undefined) payload.childrenCount = Math.min(20, Math.max(0, Number(patch.childrenCount) || 0));
          if (patch.overtimeHours !== undefined) payload.overtimeHours = Math.max(0, Number(patch.overtimeHours) || 0);
          if (patch.costCenterId !== undefined) payload.costCenterId = patch.costCenterId.slice(0, 128);
          if (patch.active !== undefined) payload.active = Boolean(patch.active);
          await updateDoc(doc(db, 'employees', empId), payload);
        } catch (err) {
          handleFirestoreError(err, OperationType.UPDATE, `employees/${empId}`);
        }
      } else {
        setEmployees((prev) => prev.map((e) => (e.id === empId ? { ...e, ...patch } : e)));
      }
      showToast('مشخصات و حکم کارگزینی پرسنل ویرایش شد.');
    },
    [user, showToast]
  );

  const deleteEmployee = useCallback(
    async (empId: string) => {
      if (user) {
        try {
          await deleteDoc(doc(db, 'employees', empId));
        } catch (err) {
          handleFirestoreError(err, OperationType.DELETE, `employees/${empId}`);
        }
      } else {
        setEmployees((prev) => prev.filter((e) => e.id !== empId));
      }
      showToast('پرسنل از لیست فعال حذف شد.');
    },
    [user, showToast]
  );

  const postMonthlyPayrollVoucher = useCallback(
    async (monthName: string) => {
      const activeEmps = employees.filter((e) => e.active);
      if (activeEmps.length === 0) return;
      const calcs = activeEmps.map((emp) =>
        calculateEmployeePayroll(emp, profile.fiscalYear, profile.statutoryParamsByYear)
      );
      const totalExpense = calcs.reduce((s, c) => s + c.totalEmployerCost, 0);
      const totalNet = calcs.reduce((s, c) => s + c.netPay, 0);
      const totalInsurance = calcs.reduce(
        (s, c) => s + c.employeeInsurance + c.employerInsurance,
        0
      );
      const totalTax = calcs.reduce((s, c) => s + c.incomeTax, 0);

      const lines: VoucherLine[] = [
        {
          accountCode: '80101',
          accountTitle: 'هزینه حقوق، مزایا و بیمه سهم کارفرما',
          costCenterId: 'cc_hq',
          description: `هزینه حقوق و دستمزد ${monthName}`,
          debit: totalExpense,
          credit: 0,
        },
        {
          accountCode: '30401',
          accountTitle: 'حقوق پرداختنی کارکنان',
          description: `خالص پرداختنی حقوق ${monthName}`,
          debit: 0,
          credit: totalNet,
        },
        {
          accountCode: '30402',
          accountTitle: 'سازمان تأمین اجتماعی (بیمه ۳۰٪)',
          description: `بیمه سهم کارمند و کارفرما ${monthName}`,
          debit: 0,
          credit: totalInsurance,
        },
      ];
      if (totalTax > 0) {
        lines.push({
          accountCode: '30403',
          accountTitle: 'مالیات حقوق پرداختنی',
          description: `مالیات حقوق ${monthName}`,
          debit: 0,
          credit: totalTax,
        });
      }

      await createVoucher({
        date: getTodayShamsi(),
        description: `سند اتوماتیک حقوق و دستمزد ${monthName} سال ${profile.fiscalYear} (${activeEmps.length} نفر)`,
        voucherType: 'payroll',
        status: 'permanent',
        lines,
      });
    },
    [employees, profile.fiscalYear, profile.statutoryParamsByYear, createVoucher]
  );

  const paySalariesVoucher = useCallback(
    async (monthName: string, bankAccountCode: string, amount: number) => {
      if (amount <= 0) return;
      const bankAcc = accounts.find((a) => a.code === bankAccountCode);
      const bankTitle = bankAcc?.title || 'بانک ملت — حساب جاری شرکتی';
      await createVoucher({
        date: getTodayShamsi(),
        description: `پرداخت خالص حقوق کارکنان ${monthName} از ${bankTitle}`,
        voucherType: 'payroll',
        status: 'permanent',
        lines: [
          {
            accountCode: '30401',
            accountTitle: 'حقوق پرداختنی کارکنان',
            description: `تسویه حقوق پرداختنی ${monthName}`,
            debit: amount,
            credit: 0,
          },
          {
            accountCode: bankAccountCode,
            accountTitle: bankTitle,
            description: `واریز حقوق پرسنل ${monthName}`,
            debit: 0,
            credit: amount,
          },
        ],
      });
    },
    [accounts, createVoucher]
  );

  const addFixedAsset = useCallback(
    async (asset: Omit<FixedAsset, 'id' | 'ownerId'>) => {
      const id = generateSafeId('ast');
      const full: FixedAsset = { ...asset, id, ownerId };
      if (user) {
        try {
          await setDoc(doc(db, 'assets', id), {
            ownerId,
            assetCode: asset.assetCode.slice(0, 40),
            title: asset.title.trim().slice(0, 160),
            purchaseDate: asset.purchaseDate.slice(0, 20),
            purchaseCost: Math.max(1, Number(asset.purchaseCost) || 1),
            salvageValue: Math.max(0, Number(asset.salvageValue) || 0),
            usefulLifeYears: Math.min(100, Math.max(1, Number(asset.usefulLifeYears) || 5)),
            accumulatedDepreciation: Math.max(0, Number(asset.accumulatedDepreciation) || 0),
            ...(asset.costCenterId ? { costCenterId: asset.costCenterId.slice(0, 128) } : {}),
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.CREATE, `assets/${id}`);
        }
      } else {
        setAssets((prev) => [...prev, full]);
      }
      showToast(`دارایی ثابت «${asset.title}» ثبت شد.`);
    },
    [ownerId, user, showToast]
  );

  const updateFixedAsset = useCallback(
    async (assetId: string, patch: Partial<Omit<FixedAsset, 'id' | 'ownerId' | 'assetCode'>>) => {
      if (user) {
        try {
          const payload: Record<string, unknown> = { updatedAt: serverTimestamp() };
          if (patch.title !== undefined) payload.title = patch.title.trim().slice(0, 160);
          if (patch.purchaseDate !== undefined) payload.purchaseDate = patch.purchaseDate.slice(0, 20);
          if (patch.purchaseCost !== undefined) payload.purchaseCost = Math.max(1, Number(patch.purchaseCost) || 1);
          if (patch.salvageValue !== undefined) payload.salvageValue = Math.max(0, Number(patch.salvageValue) || 0);
          if (patch.usefulLifeYears !== undefined) payload.usefulLifeYears = Math.min(100, Math.max(1, Number(patch.usefulLifeYears) || 5));
          if (patch.accumulatedDepreciation !== undefined) payload.accumulatedDepreciation = Math.max(0, Number(patch.accumulatedDepreciation) || 0);
          if (patch.costCenterId !== undefined) payload.costCenterId = patch.costCenterId.slice(0, 128);
          await updateDoc(doc(db, 'assets', assetId), payload);
        } catch (err) {
          handleFirestoreError(err, OperationType.UPDATE, `assets/${assetId}`);
        }
      } else {
        setAssets((prev) => prev.map((a) => (a.id === assetId ? { ...a, ...patch } : a)));
      }
      showToast('مشخصات دارایی ثابت ویرایش شد.');
    },
    [user, showToast]
  );

  const deleteFixedAsset = useCallback(
    async (assetId: string) => {
      if (user) {
        try {
          await deleteDoc(doc(db, 'assets', assetId));
        } catch (err) {
          handleFirestoreError(err, OperationType.DELETE, `assets/${assetId}`);
        }
      } else {
        setAssets((prev) => prev.filter((a) => a.id !== assetId));
      }
      showToast('دارایی ثابت حذف شد.');
    },
    [user, showToast]
  );

  const postDepreciationVoucher = useCallback(
    async (periodLabel: string) => {
      let totalDep = 0;
      for (const a of assets) {
        const dep = calculateMonthlyDepreciation(a);
        if (dep > 0) {
          totalDep += dep;
          const nextAccum = a.accumulatedDepreciation + dep;
          if (user) {
            try {
              await updateDoc(doc(db, 'assets', a.id), {
                accumulatedDepreciation: nextAccum,
                updatedAt: serverTimestamp(),
              });
            } catch (err) {
              handleFirestoreError(err, OperationType.UPDATE, `assets/${a.id}`);
            }
          } else {
            setAssets((prev) =>
              prev.map((x) =>
                x.id === a.id ? { ...x, accumulatedDepreciation: nextAccum } : x
              )
            );
          }
        }
      }
      if (totalDep <= 0) {
        showToast('دارایی قابل استهلاک برای این دوره وجود ندارد.');
        return;
      }
      await createVoucher({
        date: getTodayShamsi(),
        description: `سند اتوماتیک استهلاک دارایی‌های ثابت — ${periodLabel}`,
        voucherType: 'depreciation',
        status: 'permanent',
        lines: [
          {
            accountCode: '80301',
            accountTitle: 'هزینه استهلاک اموال و تجهیزات',
            costCenterId: 'cc_hq',
            description: `هزینه استهلاک ${periodLabel}`,
            debit: totalDep,
            credit: 0,
          },
          {
            accountCode: '20201',
            accountTitle: 'استهلاک انباشته تجهیزات اداری',
            description: `افزایش استهلاک انباشته ${periodLabel}`,
            debit: 0,
            credit: totalDep,
          },
        ],
      });
    },
    [assets, user, createVoucher, showToast]
  );

  const addCostCenter = useCallback(
    async (cc: Omit<CostCenter, 'id' | 'ownerId'>) => {
      const id = generateSafeId('cc');
      const full: CostCenter = { ...cc, id, ownerId };
      if (user) {
        try {
          await setDoc(doc(db, 'costCenters', id), {
            ownerId,
            code: cc.code.slice(0, 32),
            name: cc.name.trim().slice(0, 140),
            budget: Math.max(0, Number(cc.budget) || 0),
            ...(cc.manager ? { manager: cc.manager.slice(0, 120) } : {}),
            active: cc.active,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.CREATE, `costCenters/${id}`);
        }
      } else {
        setCostCenters((prev) => [...prev, full]);
      }
      showToast(`مرکز هزینه «${cc.name}» ایجاد شد.`);
    },
    [ownerId, user, showToast]
  );

  const updateCostCenter = useCallback(
    async (ccId: string, patch: Partial<Omit<CostCenter, 'id' | 'ownerId' | 'code'>>) => {
      if (user) {
        try {
          const payload: Record<string, unknown> = { updatedAt: serverTimestamp() };
          if (patch.name !== undefined) payload.name = patch.name.trim().slice(0, 140);
          if (patch.budget !== undefined) payload.budget = Math.max(0, Number(patch.budget) || 0);
          if (patch.manager !== undefined) payload.manager = patch.manager.slice(0, 120);
          if (patch.active !== undefined) payload.active = Boolean(patch.active);
          await updateDoc(doc(db, 'costCenters', ccId), payload);
        } catch (err) {
          handleFirestoreError(err, OperationType.UPDATE, `costCenters/${ccId}`);
        }
      } else {
        setCostCenters((prev) => prev.map((c) => (c.id === ccId ? { ...c, ...patch } : c)));
      }
      showToast('اطلاعات مرکز هزینه ویرایش شد.');
    },
    [user, showToast]
  );

  const deleteCostCenter = useCallback(
    async (ccId: string) => {
      if (user) {
        try {
          await deleteDoc(doc(db, 'costCenters', ccId));
        } catch (err) {
          handleFirestoreError(err, OperationType.DELETE, `costCenters/${ccId}`);
        }
      } else {
        setCostCenters((prev) => prev.filter((c) => c.id !== ccId));
      }
      showToast('مرکز هزینه حذف شد.');
    },
    [user, showToast]
  );

  const runYearEndClosing = useCallback(
    async (options?: { createNextYearOpening?: boolean }) => {
      const fy = profile.fiscalYear;
      const sameYearMax = vouchers
        .filter((v) => (v.fiscalYear || extractFiscalYearFromDate(v.date)) === fy)
        .reduce((max, v) => Math.max(max, v.voucherNumber || 0), 0);

      let plan: ReturnType<typeof planYearEndClosing>;
      try {
        plan = planYearEndClosing({
          accounts,
          vouchers,
          fiscalYear: fy,
          nextVoucherNumber: sameYearMax + 1,
          ownerId,
          deviceId,
          closedFiscalYears: profile.closedFiscalYears,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'خطا در عملیات بستن حساب‌های پایان سال.';
        showToast(msg, 'error');
        return;
      }

      await createVoucher({
        date: plan.closingVoucher.date,
        description: plan.closingVoucher.description,
        voucherType: 'closing',
        status: 'permanent',
        lines: plan.closingVoucher.lines,
        allowDuplicate: true,
      });

      if (options?.createNextYearOpening && plan.nextYearOpeningVoucher.lines.length >= 2) {
        await createVoucher({
          date: plan.nextYearOpeningVoucher.date,
          description: plan.nextYearOpeningVoucher.description,
          voucherType: 'opening',
          status: 'permanent',
          lines: plan.nextYearOpeningVoucher.lines,
          allowDuplicate: true,
        });
      }

      const nextClosed = Array.from(new Set([...(profile.closedFiscalYears || []), fy]));
      await updateCompanyProfile({
        closedFiscalYears: nextClosed,
        ...(options?.createNextYearOpening ? { fiscalYear: plan.nextFiscalYear } : {}),
      });

      showToast(
        options?.createNextYearOpening
          ? `سال مالی ${fy} بسته و قفل شد و سند افتتاحیه تراز سال ${plan.nextFiscalYear} صادر گردید.`
          : `سند اختتامیه سال مالی ${fy} صادر و دوره مالی قفل شد.`,
        'success'
      );
    },
    [
      accounts,
      vouchers,
      profile.fiscalYear,
      profile.closedFiscalYears,
      ownerId,
      deviceId,
      createVoucher,
      updateCompanyProfile,
      showToast,
    ]
  );

  // ---------------- MULTI-CURRENCY & DAILY EXCHANGE RATES ----------------
  const addCurrency = useCallback(
    async (cur: Omit<CurrencyDefinition, 'id' | 'ownerId' | 'isBase'>): Promise<boolean> => {
      const code = normalizeCurrencyCode(cur.code).replace(/[^A-Z0-9_-]/g, '').slice(0, 10);
      if (!code || code.length < 2) {
        showToast('کد ارز باید حداقل ۲ حرف لاتین (مثلاً USD، TRY یا GBP) باشد.');
        return false;
      }
      if (currencies.some((c) => normalizeCurrencyCode(c.code) === code)) {
        showToast(`ارز با کد ${code} قبلاً تعریف شده است.`);
        return false;
      }
      const id = generateSafeId('cur');
      const full: CurrencyDefinition = {
        id,
        ownerId,
        code,
        name: cur.name.trim().slice(0, 80),
        symbol: (cur.symbol.trim() || code).slice(0, 16),
        isBase: false,
        decimalPlaces: Math.min(4, Math.max(0, Math.round(Number(cur.decimalPlaces) || 2))),
        defaultRateToIrr: Math.max(1, Math.round(Number(cur.defaultRateToIrr) || 1)),
        active: Boolean(cur.active),
      };

      if (user) {
        try {
          await setDoc(doc(db, 'currencies', id), {
            ownerId,
            code: full.code,
            name: full.name,
            symbol: full.symbol,
            isBase: false,
            decimalPlaces: full.decimalPlaces,
            defaultRateToIrr: full.defaultRateToIrr,
            active: full.active,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.CREATE, `currencies/${id}`);
          return false;
        }
      } else {
        setCurrencies((prev) => [...prev, full]);
      }

      // Also seed an initial daily rate entry for today so it's immediately usable
      const rateId = generateSafeId('fx');
      const today = getTodayShamsi();
      const rateEntry: ExchangeRateEntry = {
        id: rateId,
        ownerId,
        currencyCode: full.code,
        date: today,
        rateToIrr: full.defaultRateToIrr,
        rateType: 'market',
        notes: 'نرخ اولیه هنگام تعریف ارز',
      };
      if (user) {
        try {
          await setDoc(doc(db, 'exchangeRates', rateId), {
            ownerId,
            currencyCode: rateEntry.currencyCode,
            date: rateEntry.date,
            rateToIrr: rateEntry.rateToIrr,
            rateType: rateEntry.rateType,
            notes: rateEntry.notes,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.CREATE, `exchangeRates/${rateId}`);
        }
      } else {
        setExchangeRates((prev) => [rateEntry, ...prev]);
      }

      showToast(`ارز «${full.name} (${full.code})» با موفقیت تعریف شد.`);
      return true;
    },
    [currencies, ownerId, user, showToast]
  );

  const updateCurrency = useCallback(
    async (
      currencyId: string,
      patch: Partial<
        Pick<CurrencyDefinition, 'name' | 'symbol' | 'decimalPlaces' | 'defaultRateToIrr' | 'active'>
      >
    ) => {
      const existing = currencies.find((c) => c.id === currencyId);
      if (!existing) return;
      const safePatch: Partial<CurrencyDefinition> = {};
      if (patch.name !== undefined) safePatch.name = patch.name.trim().slice(0, 80);
      if (patch.symbol !== undefined) safePatch.symbol = patch.symbol.trim().slice(0, 16);
      if (patch.decimalPlaces !== undefined) {
        safePatch.decimalPlaces = Math.min(4, Math.max(0, Math.round(Number(patch.decimalPlaces) || 0)));
      }
      if (patch.defaultRateToIrr !== undefined) {
        safePatch.defaultRateToIrr = existing.isBase
          ? 1
          : Math.max(1, Math.round(Number(patch.defaultRateToIrr) || 1));
      }
      if (patch.active !== undefined) {
        safePatch.active = existing.isBase ? true : Boolean(patch.active);
      }

      if (user) {
        try {
          await updateDoc(doc(db, 'currencies', currencyId), {
            ...safePatch,
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.UPDATE, `currencies/${currencyId}`);
        }
      } else {
        setCurrencies((prev) =>
          prev.map((c) => (c.id === currencyId ? { ...c, ...safePatch } : c))
        );
      }
      showToast(`مشخصات ارز «${existing.code}» به‌روزرسانی شد.`);
    },
    [currencies, user, showToast]
  );

  const deleteCurrency = useCallback(
    async (currencyId: string): Promise<boolean> => {
      const target = currencies.find((c) => c.id === currencyId);
      if (!target) return false;
      if (target.isBase || normalizeCurrencyCode(target.code) === BASE_CURRENCY_CODE) {
        showToast('ارز پایه دفاتر (ریال ایران) قابل حذف نیست.');
        return false;
      }
      const code = normalizeCurrencyCode(target.code);
      const usedInVoucher = vouchers.some((v) => normalizeCurrencyCode(v.currencyCode) === code);
      const usedInInvoice = invoices.some((i) => normalizeCurrencyCode(i.currencyCode) === code);
      if (usedInVoucher || usedInInvoice) {
        showToast('این ارز در اسناد یا فاکتورهای ثبت‌شده استفاده شده است؛ می‌توانید آن را غیرفعال کنید.');
        return false;
      }
      if (user) {
        try {
          await deleteDoc(doc(db, 'currencies', currencyId));
        } catch (err) {
          handleFirestoreError(err, OperationType.DELETE, `currencies/${currencyId}`);
          return false;
        }
      } else {
        setCurrencies((prev) => prev.filter((c) => c.id !== currencyId));
      }
      showToast(`ارز «${target.name} (${target.code})» حذف شد.`);
      return true;
    },
    [currencies, vouchers, invoices, user, showToast]
  );

  const upsertExchangeRate = useCallback(
    async (entry: Omit<ExchangeRateEntry, 'id' | 'ownerId'>) => {
      const code = normalizeCurrencyCode(entry.currencyCode);
      if (code === BASE_CURRENCY_CODE) {
        showToast('نرخ برابری ارز پایه (IRR) همواره برابر ۱ ریال است.');
        return;
      }
      const cleanDate = entry.date.trim().slice(0, 20);
      const cleanRate = Math.max(1, Math.round(Number(entry.rateToIrr) || 0));
      const cleanNotes = entry.notes?.trim().slice(0, 200);

      const existing = exchangeRates.find(
        (r) => normalizeCurrencyCode(r.currencyCode) === code && r.date === cleanDate
      );

      if (existing) {
        if (user) {
          try {
            await updateDoc(doc(db, 'exchangeRates', existing.id), {
              currencyCode: code,
              date: cleanDate,
              rateToIrr: cleanRate,
              rateType: entry.rateType,
              ...(cleanNotes !== undefined ? { notes: cleanNotes } : {}),
              updatedAt: serverTimestamp(),
            });
          } catch (err) {
            handleFirestoreError(err, OperationType.UPDATE, `exchangeRates/${existing.id}`);
          }
        } else {
          setExchangeRates((prev) =>
            prev.map((r) =>
              r.id === existing.id
                ? {
                    ...r,
                    rateToIrr: cleanRate,
                    rateType: entry.rateType,
                    notes: cleanNotes,
                  }
                : r
            )
          );
        }
        showToast(`نرخ روز ${code} در تاریخ ${cleanDate} به‌روزرسانی شد.`);
      } else {
        const id = generateSafeId('fx');
        const full: ExchangeRateEntry = {
          id,
          ownerId,
          currencyCode: code,
          date: cleanDate,
          rateToIrr: cleanRate,
          rateType: entry.rateType,
          ...(cleanNotes ? { notes: cleanNotes } : {}),
        };
        if (user) {
          try {
            await setDoc(doc(db, 'exchangeRates', id), {
              ownerId,
              currencyCode: full.currencyCode,
              date: full.date,
              rateToIrr: full.rateToIrr,
              rateType: full.rateType,
              ...(cleanNotes ? { notes: cleanNotes } : {}),
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            });
          } catch (err) {
            handleFirestoreError(err, OperationType.CREATE, `exchangeRates/${id}`);
          }
        } else {
          setExchangeRates((prev) => [full, ...prev]);
        }
        showToast(`نرخ روز ${code} برای تاریخ ${cleanDate} ثبت شد.`);
      }

      // Sync currency's defaultRateToIrr if this date is >= latest existing date
      const curDef = currencies.find((c) => normalizeCurrencyCode(c.code) === code);
      if (curDef && !curDef.isBase) {
        const latestExistingDate = exchangeRates
          .filter((r) => normalizeCurrencyCode(r.currencyCode) === code)
          .map((r) => r.date)
          .sort((a, b) => b.localeCompare(a))[0];
        if (!latestExistingDate || cleanDate >= latestExistingDate) {
          if (user) {
            try {
              await updateDoc(doc(db, 'currencies', curDef.id), {
                defaultRateToIrr: cleanRate,
                updatedAt: serverTimestamp(),
              });
            } catch {
              // Non-blocking fallback sync
            }
          } else {
            setCurrencies((prev) =>
              prev.map((c) => (c.id === curDef.id ? { ...c, defaultRateToIrr: cleanRate } : c))
            );
          }
        }
      }
    },
    [exchangeRates, currencies, ownerId, user, showToast]
  );

  const deleteExchangeRate = useCallback(
    async (rateId: string) => {
      if (user) {
        try {
          await deleteDoc(doc(db, 'exchangeRates', rateId));
        } catch (err) {
          handleFirestoreError(err, OperationType.DELETE, `exchangeRates/${rateId}`);
        }
      } else {
        setExchangeRates((prev) => prev.filter((r) => r.id !== rateId));
      }
      showToast('رکورد نرخ روز ارز حذف شد.');
    },
    [user, showToast]
  );

  // ---------------- ACTIVITY AUDIT LOG ----------------
  const logActivity = useCallback(
    (
      module: string,
      action: string,
      details: string,
      meta?: Partial<
        Pick<
          AuditActivityLog,
          | 'operationType'
          | 'beforeValue'
          | 'afterValue'
          | 'reason'
          | 'relatedVoucherId'
          | 'relatedOperationId'
        >
      >
    ) => {
      const nowTime = new Date().toLocaleTimeString('fa-IR', {
        hour: '2-digit',
        minute: '2-digit',
      });
      const entry: AuditActivityLog = {
        id: generateSafeId('log'),
        ownerId,
        timestamp: `${getTodayShamsi()} · ${nowTime}`,
        isoTimestamp: new Date().toISOString(),
        userId: user?.uid || activeOperator.id,
        deviceId,
        operatorName: activeOperator.fullName,
        operatorRole: activeOperator.role,
        module,
        action,
        ...(meta || {}),
        details: `${details} [${deviceLabel}]`,
      };
      if (user) {
        setDoc(doc(db, 'auditLogs', entry.id), {
          ownerId: entry.ownerId,
          timestamp: entry.timestamp.slice(0, 40),
          operatorName: entry.operatorName.slice(0, 120),
          operatorRole: entry.operatorRole,
          module: entry.module.slice(0, 80),
          action: entry.action.slice(0, 160),
          details: entry.details.slice(0, 400),
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        }).catch(() => {
          // Best-effort audit log sync
        });
      }
      setAuditLogs((prev) => [entry, ...prev].slice(0, 300));
    },
    [user, ownerId, activeOperator, deviceId, deviceLabel]
  );

  // ---------------- IMPORT DOSSIERS & LANDED COST ----------------
  const addImportDossier = useCallback(
    async (dossier: Omit<ImportDossier, 'id' | 'ownerId'>) => {
      const full: ImportDossier = {
        ...dossier,
        id: generateSafeId('imp'),
        ownerId,
        _version: 1,
        updatedByDevice: deviceId,
      };
      if (user) {
        try {
          const { id: _omitId, ...rest } = full;
          void _omitId;
          const cleanPayload = Object.fromEntries(
            Object.entries(rest).filter(([, v]) => v !== undefined)
          );
          await setDoc(doc(db, 'importDossiers', full.id), {
            ...cleanPayload,
            dossierNumber: full.dossierNumber.slice(0, 48),
            proformaNumber: full.proformaNumber.slice(0, 64),
            ...(full.cotageNumber ? { cotageNumber: full.cotageNumber.slice(0, 64) } : {}),
            supplierName: full.supplierName.slice(0, 160),
            originCountry: full.originCountry.slice(0, 80),
            warehouse: full.warehouse.slice(0, 80),
            currencyCode: full.currencyCode.slice(0, 10),
            items: full.items.slice(0, 100),
            costs: full.costs.slice(0, 100),
            updatedByDevice: deviceId.slice(0, 64),
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.WRITE, `importDossiers/${full.id}`);
        }
      } else {
        setImportDossiers((prev) => [full, ...prev]);
      }
      logActivity(
        'واردات و ترخیص',
        `ایجاد پرونده واردات ${full.dossierNumber}`,
        `پروفرما ${full.proformaNumber} · جمع بهای تمام‌شده ${full.grandTotalLandedIrr.toLocaleString('en-US')} ریال`
      );
      showToast(`پرونده واردات ${full.dossierNumber} ثبت شد.`);
    },
    [user, ownerId, deviceId, logActivity, showToast]
  );

  const clearImportDossier = useCallback(
    async (dossierId: string) => {
      if (!activeOperator.permissions.canCreateVoucher || !activeOperator.permissions.canEditInventory) {
        showToast('نقش فعال مجوز همزمان ترخیص انبار و صدور سند بهای تمام‌شده را ندارد.');
        return;
      }
      const dossier = importDossiers.find((d) => d.id === dossierId);
      if (!dossier || dossier.status === 'cleared') {
        showToast('این پرونده واردات قبلاً ترخیص و وارد انبار شده است.');
        return;
      }

      // Separate recoverable customs VAT (30302) from capitalizable landed costs (10501) FIRST
      // so sum(agg.totalCostIrr) equals GL 10501 debit to 0 Rial with zero rounding drift
      let capitalizableCostsTotal = 0;
      let recoverableVatTotal = 0;
      for (const c of dossier.costs) {
        const amt = Math.round(Number(c.amountIrr) || 0);
        if (amt <= 0) continue;
        if (c.isRecoverableVat) {
          recoverableVatTotal += amt;
        } else {
          capitalizableCostsTotal += amt;
        }
      }
      const targetInventoryDebitIrr = Math.round(dossier.totalFobIrr) + capitalizableCostsTotal;

      // Aggregate duplicate productIds in the same dossier for exact costLayer & inventoryValueIrr sync
      const aggregatedItems = new Map<
        string,
        { totalWeightKg: number; totalCostIrr: number; lotNumber?: string }
      >();
      for (const item of dossier.items) {
        if (!item.productId || item.weightKg <= 0) continue;
        const itemTotalCost =
          item.totalItemLandedIrr !== undefined
            ? Math.round(item.totalItemLandedIrr)
            : Math.round(item.weightKg * item.finalUnitCostIrr);
        const cur = aggregatedItems.get(item.productId) || {
          totalWeightKg: 0,
          totalCostIrr: 0,
          lotNumber: item.lotNumber,
        };
        cur.totalWeightKg = Number((cur.totalWeightKg + item.weightKg).toFixed(2));
        cur.totalCostIrr += itemTotalCost;
        if (item.lotNumber) cur.lotNumber = item.lotNumber;
        aggregatedItems.set(item.productId, cur);
      }

      // Absorb any integer rounding residual into the last item so subledger === GL 10501 to 0 Rial
      const allocatedSum = Array.from(aggregatedItems.values()).reduce((s, x) => s + x.totalCostIrr, 0);
      const residualIrr = targetInventoryDebitIrr - allocatedSum;
      if (residualIrr !== 0 && aggregatedItems.size > 0) {
        const lastKey = Array.from(aggregatedItems.keys())[aggregatedItems.size - 1];
        const lastAgg = aggregatedItems.get(lastKey);
        if (lastAgg) {
          lastAgg.totalCostIrr = Math.max(0, lastAgg.totalCostIrr + residualIrr);
        }
      }

      const clearanceDate = getTodayShamsi();
      const costingMethod = profile.defaultCostingMethod ?? 'fifo';

      // Atomic multi-device guard & FIFO/MWA costLayer inventory update
      if (user) {
        try {
          await runTransaction(db, async (tx) => {
            const dossierRef = doc(db, 'importDossiers', dossierId);
            const dossierSnap = await tx.get(dossierRef);
            if (!dossierSnap.exists()) {
              throw new Error('DOSSIER_NOT_FOUND');
            }
            const currentDossier = dossierSnap.data() as ImportDossier;
            if (currentDossier.status === 'cleared') {
              throw new Error('ALREADY_CLEARED');
            }

            const prodSnapshots: {
              ref: ReturnType<typeof doc>;
              data: Product;
              agg: { totalWeightKg: number; totalCostIrr: number; lotNumber?: string };
            }[] = [];
            for (const [productId, agg] of aggregatedItems.entries()) {
              const pRef = doc(db, 'products', productId);
              const pSnap = await tx.get(pRef);
              if (pSnap.exists()) {
                prodSnapshots.push({ ref: pRef, data: pSnap.data() as Product, agg });
              }
            }

            for (const { ref, data: liveProd, agg } of prodSnapshots) {
              const liveState = normalizeProductCostState(liveProd, costingMethod, clearanceDate);
              const step = applyInventoryMovementStep(liveState, {
                id: `imp_${dossierId}_${liveProd.id}`,
                date: clearanceDate,
                kind: 'purchase',
                productId: liveProd.id,
                warehouse: liveProd.warehouse,
                qty: agg.totalWeightKg,
                totalCostIrr: agg.totalCostIrr,
                sourceRefId: dossierId,
                allowNegativeStock: true,
              });
              tx.update(ref, {
                stock: step.nextState.stockQty,
                buyPrice: step.nextState.weightedAvgUnitCostIrr,
                costLayers: step.nextState.layers,
                inventoryValueIrr: step.nextState.totalValueIrr,
                ...(agg.lotNumber ? { lotNumber: agg.lotNumber } : {}),
                _version: (liveProd._version ?? 1) + 1,
                updatedByDevice: deviceId,
                updatedAt: serverTimestamp(),
              });
            }

            tx.update(dossierRef, {
              status: 'cleared',
              _version: (currentDossier._version ?? 1) + 1,
              updatedByDevice: deviceId,
              updatedAt: serverTimestamp(),
            });
          });
        } catch (err) {
          if (err instanceof Error && err.message === 'ALREADY_CLEARED') {
            showToast('این پرونده همزمان توسط دستگاه دیگری ترخیص شده است.');
            return;
          }
          handleFirestoreError(err, OperationType.UPDATE, `importDossiers/${dossierId}`);
          return;
        }
      } else {
        for (const [productId, agg] of aggregatedItems.entries()) {
          const prod = products.find((p) => p.id === productId);
          if (!prod) continue;
          const curState = normalizeProductCostState(prod, costingMethod, clearanceDate);
          const step = applyInventoryMovementStep(curState, {
            id: `imp_${dossierId}_${prod.id}`,
            date: clearanceDate,
            kind: 'purchase',
            productId: prod.id,
            warehouse: prod.warehouse,
            qty: agg.totalWeightKg,
            totalCostIrr: agg.totalCostIrr,
            sourceRefId: dossierId,
            allowNegativeStock: true,
          });
          await updateProduct(prod.id, {
            stock: step.nextState.stockQty,
            buyPrice: step.nextState.weightedAvgUnitCostIrr,
            costLayers: step.nextState.layers,
            inventoryValueIrr: step.nextState.totalValueIrr,
            lotNumber: agg.lotNumber || prod.lotNumber,
          });
        }
      }

      const inventoryDebitIrr = targetInventoryDebitIrr;

      // Build 100%-balanced double-entry Landed Cost clearance voucher
      // Only the foreign supplier FOB line carries foreignCredit; all Rial lines explicitly set 0/0
      const lines: VoucherLine[] = [
        {
          accountCode: '10501',
          accountTitle: 'موجودی انبار نخ و کالای وارداتی',
          description: `ورود محموله ترخیص‌شده پرونده ${dossier.dossierNumber} (کوتاژ ${dossier.cotageNumber || '—'}) با سرشکن هزینه‌ها`,
          debit: inventoryDebitIrr,
          credit: 0,
          foreignDebit: 0,
          foreignCredit: 0,
        },
      ];

      if (recoverableVatTotal > 0) {
        lines.push({
          accountCode: '30302',
          accountTitle: 'مالیات ارزش افزوده خرید و اعتبار گمرکی',
          description: `مالیات ارزش افزوده قابل کسر گمرکی پرونده ${dossier.dossierNumber} (کوتاژ ${dossier.cotageNumber || '—'})`,
          debit: recoverableVatTotal,
          credit: 0,
          foreignDebit: 0,
          foreignCredit: 0,
        });
      }

      lines.push({
        accountCode: '30101',
        accountTitle: 'بستانکاران و تأمین‌کنندگان واردات نخ',
        partyId: dossier.supplierId,
        partyName: dossier.supplierName,
        description: `بهای ارزی پروفرما ${dossier.proformaNumber} (${dossier.totalForeignAmount} ${dossier.currencyCode})`,
        debit: 0,
        credit: Math.round(dossier.totalFobIrr),
        fxCurrencyCode: dossier.currencyCode,
        foreignDebit: 0,
        foreignCredit: dossier.totalForeignAmount,
      });

      // Group landed costs (including recoverable VAT settlement) by settlement account + partyId
      const costByKey = new Map<
        string,
        { accountCode: string; title: string; partyId?: string; partyName?: string; total: number }
      >();
      for (const c of dossier.costs) {
        const amt = Math.round(Number(c.amountIrr) || 0);
        if (amt <= 0) continue;
        const acc = accounts.find((a) => a.code === c.accountCode);
        const resolvedPartyId =
          c.accountCode === '30101' ? c.partyId || dossier.supplierId : c.partyId;
        const resolvedPartyName =
          c.accountCode === '30101' ? c.partyName || dossier.supplierName : c.partyName;
        const key = `${c.accountCode}|${resolvedPartyId || ''}`;
        const cur = costByKey.get(key) || {
          accountCode: c.accountCode,
          title: acc?.title || 'بانک ملت — حساب جاری شرکتی',
          partyId: resolvedPartyId,
          partyName: resolvedPartyName,
          total: 0,
        };
        cur.total += amt;
        costByKey.set(key, cur);
      }

      for (const info of costByKey.values()) {
        lines.push({
          accountCode: info.accountCode,
          accountTitle: info.title,
          ...(info.partyId ? { partyId: info.partyId, partyName: info.partyName } : {}),
          description: `هزینه‌های جانبی، حمل، بیمه و گمرک پرونده ${dossier.dossierNumber}`,
          debit: 0,
          credit: info.total,
          foreignDebit: 0,
          foreignCredit: 0,
        });
      }

      const v = await createVoucher({
        date: dossier.date || getTodayShamsi(),
        description: `ترخیص گمرکی و ورود به انبار پرونده واردات ${dossier.dossierNumber} (${dossier.originCountry})`,
        voucherType: 'purchase',
        status: 'permanent',
        lines,
        referenceId: dossier.id,
        currencyCode: dossier.currencyCode,
        exchangeRate: dossier.exchangeRate,
      });

      if (user) {
        try {
          await updateDoc(doc(db, 'importDossiers', dossierId), {
            voucherId: v.id,
            totalRecoverableVatIrr: recoverableVatTotal,
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.UPDATE, `importDossiers/${dossierId}`);
        }
      } else {
        setImportDossiers((prev) =>
          prev.map((d) =>
            d.id === dossierId
              ? {
                  ...d,
                  status: 'cleared',
                  voucherId: v.id,
                  totalRecoverableVatIrr: recoverableVatTotal,
                }
              : d
          )
        );
      }
      logActivity(
        'واردات و ترخیص',
        `ترخیص و قطعی‌سازی پرونده ${dossier.dossierNumber}`,
        `سند #${v.voucherNumber} ثبت شد و موجودی و بهای میانگین موزون کالاها به‌روزرسانی گردید.`
      );
      showToast(`پرونده ${dossier.dossierNumber} ترخیص، وارد انبار و سند #${v.voucherNumber} صادر شد.`);
    },
    [
      user,
      deviceId,
      activeOperator,
      importDossiers,
      products,
      accounts,
      updateProduct,
      createVoucher,
      logActivity,
      showToast,
    ]
  );

  // ---------------- SALES ORDERS & WEIGHBRIDGE DISPATCH ----------------
  const addSalesOrder = useCallback(
    async (order: Omit<SalesOrder, 'id' | 'ownerId'>) => {
      const full: SalesOrder = {
        ...order,
        id: generateSafeId('so'),
        ownerId,
        _version: 1,
        updatedByDevice: deviceId,
      };
      if (user) {
        try {
          const { id: _omitId, ...rest } = full;
          void _omitId;
          const cleanPayload = Object.fromEntries(
            Object.entries(rest).filter(([, v]) => v !== undefined)
          );
          await setDoc(doc(db, 'salesOrders', full.id), {
            ...cleanPayload,
            orderNumber: full.orderNumber.slice(0, 48),
            partyName: full.partyName.slice(0, 160),
            warehouse: full.warehouse.slice(0, 80),
            ...(full.notes ? { notes: full.notes.slice(0, 300) } : {}),
            items: full.items.slice(0, 100),
            updatedByDevice: deviceId.slice(0, 64),
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.WRITE, `salesOrders/${full.id}`);
        }
      } else {
        setSalesOrders((prev) => [full, ...prev]);
      }
      logActivity(
        'سفارش و حواله خروج',
        `ثبت سفارش مشتری ${full.orderNumber}`,
        `مشتری: ${full.partyName} · ${full.items.length} ردیف نخ`
      );
      showToast(`سفارش فروش ${full.orderNumber} ثبت شد.`);
    },
    [user, ownerId, deviceId, logActivity, showToast]
  );

  const dispatchSalesOrder = useCallback(
    async (
      orderId: string,
      payload: {
        dispatchDate: string;
        driverName: string;
        plateNumber: string;
        items: SalesOrder['items'];
      }
    ) => {
      const order = salesOrders.find((o) => o.id === orderId);
      if (!order) return;
      const dispatchNumber =
        order.dispatchNumber || `DSP-${profile.fiscalYear}-${Math.floor(100 + Math.random() * 899)}`;
      if (user) {
        try {
          await updateDoc(doc(db, 'salesOrders', orderId), {
            dispatchNumber,
            dispatchDate: payload.dispatchDate,
            driverName: payload.driverName,
            plateNumber: payload.plateNumber,
            items: payload.items,
            status: 'dispatched',
            _version: (order._version ?? 1) + 1,
            updatedByDevice: deviceId,
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.UPDATE, `salesOrders/${orderId}`);
          return;
        }
      } else {
        setSalesOrders((prev) =>
          prev.map((o) =>
            o.id === orderId
              ? {
                  ...o,
                  dispatchNumber,
                  dispatchDate: payload.dispatchDate,
                  driverName: payload.driverName,
                  plateNumber: payload.plateNumber,
                  items: payload.items,
                  status: 'dispatched',
                  _version: (o._version ?? 1) + 1,
                  updatedByDevice: deviceId,
                }
              : o
          )
        );
      }
      logActivity(
        'انبار و باسکول',
        `صدور حواله خروج ${dispatchNumber}`,
        `توزین نهایی سفارش ${order.orderNumber} (${order.partyName})`
      );
      showToast(`حواله خروج باسکول ${dispatchNumber} ثبت شد.`);
    },
    [user, deviceId, salesOrders, profile.fiscalYear, logActivity, showToast]
  );

  const invoiceSalesOrder = useCallback(
    async (orderId: string) => {
      if (!activeOperator.permissions.canIssueInvoice) {
        showToast('نقش فعال مجوز صدور فاکتور فروش را ندارد.');
        return;
      }
      const order = salesOrders.find((o) => o.id === orderId);
      if (!order || order.status === 'invoiced') {
        showToast('این سفارش قبلاً به فاکتور فروش تبدیل شده است.');
        return;
      }

      if (user) {
        try {
          await runTransaction(db, async (tx) => {
            const oRef = doc(db, 'salesOrders', orderId);
            const oSnap = await tx.get(oRef);
            if (!oSnap.exists()) throw new Error('ORDER_NOT_FOUND');
            const liveOrder = oSnap.data() as SalesOrder;
            if (liveOrder.status === 'invoiced') throw new Error('ALREADY_INVOICED');
            tx.update(oRef, {
              status: 'invoiced',
              _version: (liveOrder._version ?? 1) + 1,
              updatedByDevice: deviceId,
              updatedAt: serverTimestamp(),
            });
          });
        } catch (err) {
          if (err instanceof Error && err.message === 'ALREADY_INVOICED') {
            showToast('این سفارش همزمان توسط دستگاه دیگری به فاکتور تبدیل شده است.');
            return;
          }
          handleFirestoreError(err, OperationType.UPDATE, `salesOrders/${orderId}`);
          return;
        }
      }

      const invItems = order.items.map((it) => {
        const prod = products.find((p) => p.id === it.productId);
        const qty = it.actualWeighedKg > 0 ? it.actualWeighedKg : it.orderedWeightKg;
        const gross = Math.round(qty * it.unitPriceIrr);
        const vat = prod?.vatExempt ? 0 : Math.round(gross * 0.1);
        return {
          productId: it.productId,
          sku: it.sku,
          productName: it.productName,
          unit: 'کیلوگرم',
          quantity: qty,
          secondaryUnit: prod?.secondaryUnit || 'کارتن',
          kgPerCarton: prod?.kgPerCarton,
          cartonCount: it.actualCartons || it.orderedCartons,
          lotNumber: it.lotNumber || prod?.lotNumber,
          unitPrice: it.unitPriceIrr,
          unitCostSnapshot: prod?.buyPrice,
          discount: 0,
          vatAmount: vat,
          lineTotal: gross + vat,
        };
      });

      const subtotal = invItems.reduce((s, i) => s + Math.round(i.quantity * i.unitPrice), 0);
      const vatAmount = invItems.reduce((s, i) => s + i.vatAmount, 0);
      const grandTotal = subtotal + vatAmount;
      const nextNum = `F-${profile.fiscalYear}-${String(invoices.length + 101)}`;

      let created: Invoice;
      try {
        created = await createInvoice({
          invoiceNumber: nextNum,
          invoiceType: 'sale',
          date: order.dispatchDate || getTodayShamsi(),
          partyId: order.partyId,
          partyName: order.partyName,
          warehouse: order.warehouse,
          items: invItems,
          subtotal,
          discount: 0,
          vatAmount,
          grandTotal,
          paidCash: 0,
          paidBank: 0,
          paidCheque: 0,
          creditAmount: grandTotal,
          status: 'issued',
        });
      } catch (err) {
        if (user) {
          await updateDoc(doc(db, 'salesOrders', orderId), {
            status: order.status,
            updatedAt: serverTimestamp(),
          }).catch(() => {});
        }
        throw err;
      }

      if (user) {
        try {
          await updateDoc(doc(db, 'salesOrders', orderId), {
            invoiceId: created.id,
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.UPDATE, `salesOrders/${orderId}`);
        }
      } else {
        setSalesOrders((prev) =>
          prev.map((o) =>
            o.id === orderId ? { ...o, status: 'invoiced', invoiceId: created.id } : o
          )
        );
      }
      logActivity(
        'سفارش و فاکتور',
        `تبدیل حواله ${order.dispatchNumber || order.orderNumber} به فاکتور ${created.invoiceNumber}`,
        `فاکتور فروش نهایی بر اساس وزن واقعی باسکول به مبلغ ${grandTotal.toLocaleString('en-US')} ریال صادر شد.`
      );
    },
    [
      user,
      deviceId,
      activeOperator,
      salesOrders,
      products,
      profile.fiscalYear,
      invoices.length,
      createInvoice,
      logActivity,
      showToast,
    ]
  );

  // ---------------- DYEING / WEAVING SUBCONTRACTING ----------------
  const addSubcontractJob = useCallback(
    async (job: Omit<SubcontractJob, 'id' | 'ownerId'>) => {
      const rawProd = products.find((p) => p.id === job.rawProductId);
      const liveUnitCost = rawProd?.buyPrice ?? job.rawUnitCostIrr;
      const full: SubcontractJob = {
        ...job,
        rawUnitCostIrr: liveUnitCost,
        id: generateSafeId('sub'),
        ownerId,
        _version: 1,
        updatedByDevice: deviceId,
      };
      if (user) {
        try {
          const { id: _omitId, ...rest } = full;
          void _omitId;
          const cleanPayload = Object.fromEntries(
            Object.entries(rest).filter(([, v]) => v !== undefined)
          );
          await setDoc(doc(db, 'subcontractJobs', full.id), {
            ...cleanPayload,
            jobNumber: full.jobNumber.slice(0, 48),
            contractorName: full.contractorName.slice(0, 160),
            rawProductName: full.rawProductName.slice(0, 180),
            finishedProductName: full.finishedProductName.slice(0, 180),
            ...(full.notes ? { notes: full.notes.slice(0, 300) } : {}),
            updatedByDevice: deviceId.slice(0, 64),
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.WRITE, `subcontractJobs/${full.id}`);
        }
      } else {
        setSubcontractJobs((prev) => [full, ...prev]);
      }
      logActivity(
        'پیمانکاری رنگرزی/بافندگی',
        `ارسال نخ خام (${full.jobNumber})`,
        `${full.sentWeightKg} کیلوگرم ${full.rawProductName} به ${full.contractorName}`
      );
      showToast(`حواله پیمانکاری ${full.jobNumber} ثبت شد.`);
    },
    [user, ownerId, deviceId, products, logActivity, showToast]
  );

  const completeSubcontractJob = useCallback(
    async (
      jobId: string,
      payload: {
        returnedWeightKg: number;
        completionDate: string;
        finishedLotNumber: string;
        includeServiceVat?: boolean;
      }
    ) => {
      const job = subcontractJobs.find((j) => j.id === jobId);
      if (!job || job.status === 'completed') {
        showToast('این حواله پیمانکاری قبلاً تکمیل شده است.');
        return;
      }
      if (!Number.isFinite(payload.returnedWeightKg) || payload.returnedWeightKg <= 0) {
        showToast('وزن برگشتی از کارگاه باید بزرگ‌تر از صفر باشد.');
        return;
      }
      if (payload.returnedWeightKg > job.sentWeightKg * 1.15) {
        showToast('وزن برگشتی بیش از حد مجاز نسبت به وزن ارسالی است.');
        return;
      }

      const rawProd = products.find((p) => p.id === job.rawProductId);
      if (rawProd && rawProd.stock + 0.001 < job.sentWeightKg) {
        showToast(
          `موجودی نخ خام «${rawProd.name}» (${rawProd.stock} کیلوگرم) کمتر از وزن ارسالی (${job.sentWeightKg} کیلوگرم) است.`
        );
        return;
      }

      let liveRawUnitCost = rawProd?.buyPrice || job.rawUnitCostIrr;

      const completionDate = getTodayShamsi();
      const costingMethod = profile.defaultCostingMethod ?? 'fifo';
      let rawTotalCost = Math.round(job.sentWeightKg * liveRawUnitCost);

      // Atomic multi-device guard & FIFO/MWA raw stock deduction (costLayers + inventoryValueIrr synced)
      if (user) {
        try {
          await runTransaction(db, async (tx) => {
            const jobRef = doc(db, 'subcontractJobs', jobId);
            const jobSnap = await tx.get(jobRef);
            if (!jobSnap.exists()) throw new Error('SUB_NOT_FOUND');
            const liveJob = jobSnap.data() as SubcontractJob;
            if (liveJob.status === 'completed') throw new Error('ALREADY_COMPLETED');

            if (rawProd) {
              const rawRef = doc(db, 'products', rawProd.id);
              const rawSnap = await tx.get(rawRef);
              if (rawSnap.exists()) {
                const liveRaw = rawSnap.data() as Product;
                if ((Number(liveRaw.stock) || 0) + 0.001 < job.sentWeightKg) {
                  throw new Error('INSUFFICIENT_RAW_STOCK');
                }
                const liveRawState = normalizeProductCostState(liveRaw, costingMethod, completionDate);
                const rawStep = applyInventoryMovementStep(liveRawState, {
                  id: `sub_raw_${jobId}`,
                  date: completionDate,
                  kind: 'shortage',
                  productId: liveRaw.id,
                  warehouse: liveRaw.warehouse,
                  qty: job.sentWeightKg,
                  sourceRefId: jobId,
                  allowNegativeStock: false,
                });
                rawTotalCost = Math.round(rawStep.cogsOrCostIrr);
                liveRawUnitCost = rawStep.effectiveUnitCostIrr || liveRawUnitCost;
                tx.update(rawRef, {
                  stock: rawStep.nextState.stockQty,
                  buyPrice: rawStep.nextState.weightedAvgUnitCostIrr,
                  costLayers: rawStep.nextState.layers,
                  inventoryValueIrr: rawStep.nextState.totalValueIrr,
                  _version: (liveRaw._version ?? 1) + 1,
                  updatedByDevice: deviceId,
                  updatedAt: serverTimestamp(),
                });
              }
            }

            tx.update(jobRef, {
              status: 'completed',
              _version: (liveJob._version ?? 1) + 1,
              updatedByDevice: deviceId,
              updatedAt: serverTimestamp(),
            });
          });
        } catch (err) {
          if (err instanceof Error && err.message === 'ALREADY_COMPLETED') {
            showToast('این عملیات پیمانکاری همزمان توسط دستگاه دیگری تکمیل شده است.');
            return;
          }
          if (err instanceof Error && err.message === 'INSUFFICIENT_RAW_STOCK') {
            showToast('موجودی نخ خام در انبار برای کسر کافی نیست.');
            return;
          }
          handleFirestoreError(err, OperationType.UPDATE, `subcontractJobs/${jobId}`);
          return;
        }
      } else if (rawProd) {
        const rawState = normalizeProductCostState(rawProd, costingMethod, completionDate);
        const rawStep = applyInventoryMovementStep(rawState, {
          id: `sub_raw_${jobId}`,
          date: completionDate,
          kind: 'shortage',
          productId: rawProd.id,
          warehouse: rawProd.warehouse,
          qty: job.sentWeightKg,
          sourceRefId: jobId,
          allowNegativeStock: false,
        });
        rawTotalCost = Math.round(rawStep.cogsOrCostIrr);
        liveRawUnitCost = rawStep.effectiveUnitCostIrr || liveRawUnitCost;
        await updateProduct(rawProd.id, {
          stock: rawStep.nextState.stockQty,
          buyPrice: rawStep.nextState.weightedAvgUnitCostIrr,
          costLayers: rawStep.nextState.layers,
          inventoryValueIrr: rawStep.nextState.totalValueIrr,
        });
      }

      // Compute Normal vs Abnormal Loss (IAS 2 / استاندارد حسابداری ۸: افت غیرعادی به هزینه ۸۰۴۰۱ می‌رود و بهای کالا را متورم نمی‌کند)
      const normalLossKg = Number((job.sentWeightKg * (job.expectedLossPct / 100)).toFixed(2));
      const actualLossKg = Math.max(0, Number((job.sentWeightKg - payload.returnedWeightKg).toFixed(2)));
      const abnormalLossKg = Math.max(0, Number((actualLossKg - normalLossKg).toFixed(2)));

      const abnormalLossCostIrr = Math.min(
        rawTotalCost,
        Math.round(abnormalLossKg * liveRawUnitCost)
      );
      const serviceFeeTotal = Math.round(payload.returnedWeightKg * job.serviceFeePerKgIrr);
      const serviceVatIrr = payload.includeServiceVat ? Math.round(serviceFeeTotal * 0.1) : 0;
      const finishedInventoryCost = Math.max(0, rawTotalCost - abnormalLossCostIrr) + serviceFeeTotal;
      const finishedUnitCost =
        payload.returnedWeightKg > 0
          ? Math.round(finishedInventoryCost / payload.returnedWeightKg)
          : liveRawUnitCost;

      await addProduct({
        sku: `FIN-${job.jobNumber}`,
        name: job.finishedProductName,
        category: job.processType === 'dyeing' ? 'نخ رنگ‌شده (پیمانکاری)' : 'محصول تبدیل‌شده پیمانکاری',
        warehouse: rawProd?.warehouse || 'انبار مرکزی نخ شادآباد',
        unit: 'کیلوگرم',
        secondaryUnit: rawProd?.secondaryUnit || 'کارتن',
        kgPerCarton: rawProd?.kgPerCarton || 25,
        lotNumber: payload.finishedLotNumber,
        originCountry: 'تکمیل داخلی',
        buyPrice: finishedUnitCost,
        sellPrice: Math.round(finishedUnitCost * 1.18),
        stock: payload.returnedWeightKg,
        reorderPoint: 100,
        vatExempt: false,
        costingMethod,
        inventoryValueIrr: finishedInventoryCost,
        costLayers:
          payload.returnedWeightKg > 0
            ? [
                {
                  layerId: `lyr_sub_${job.id}`,
                  date: completionDate,
                  sourceRef: job.id,
                  warehouse: rawProd?.warehouse || 'انبار مرکزی نخ شادآباد',
                  originalQty: payload.returnedWeightKg,
                  remainingQty: payload.returnedWeightKg,
                  unitCostIrr: finishedUnitCost,
                  totalCostIrr: finishedInventoryCost,
                },
              ]
            : [],
      });

      const voucherLines: VoucherLine[] = [
        {
          accountCode: '10501',
          accountTitle: 'موجودی انبار نخ و کالای وارداتی',
          description: `ورود ${payload.returnedWeightKg} کیلوگرم محصول تکمیل‌شده ${job.jobNumber} (بهای استاندارد پس از کسر افت غیرعادی)`,
          debit: finishedInventoryCost,
          credit: 0,
        },
      ];

      if (abnormalLossCostIrr > 0) {
        voucherLines.push({
          accountCode: '80401',
          accountTitle: 'کسری باسکول، انبارگردانی و ضایعات نخ',
          costCenterId: 'cc_warehouse',
          description: `افت غیرعادی پیمانکاری ${job.jobNumber} (${abnormalLossKg} کیلوگرم مازاد بر افت مجاز ${job.expectedLossPct}٪)`,
          debit: abnormalLossCostIrr,
          credit: 0,
        });
      }

      if (serviceVatIrr > 0) {
        voucherLines.push({
          accountCode: '30302',
          accountTitle: 'مالیات ارزش افزوده خرید و اعتبار گمرکی',
          description: `۱۰٪ مالیات ارزش افزوده اجرت پیمانکاری ${job.jobNumber}`,
          debit: serviceVatIrr,
          credit: 0,
        });
      }

      voucherLines.push(
        {
          accountCode: '10501',
          accountTitle: 'موجودی انبار نخ و کالای وارداتی',
          description: `مصرف ${job.sentWeightKg} کیلوگرم نخ خام (${job.rawProductName})`,
          debit: 0,
          credit: rawTotalCost,
        },
        {
          accountCode: '30101',
          accountTitle: 'بستانکاران و تأمین‌کنندگان واردات نخ',
          partyId: job.contractorPartyId,
          partyName: job.contractorName,
          description:
            serviceVatIrr > 0
              ? `اجرت پیمانکاری رنگرزی/تبدیل ${job.jobNumber} به همراه ۱۰٪ ارزش افزوده`
              : `اجرت پیمانکاری رنگرزی/تبدیل ${job.jobNumber}`,
          debit: 0,
          credit: serviceFeeTotal + serviceVatIrr,
        }
      );

      const v = await createVoucher({
        date: payload.completionDate,
        description: `تکمیل عملیات پیمانکاری ${job.jobNumber} (${job.finishedProductName} — لات ${payload.finishedLotNumber})`,
        voucherType: 'general',
        status: 'permanent',
        lines: voucherLines,
        referenceId: job.id,
      });

      const completionPatch = {
        status: 'completed' as const,
        completionDate: payload.completionDate,
        returnedWeightKg: payload.returnedWeightKg,
        finishedLotNumber: payload.finishedLotNumber,
        rawUnitCostIrr: liveRawUnitCost,
        abnormalLossKg,
        abnormalLossCostIrr,
        serviceVatIrr,
        totalServiceFeeIrr: serviceFeeTotal,
        finishedUnitCostIrr: finishedUnitCost,
        voucherId: v.id,
      };

      if (user) {
        try {
          await updateDoc(doc(db, 'subcontractJobs', jobId), {
            ...completionPatch,
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.UPDATE, `subcontractJobs/${jobId}`);
        }
      } else {
        setSubcontractJobs((prev) =>
          prev.map((j) => (j.id === jobId ? { ...j, ...completionPatch } : j))
        );
      }

      logActivity(
        'پیمانکاری رنگرزی/بافندگی',
        `اتمام و ورود محصول ${job.jobNumber}`,
        `بازگشت ${payload.returnedWeightKg} کیلوگرم با لات ${payload.finishedLotNumber}${abnormalLossKg > 0 ? ` (افت غیرعادی ${abnormalLossKg} کیلوگرم به هزینه ۸۰۴۰۱)` : ''} و ثبت سند #${v.voucherNumber}`
      );
      showToast(`عملیات پیمانکاری ${job.jobNumber} تکمیل و سند #${v.voucherNumber} ثبت شد.`);
    },
    [
      user,
      deviceId,
      subcontractJobs,
      products,
      updateProduct,
      addProduct,
      createVoucher,
      logActivity,
      showToast,
    ]
  );

  // ---------------- FX REVALUATION & BROKER COMMISSION VOUCHERS ----------------
  const postFxRevaluationVoucher = useCallback(
    async (rows: FxRevaluationRow[], date: string) => {
      const nonZero = rows.filter((r) => Math.abs(r.revaluationDiffIrr) >= 1);
      if (nonZero.length === 0) {
        showToast('هیچ اختلاف تسعیر ارزی برای صدور سند وجود ندارد.');
        return;
      }

      const lines: VoucherLine[] = [];
      let netDiff = 0;
      for (const r of nonZero) {
        netDiff += r.revaluationDiffIrr;
        if (r.revaluationDiffIrr > 0) {
          lines.push({
            accountCode: r.accountCode,
            accountTitle: r.accountTitle,
            partyId: r.partyId,
            partyName: r.partyName,
            description: `تعدیل مثبت تسعیر ${r.currencyCode} به نرخ ${r.currentRateToIrr.toLocaleString('en-US')} ریال`,
            debit: r.revaluationDiffIrr,
            credit: 0,
            fxCurrencyCode: r.currencyCode,
            foreignDebit: 0,
            foreignCredit: 0,
          });
        } else {
          lines.push({
            accountCode: r.accountCode,
            accountTitle: r.accountTitle,
            partyId: r.partyId,
            partyName: r.partyName,
            description: `تعدیل منفی تسعیر ${r.currencyCode} به نرخ ${r.currentRateToIrr.toLocaleString('en-US')} ریال`,
            debit: 0,
            credit: Math.abs(r.revaluationDiffIrr),
            fxCurrencyCode: r.currencyCode,
            foreignDebit: 0,
            foreignCredit: 0,
          });
        }
      }

      if (netDiff > 0) {
        lines.push({
          accountCode: '60901',
          accountTitle: 'سود ناشی از تسعیر دارایی‌ها و بدهی‌های ارزی',
          description: `شناسایی سود خالص تسعیر ارز تا تاریخ ${date}`,
          debit: 0,
          credit: netDiff,
          foreignDebit: 0,
          foreignCredit: 0,
        });
      } else if (netDiff < 0) {
        lines.push({
          accountCode: '80901',
          accountTitle: 'زیان تسعیر ارز و کارمزدهای بانکی',
          description: `شناسایی زیان خالص تسعیر ارز تا تاریخ ${date}`,
          debit: Math.abs(netDiff),
          credit: 0,
          foreignDebit: 0,
          foreignCredit: 0,
        });
      }

      const v = await createVoucher({
        date,
        description: `سند تسعیر ارز دارایی‌ها و بدهی‌های ارزی پایان دوره (${date})`,
        voucherType: 'general',
        status: 'permanent',
        lines,
      });
      logActivity(
        'ارز و تسعیر',
        `صدور سند تسعیر ارز #${v.voucherNumber}`,
        `${nonZero.length} ردیف ارزی تسعیر شد (خالص: ${netDiff >= 0 ? 'سود' : 'زیان'} ${Math.abs(netDiff).toLocaleString('en-US')} ریال)`
      );
      showToast(`سند تسعیر ارز #${v.voucherNumber} با موفقیت صادر شد.`);
    },
    [createVoucher, logActivity, showToast]
  );

  const postBrokerCommissionVoucher = useCallback(
    async (payload: {
      partyId: string;
      partyName: string;
      amountIrr: number;
      date: string;
      periodLabel: string;
    }) => {
      const amount = Math.round(payload.amountIrr);
      if (amount <= 0) return;
      const v = await createVoucher({
        date: payload.date,
        description: `هزینه پورسانت کارگزاری فروش ${payload.partyName} — ${payload.periodLabel}`,
        voucherType: 'general',
        status: 'permanent',
        lines: [
          {
            accountCode: '80501',
            accountTitle: 'پورسانت کارگزاران بازار و حمل بار نخ',
            description: `پورسانت فروش ${payload.partyName} (${payload.periodLabel})`,
            debit: amount,
            credit: 0,
          },
          {
            accountCode: '30101',
            accountTitle: 'بستانکاران و تأمین‌کنندگان واردات نخ',
            partyId: payload.partyId,
            partyName: payload.partyName,
            description: `بستانکاری پورسانت ${payload.partyName}`,
            debit: 0,
            credit: amount,
          },
        ],
      });
      logActivity(
        'پورسانت فروش',
        `صدور سند پورسانت #${v.voucherNumber}`,
        `${payload.partyName} به مبلغ ${amount.toLocaleString('en-US')} ریال`
      );
      showToast(`سند پورسانت ${payload.partyName} (#${v.voucherNumber}) صادر شد.`);
    },
    [createVoucher, logActivity, showToast]
  );

  // ---------------- RBAC OPERATORS CRUD ----------------
  const addRbacOperator = useCallback(
    async (op: Omit<RbacOperator, 'id' | 'ownerId'>) => {
      const full: RbacOperator = { ...op, id: generateSafeId('op'), ownerId };
      if (user) {
        try {
          await setDoc(doc(db, 'rbacOperators', full.id), {
            ownerId: full.ownerId,
            fullName: full.fullName.trim().slice(0, 140),
            role: full.role,
            ...(full.email ? { email: full.email.trim().slice(0, 200) } : {}),
            active: Boolean(full.active),
            permissions: full.permissions,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.WRITE, `rbacOperators/${full.id}`);
        }
      } else {
        setRbacOperators((prev) => [...prev, full]);
      }
      logActivity('مدیریت کاربران', `تعریف کاربر ${full.fullName}`, `نقش: ${full.role}`);
      showToast(`کاربر «${full.fullName}» به لیست اپراتورها اضافه شد.`);
    },
    [user, ownerId, logActivity, showToast]
  );

  const updateRbacOperator = useCallback(
    async (
      opId: string,
      patch: Partial<Pick<RbacOperator, 'fullName' | 'role' | 'email' | 'active' | 'permissions'>>
    ) => {
      if (user) {
        try {
          await updateDoc(doc(db, 'rbacOperators', opId), {
            ...patch,
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.UPDATE, `rbacOperators/${opId}`);
        }
      } else {
        setRbacOperators((prev) => prev.map((o) => (o.id === opId ? { ...o, ...patch } : o)));
      }
      logActivity('مدیریت کاربران', 'ویرایش سطح دسترسی کاربر', `شناسه اپراتور: ${opId}`);
      showToast('سطح دسترسی کاربر به‌روزرسانی شد.');
    },
    [user, logActivity, showToast]
  );

  const deleteRbacOperator = useCallback(
    async (opId: string) => {
      if (rbacOperators.length <= 1) {
        showToast('حداقل یک کاربر مدیر در سیستم باید باقی بماند.');
        return;
      }
      if (user) {
        try {
          await deleteDoc(doc(db, 'rbacOperators', opId));
        } catch (err) {
          handleFirestoreError(err, OperationType.DELETE, `rbacOperators/${opId}`);
        }
      } else {
        setRbacOperators((prev) => prev.filter((o) => o.id !== opId));
      }
      if (activeOperatorId === opId) {
        const next = rbacOperators.find((o) => o.id !== opId);
        if (next) setActiveOperatorId(next.id);
      }
      logActivity('مدیریت کاربران', 'حذف اپراتور', `شناسه اپراتور: ${opId}`);
      showToast('اپراتور حذف شد.');
    },
    [user, rbacOperators, activeOperatorId, logActivity, showToast]
  );

  // ---------------- BACKUP & RESTORE (CLOUD + LOCAL DEVICE STORAGE) ----------------
  const exportBackupJson = useCallback(() => {
    return JSON.stringify(
      {
        version: 'holoo-apex-1.3',
        exportedAt: new Date().toISOString(),
        deviceId,
        deviceLabel,
        profile,
        accounts,
        parties,
        products,
        vouchers,
        invoices,
        cheques,
        employees,
        assets,
        costCenters,
        currencies,
        exchangeRates,
        importDossiers,
        salesOrders,
        subcontractJobs,
        rbacOperators,
        auditLogs,
      },
      null,
      2
    );
  }, [
    deviceId,
    deviceLabel,
    profile,
    accounts,
    parties,
    products,
    vouchers,
    invoices,
    cheques,
    employees,
    assets,
    costCenters,
    currencies,
    exchangeRates,
    importDossiers,
    salesOrders,
    subcontractJobs,
    rbacOperators,
    auditLogs,
  ]);

  const reopenFiscalYear = useCallback(
    async (fiscalYear: string, reason: string): Promise<boolean> => {
      const nowTime = new Date().toLocaleTimeString('fa-IR', {
        hour: '2-digit',
        minute: '2-digit',
      });
      const res = planPeriodReopening({
        fiscalYear,
        closedFiscalYears: profile.closedFiscalYears || [],
        reason,
        operatorName: activeOperator.fullName,
        operatorRole: activeOperator.role,
        userId: user?.uid || activeOperator.id,
        deviceId,
        timestampShamsi: `${getTodayShamsi()} · ${nowTime}`,
      });
      if (!res.ok) {
        showToast(res.error, 'error');
        return false;
      }

      await updateCompanyProfile({
        closedFiscalYears: res.plan.updatedClosedFiscalYears,
      });

      logActivity(
        res.plan.auditRecord.module,
        res.plan.auditRecord.action,
        res.plan.auditRecord.details,
        {
          operationType: 'period_reopen',
          beforeValue: res.plan.auditRecord.beforeValue,
          afterValue: res.plan.auditRecord.afterValue,
          reason: res.plan.auditRecord.reason,
        }
      );

      showToast(
        `سال مالی ${fiscalYear} با ثبت کامل سوابق بازگشایی شد. برای اصلاح سند اختتامیه، از صدور سند معکوس استفاده کنید.`,
        'warning'
      );
      return true;
    },
    [
      profile.closedFiscalYears,
      activeOperator,
      user,
      deviceId,
      updateCompanyProfile,
      logActivity,
      showToast,
    ]
  );

  const commitHolo203Migration = useCallback(
    async (source: Holo203SourcePayload): Promise<HoloMigrationResult> => {
      // Law #1: Always capture a verified pre-migration local backup before touching state
      const preBackupJson = exportBackupJson();
      await saveLocalSnapshot({
        payloadJson: preBackupJson,
        reason: 'pre_migration',
        companyName: profile.companyName,
        voucherCount: vouchers.length,
        invoiceCount: invoices.length,
        productCount: products.length,
      }).catch(() => null);

      const result = runHolo203Migration({
        source,
        existing: { accounts, parties, products, vouchers },
        ownerId,
        defaultFiscalYear: profile.fiscalYear,
        dryRun: false,
      });

      if (!result.canCommit) {
        showToast(
          `مهاجرت از هلو ۲.۰.۳ به دلیل ${result.errors.length} خطای ساختاری یا عدم توازن متوقف شد.`,
          'error'
        );
        return result;
      }

      if (result.newlyAdded.accounts.length > 0) {
        setAccounts((prev) => [...prev, ...result.newlyAdded.accounts]);
      }
      if (result.newlyAdded.parties.length > 0) {
        setParties((prev) => [...prev, ...result.newlyAdded.parties]);
      }
      if (result.newlyAdded.products.length > 0) {
        setProducts((prev) => [...prev, ...result.newlyAdded.products]);
      }
      if (result.newlyAdded.vouchers.length > 0) {
        setVouchers((prev) => [...prev, ...result.newlyAdded.vouchers]);
      }

      logActivity(
        'مهاجرت از هلو ۲.۰.۳',
        'اجرای موفق مهاجرت افزایشی و مقاوم در برابر تکرار',
        `حساب جدید: ${result.newlyAdded.accounts.length} · شخص جدید: ${result.newlyAdded.parties.length} · کالا جدید: ${result.newlyAdded.products.length} · سند جدید: ${result.newlyAdded.vouchers.length}`,
        {
          operationType: 'migration',
          beforeValue: JSON.stringify({
            accounts: accounts.length,
            parties: parties.length,
            products: products.length,
            vouchers: vouchers.length,
          }),
          afterValue: JSON.stringify({
            accounts: result.mergedData.accounts.length,
            parties: result.mergedData.parties.length,
            products: result.mergedData.products.length,
            vouchers: result.mergedData.vouchers.length,
          }),
        }
      );

      showToast(
        `مهاجرت از هلو ۲.۰.۳ با پشتیبان پیش‌ازانتقال تکمیل شد (${result.newlyAdded.vouchers.length} سند، ${result.newlyAdded.products.length} کالا، ${result.newlyAdded.parties.length} شخص جدید).`,
        'success'
      );
      return result;
    },
    [
      exportBackupJson,
      profile.companyName,
      profile.fiscalYear,
      accounts,
      parties,
      products,
      vouchers,
      invoices.length,
      ownerId,
      logActivity,
      showToast,
    ]
  );

  const importBackupJson = useCallback(
    (jsonText: string): boolean => {
      try {
        if (typeof jsonText !== 'string' || jsonText.length === 0 || jsonText.length > 8_000_000) {
          showToast('حجم یا قالب فایل پشتیبان مجاز نیست.');
          return false;
        }
        // Strip prototype pollution keys during JSON parse
        const parsed = JSON.parse(jsonText, (key, value) => {
          if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
            return undefined;
          }
          return value;
        }) as Record<string, unknown>;

        if (
          !parsed ||
          typeof parsed !== 'object' ||
          !Array.isArray(parsed.accounts) ||
          !Array.isArray(parsed.vouchers)
        ) {
          showToast('ساختار فایل پشتیبان معتبر نیست.');
          return false;
        }

        const safeAccounts = (parsed.accounts as Account[])
          .filter((a) => a && typeof a === 'object' && typeof a.code === 'string' && typeof a.title === 'string')
          .slice(0, 2000);

        const safeVouchers = (parsed.vouchers as Voucher[])
          .filter(
            (v) =>
              v &&
              typeof v === 'object' &&
              Array.isArray(v.lines) &&
              v.lines.length >= 2 &&
              v.lines.every(
                (l) =>
                  l &&
                  typeof l === 'object' &&
                  typeof l.accountCode === 'string' &&
                  Number.isFinite(Number(l.debit)) &&
                  Number.isFinite(Number(l.credit)) &&
                  Number(l.debit) >= 0 &&
                  Number(l.credit) >= 0
              )
          )
          .slice(0, 5000);

        if (safeAccounts.length === 0) {
          showToast('فایل پشتیبان فاقد کدینگ حساب‌های معتبر است.');
          return false;
        }

        if (parsed.profile && typeof parsed.profile === 'object') {
          const pr = parsed.profile as Partial<CompanyProfile>;
          setProfile((p) => ({
            ...p,
            ...(typeof pr.companyName === 'string' ? { companyName: pr.companyName.slice(0, 160) } : {}),
            ...(typeof pr.displayName === 'string' ? { displayName: pr.displayName.slice(0, 120) } : {}),
            ...(typeof pr.fiscalYear === 'string' ? { fiscalYear: pr.fiscalYear.slice(0, 16) } : {}),
            ...(typeof pr.economicCode === 'string' ? { economicCode: pr.economicCode.slice(0, 32) } : {}),
            ...(typeof pr.nationalId === 'string' ? { nationalId: pr.nationalId.slice(0, 32) } : {}),
            ...(pr.currencyUnit === 'IRR' || pr.currencyUnit === 'IRT' ? { currencyUnit: pr.currencyUnit } : {}),
          }));
        }

        const safeList = <T,>(val: unknown, limit = 3000): T[] =>
          Array.isArray(val) ? (val.filter((item) => item && typeof item === 'object').slice(0, limit) as T[]) : [];

        setAccounts(safeAccounts);
        setParties(safeList<Party>(parsed.parties));
        setProducts(safeList<Product>(parsed.products));
        setVouchers(safeVouchers);
        setInvoices(safeList<Invoice>(parsed.invoices));
        setCheques(safeList<Cheque>(parsed.cheques));
        setEmployees(safeList<Employee>(parsed.employees));
        setAssets(safeList<FixedAsset>(parsed.assets));
        setCostCenters(safeList<CostCenter>(parsed.costCenters));

        const safeCurrencies = safeList<CurrencyDefinition>(parsed.currencies, 100);
        if (safeCurrencies.length > 0) setCurrencies(safeCurrencies);
        if (Array.isArray(parsed.exchangeRates)) {
          setExchangeRates(safeList<ExchangeRateEntry>(parsed.exchangeRates, 2000));
        }
        if (Array.isArray(parsed.importDossiers)) {
          setImportDossiers(safeList<ImportDossier>(parsed.importDossiers, 1000));
        }
        if (Array.isArray(parsed.salesOrders)) {
          setSalesOrders(safeList<SalesOrder>(parsed.salesOrders, 2000));
        }
        if (Array.isArray(parsed.subcontractJobs)) {
          setSubcontractJobs(safeList<SubcontractJob>(parsed.subcontractJobs, 1000));
        }
        const safeOperators = safeList<RbacOperator>(parsed.rbacOperators, 100);
        if (safeOperators.length > 0) setRbacOperators(safeOperators);
        if (Array.isArray(parsed.auditLogs)) {
          setAuditLogs(safeList<AuditActivityLog>(parsed.auditLogs, 2000));
        }
        showToast('فایل پشتیبان حسابداری با اعتبارسنجی کامل بازیابی و بارگذاری شد.');
        return true;
      } catch {
        showToast('خطا در خواندن فایل پشتیبان JSON.');
        return false;
      }
    },
    [showToast]
  );

  const resetWorkspaceTables = useCallback(
    async (options: {
      mode: 'blank' | 'demo';
      keepChartOfAccounts?: boolean;
      keepCompanyProfile?: boolean;
    }): Promise<{ ok: boolean; summary: string }> => {
      const ownerId = user?.uid || DEMO_OWNER;
      const seed = createHolooSeedData(ownerId);

      if (options.mode === 'demo') {
        if (!options.keepCompanyProfile) {
          setProfile((prev) => ({
            ...DEFAULT_PROFILE,
            uid: ownerId,
            email: user?.email || prev.email || DEFAULT_PROFILE.email,
          }));
        }
        setAccounts(seed.accounts);
        setParties(seed.parties);
        setProducts(seed.products);
        setVouchers(seed.vouchers);
        setInvoices(seed.invoices);
        setCheques(seed.cheques);
        setEmployees(seed.employees);
        setAssets(seed.assets);
        setCostCenters(seed.costCenters);
        setCurrencies(seed.currencies);
        setExchangeRates(seed.exchangeRates);
        setImportDossiers(seed.importDossiers);
        setSalesOrders(seed.salesOrders);
        setSubcontractJobs(seed.subcontractJobs);
        setRbacOperators(seed.rbacOperators);
        setActiveOperatorId(seed.rbacOperators[0]?.id || 'op_admin');
        setAuditLogs(seed.auditLogs);
        showToast('تمامی جدول‌ها و داده‌های برنامه به حالت نمونه اولیه بازنشانی شد.');
        return {
          ok: true,
          summary: 'بازنشانی به داده‌های نمونه اولیه با موفقیت انجام شد.',
        };
      }

      // mode === 'blank': Factory-clean empty tables (preserving standard Iranian chart of accounts unless requested otherwise)
      const keepAccounts = options.keepChartOfAccounts !== false;
      const baseSystemAccounts = keepAccounts
        ? seed.accounts
        : seed.accounts.filter((a) => a.level === 'kol' || a.isSystem);
      const defaultAdminOp = seed.rbacOperators[0]
        ? [seed.rbacOperators[0]]
        : rbacOperators.slice(0, 1);

      if (!options.keepCompanyProfile) {
        setProfile((prev) => ({
          ...prev,
          companyName: 'شرکت جدید (خام)',
          economicCode: '',
          nationalId: '',
          fiscalYear: '1405',
          currencyUnit: prev.currencyUnit,
        }));
      }

      setAccounts(baseSystemAccounts);
      setParties([]);
      setProducts([]);
      setVouchers([]);
      setInvoices([]);
      setCheques([]);
      setEmployees([]);
      setAssets([]);
      setCostCenters([]);
      setCurrencies(seed.currencies.slice(0, 1));
      setExchangeRates([]);
      setImportDossiers([]);
      setSalesOrders([]);
      setSubcontractJobs([]);
      setRbacOperators(defaultAdminOp);
      if (defaultAdminOp[0]?.id) {
        setActiveOperatorId(defaultAdminOp[0].id);
      }
      setAuditLogs([]);

      showToast(
        keepAccounts
          ? 'تمام جدول‌های عملیاتی (اسناد، فاکتورها، انبار، طرف‌حساب و چک‌ها) خام شدند و کدینگ پایه حفظ شد.'
          : 'تمامی جدول‌ها و داده‌های برنامه به وضعیت کاملاً خام بازنشانی شدند.'
      );
      return {
        ok: true,
        summary: keepAccounts
          ? 'خام‌سازی جداول عملیاتی با حفظ کدینگ استاندارد حساب‌ها انجام شد.'
          : 'خام‌سازی کامل تمام جداول و داده‌ها انجام شد.',
      };
    },
    [user?.uid, user?.email, rbacOperators, showToast]
  );

  // Keep latest state snapshot in a ref so synchronous beforeunload/pagehide never reads stale closure
  const latestBackupRef = useRef<{
    exportFn: () => string;
    counts: {
      voucherCount: number;
      invoiceCount: number;
      productCount: number;
    };
    companyName: string;
    fiscalYear: string;
    autoEnabled: boolean;
  }>({
    exportFn: exportBackupJson,
    counts: {
      voucherCount: vouchers.length,
      invoiceCount: invoices.length,
      productCount: products.length,
    },
    companyName: profile.companyName,
    fiscalYear: profile.fiscalYear,
    autoEnabled: autoBackupOnClose,
  });

  useEffect(() => {
    latestBackupRef.current = {
      exportFn: exportBackupJson,
      counts: {
        voucherCount: vouchers.length,
        invoiceCount: invoices.length,
        productCount: products.length,
      },
      companyName: profile.companyName,
      fiscalYear: profile.fiscalYear,
      autoEnabled: autoBackupOnClose,
    };
  }, [
    exportBackupJson,
    vouchers.length,
    invoices.length,
    products.length,
    profile.companyName,
    profile.fiscalYear,
    autoBackupOnClose,
  ]);

  // Synchronous flush on close / tab hide + background IndexedDB rolling snapshot on close
  useEffect(() => {
    const handleBeforeClose = () => {
      const cur = latestBackupRef.current;
      if (!cur.autoEnabled) return;
      try {
        const payloadJson = cur.exportFn();
        saveSyncCloseSnapshot({
          payloadJson,
          reason: 'before_close',
          companyName: cur.companyName,
          ...cur.counts,
        });
        void saveLocalSnapshot({
          payloadJson,
          reason: 'before_close',
          companyName: cur.companyName,
          ...cur.counts,
        }).catch(() => {});
      } catch {
        // Ignore storage quota issues during unload
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        handleBeforeClose();
      }
    };

    window.addEventListener('beforeunload', handleBeforeClose);
    window.addEventListener('pagehide', handleBeforeClose);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeClose);
      window.removeEventListener('pagehide', handleBeforeClose);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  // Primary Operational IndexedDB Persistence + Fast offline-first mirror after any data change
  const hasMountedBackupRef = useRef(false);
  useEffect(() => {
    if (!hasMountedBackupRef.current) {
      hasMountedBackupRef.current = true;
      return;
    }

    const opDbTimer = window.setTimeout(async () => {
      try {
        await saveOperationalWorkspaceTx({
          profile,
          accounts,
          parties,
          products,
          vouchers,
          invoices,
          cheques,
          employees,
          assets,
          costCenters,
          currencies,
          exchangeRates,
          importDossiers,
          salesOrders,
          subcontractJobs,
          rbacOperators,
          auditLogs,
        });
        const stats = await getOperationalDbStats();
        setOperationalDbStats(stats);
      } catch {
        // Ignore transient IndexedDB quota/lock issues
      }
    }, 650);

    const fastTimer = window.setTimeout(() => {
      try {
        const cur = latestBackupRef.current;
        const payloadJson = cur.exportFn();
        saveSyncCloseSnapshot({
          payloadJson,
          reason: 'auto_change',
          companyName: cur.companyName,
          ...cur.counts,
        });
      } catch {
        // Ignore storage quota issues
      }
    }, 1200);

    const idbTimer = autoBackupOnClose
      ? window.setTimeout(async () => {
          try {
            const cur = latestBackupRef.current;
            const payloadJson = cur.exportFn();
            const meta = await saveLocalSnapshot({
              payloadJson,
              reason: 'auto_change',
              companyName: cur.companyName,
              ...cur.counts,
            });
            if (meta) setLastLocalBackupAt(meta.savedAtShamsi);
            const list = await listLocalSnapshots();
            setLocalSnapshots(list);
          } catch {
            // Ignore silent background backup error
          }
        }, 4200)
      : undefined;

    return () => {
      window.clearTimeout(opDbTimer);
      window.clearTimeout(fastTimer);
      if (idbTimer !== undefined) window.clearTimeout(idbTimer);
    };
  }, [
    autoBackupOnClose,
    profile,
    accounts,
    vouchers,
    invoices,
    products,
    parties,
    cheques,
    employees,
    assets,
    costCenters,
    currencies,
    exchangeRates,
    importDossiers,
    salesOrders,
    subcontractJobs,
    rbacOperators,
    auditLogs,
  ]);

  const triggerLocalBackupNow = useCallback(
    async (alsoDownload = false) => {
      const cur = latestBackupRef.current;
      const payloadJson = cur.exportFn();
      saveSyncCloseSnapshot({
        payloadJson,
        reason: 'manual',
        companyName: cur.companyName,
        ...cur.counts,
      });
      const meta = await saveLocalSnapshot({
        payloadJson,
        reason: 'manual',
        companyName: cur.companyName,
        ...cur.counts,
      });
      if (meta) setLastLocalBackupAt(meta.savedAtShamsi);
      const list = await listLocalSnapshots();
      setLocalSnapshots(list);
      if (alsoDownload) {
        downloadBackupFileToDevice(payloadJson, cur.fiscalYear);
        showToast('نسخه پشتیبان هم در حافظه داخلی دستگاه ذخیره و هم به صورت فایل دانلود شد.');
      } else {
        showToast('نسخه پشتیبان فوری با موفقیت در حافظه داخلی این دستگاه ذخیره شد.');
      }
    },
    [showToast]
  );

  const restoreFromLocalSnapshot = useCallback(
    async (snapshotId: string): Promise<boolean> => {
      const payload = await loadLocalSnapshotPayload(snapshotId);
      if (!payload) {
        showToast('فایل پشتیبان انتخاب‌شده در حافظه دستگاه یافت نشد.');
        return false;
      }
      return importBackupJson(payload);
    },
    [importBackupJson, showToast]
  );

  const removeLocalSnapshot = useCallback(
    async (snapshotId: string) => {
      await deleteLocalSnapshot(snapshotId);
      const list = await listLocalSnapshots();
      setLocalSnapshots(list);
      showToast('نسخه پشتیبان انتخاب‌شده از حافظه داخلی دستگاه حذف شد.');
    },
    [showToast]
  );

  return (
    <AccountingContext.Provider
      value={{
        user,
        authReady,
        isCloudMode,
        isSyncing,
        isSigningIn,
        deviceId,
        deviceLabel,
        setDeviceLabel,
        autoBackupOnClose,
        setAutoBackupOnClose,
        localSnapshots,
        lastLocalBackupAt,
        triggerLocalBackupNow,
        restoreFromLocalSnapshot,
        removeLocalSnapshot,
        profile,
        accounts,
        parties,
        products,
        vouchers,
        invoices,
        cheques,
        employees,
        assets,
        costCenters,
        currencies,
        exchangeRates,
        importDossiers,
        salesOrders,
        subcontractJobs,
        rbacOperators,
        activeOperator,
        setActiveOperatorId,
        auditLogs,
        trialBalance,
        incomeStatement,
        balanceSheet,
        partyBalances,
        auditReport,
        toast,
        showToast,
        audioEnabled,
        setAudioEnabled,
        includeDraftsInReports,
        setIncludeDraftsInReports,
        operationalDbStats,
        loginWithGoogle,
        logout,
        updateCompanyProfile,
        setCurrencyUnit,
        addAccount,
        updateAccount,
        deleteAccount,
        addParty,
        updateParty,
        deleteParty,
        addProduct,
        updateProduct,
        deleteProduct,
        adjustProductStock,
        adjustProductStockWithVoucher,
        bulkStocktakingWithVoucher,
        bulkUpdateProductPrices,
        transferProductWarehouse,
        createVoucher,
        updateVoucher,
        deleteVoucher,
        finalizeVoucher,
        finalizeAllDraftVouchers,
        createReversingVoucher,
        renumberVouchersChronologically,
        addCurrency,
        updateCurrency,
        deleteCurrency,
        upsertExchangeRate,
        deleteExchangeRate,
        createInvoice,
        cancelInvoice,
        convertProformaToSale,
        addCheque,
        updateCheque,
        updateChequeStatus,
        recordQuickTreasury,
        recordBankTransfer,
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
        reopenFiscalYear,
        commitHolo203Migration,
        addImportDossier,
        clearImportDossier,
        addSalesOrder,
        dispatchSalesOrder,
        invoiceSalesOrder,
        addSubcontractJob,
        completeSubcontractJob,
        postFxRevaluationVoucher,
        postBrokerCommissionVoucher,
        addRbacOperator,
        updateRbacOperator,
        deleteRbacOperator,
        logActivity,
        exportBackupJson,
        importBackupJson,
        resetWorkspaceTables,
      }}
    >
      {children}
    </AccountingContext.Provider>
  );
};

export function useAccounting() {
  const ctx = useContext(AccountingContext);
  if (!ctx) throw new Error('useAccounting must be used within AccountingProvider');
  return ctx;
}
