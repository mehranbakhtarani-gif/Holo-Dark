import * as XLSX from 'xlsx';
import {
  AccountCategory,
  AccountLevel,
  AccountNature,
  ActiveModule,
  ChequeDirection,
  ChequeStatus,
  InvoiceType,
  PartyType,
  VoucherType,
} from '../types/accounting';
import { getTodayShamsi } from './format';

export type UniversalImportEntity =
  | 'parties'
  | 'products'
  | 'accounts'
  | 'vouchers'
  | 'invoices'
  | 'cheques'
  | 'employees'
  | 'costCenters';

export interface UniversalFieldSchema {
  key: string;
  label: string;
  required?: boolean;
  hint: string;
  example: string;
  aliases: string[];
}

export interface UniversalEntitySchema {
  id: UniversalImportEntity;
  title: string;
  subtitle: string;
  fields: UniversalFieldSchema[];
  sampleRows: Record<string, string | number>[];
}

export interface ParsedExcelSheet {
  sheetName: string;
  sheetNames: string[];
  headers: string[];
  rows: Record<string, unknown>[];
}

export interface ImportRowError {
  rowIndex: number; // 1-based data row number (Excel row - 1)
  message: string;
}

export interface TransformedImportResult<T = Record<string, unknown>> {
  entity: UniversalImportEntity;
  totalRows: number;
  validRows: T[];
  errors: ImportRowError[];
}

export function normalizeHeaderToken(raw: string): string {
  return String(raw ?? '')
    .replace(/\uFEFF/g, '')
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/ة/g, 'ه')
    .replace(/إ|أ|آ/g, 'ا')
    .replace(/\u200c/g, ' ')
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 1776))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 1632))
    .toLowerCase()
    .replace(/[()\[\]{}«»"'`،,:؛;/\\\-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parsePersianExcelNumber(raw: unknown): number {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : 0;
  }
  const str = String(raw ?? '')
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 1776))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 1632))
    .replace(/[,٬،\s]/g, '')
    .replace(/ریال|تومان|تومن|کیلوگرم|کیلو|عدد/g, '')
    .replace(/[^\d.-]/g, '')
    .trim();
  if (!str) return 0;
  const parsed = Number(str);
  return Number.isFinite(parsed) ? parsed : 0;
}

function cleanStr(raw: unknown): string {
  return String(raw ?? '')
    .replace(/\uFEFF/g, '')
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک')
    .trim();
}

function normalizeShamsiDateCell(raw: unknown, fallback: string): string {
  const s = cleanStr(raw)
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 1776))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 1632))
    .replace(/[-.]/g, '/');
  const m = s.match(/^(1[34]\d{2})\/(\d{1,2})\/(\d{1,2})$/);
  if (!m) return fallback;
  return `${m[1]}/${m[2].padStart(2, '0')}/${m[3].padStart(2, '0')}`;
}

export const UNIVERSAL_IMPORT_SCHEMAS: Record<UniversalImportEntity, UniversalEntitySchema> = {
  parties: {
    id: 'parties',
    title: 'طرف‌حساب‌ها و اشخاص',
    subtitle: 'مشتریان، تأمین‌کنندگان، بازاریابان و مانده اول دوره',
    fields: [
      {
        key: 'name',
        label: 'نام طرف‌حساب / شرکت',
        required: true,
        hint: 'نام شخص حقیقی یا حقوقی',
        example: 'کارخانه نساجی پارس‌بافت',
        aliases: ['نام', 'نام طرف حساب', 'طرف حساب', 'مشتری', 'نام شرکت', 'شخص', 'name', 'party', 'customer'],
      },
      {
        key: 'code',
        label: 'کد تفصیلی',
        hint: 'کد یکتای شخص (در صورت خالی بودن خودکار ساخته می‌شود)',
        example: 'P-201',
        aliases: ['کد', 'کد تفصیلی', 'کد مشتری', 'کد شخص', 'code', 'party code', 'id'],
      },
      {
        key: 'partyType',
        label: 'نوع شخص',
        hint: 'مشتری، تأمین‌کننده، هردو یا واسطه',
        example: 'مشتری',
        aliases: ['نوع', 'نوع شخص', 'نوع طرف حساب', 'گروه', 'type', 'partytype'],
      },
      {
        key: 'phone',
        label: 'شماره تماس / موبایل',
        hint: 'تلفن ثابت یا همراه',
        example: '09123456789',
        aliases: ['تلفن', 'موبایل', 'همراه', 'شماره تماس', 'phone', 'mobile', 'tel'],
      },
      {
        key: 'nationalId',
        label: 'کد / شناسه ملی',
        hint: '۱۰ یا ۱۱ رقم',
        example: '14005566778',
        aliases: ['شناسه ملی', 'کد ملی', 'national id', 'nationalid'],
      },
      {
        key: 'economicCode',
        label: 'کد اقتصادی',
        hint: 'کد اقتصادی ۱۲ رقمی',
        example: '411223344556',
        aliases: ['کد اقتصادی', 'economic code', 'tax id'],
      },
      {
        key: 'creditLimit',
        label: 'سقف اعتبار (ریال)',
        hint: 'مبلغ سقف اعتبار ریالی',
        example: '5000000000',
        aliases: ['سقف اعتبار', 'اعتبار', 'credit limit', 'creditlimit'],
      },
      {
        key: 'openingBalance',
        label: 'مانده اول دوره (ریال)',
        hint: 'مثبت: بدهکار / منفی: بستانکار',
        example: '120000000',
        aliases: ['مانده', 'مانده اول دوره', 'مانده حساب', 'opening balance', 'balance'],
      },
      {
        key: 'address',
        label: 'نشانی',
        hint: 'آدرس دفتر یا کارخانه',
        example: 'یزد، شهرک صنعتی فاز ۲',
        aliases: ['آدرس', 'نشانی', 'address'],
      },
    ],
    sampleRows: [
      {
        'نام طرف‌حساب / شرکت': 'کارخانه بافندگی سپهر یزد',
        'کد تفصیلی': 'P-301',
        'نوع شخص': 'مشتری',
        'شماره تماس / موبایل': '09131510022',
        'کد / شناسه ملی': '14008945120',
        'کد اقتصادی': '411334455667',
        'سقف اعتبار (ریال)': 8000000000,
        'مانده اول دوره (ریال)': 450000000,
        'نشانی': 'یزد، شهرک صنعتی، بلوار کوشش',
      },
      {
        'نام طرف‌حساب / شرکت': 'بازرگانی واردات نخ خاورمیانه',
        'کد تفصیلی': 'P-302',
        'نوع شخص': 'تأمین‌کننده',
        'شماره تماس / موبایل': '02155667788',
        'کد / شناسه ملی': '10104455667',
        'کد اقتصادی': '411998877665',
        'سقف اعتبار (ریال)': 15000000000,
        'مانده اول دوره (ریال)': -600000000,
        'نشانی': 'تهران، بازار بزرگ، سرای امید',
      },
    ],
  },

  products: {
    id: 'products',
    title: 'کالاها و انبار',
    subtitle: 'معرفی کالاها، وزن کارتن، موجودی اولیه و قیمت خرید/فروش',
    fields: [
      {
        key: 'name',
        label: 'نام کالا / شرح نخ',
        required: true,
        hint: 'عنوان کامل کالا',
        example: 'نخ پلی‌استر DTY 150/48 سفید',
        aliases: ['نام کالا', 'شرح کالا', 'کالا', 'نام', 'شرح نخ', 'product', 'name', 'title'],
      },
      {
        key: 'sku',
        label: 'کد کالا (SKU)',
        hint: 'کد یکتای انبارداری',
        example: 'YN-150-99',
        aliases: ['کد کالا', 'کد', 'بارکد', 'sku', 'code', 'barcode'],
      },
      {
        key: 'category',
        label: 'گروه کالا',
        hint: 'دسته‌بندی کالا',
        example: 'نخ پلی‌استر DTY',
        aliases: ['گروه', 'گروه کالا', 'دسته', 'category', 'group'],
      },
      {
        key: 'warehouse',
        label: 'انبار',
        hint: 'نام انبار محل نگهداری',
        example: 'انبار مرکزی نخ',
        aliases: ['انبار', 'نام انبار', 'warehouse', 'store'],
      },
      {
        key: 'unit',
        label: 'واحد اصلی',
        hint: 'مثلاً کیلوگرم یا عدد',
        example: 'کیلوگرم',
        aliases: ['واحد', 'واحد اصلی', 'unit'],
      },
      {
        key: 'buyPrice',
        label: 'فی خرید (ریال)',
        hint: 'بهای تمام‌شده هر واحد به ریال',
        example: '1650000',
        aliases: ['قیمت خرید', 'فی خرید', 'نرخ خرید', 'بهای خرید', 'buy price', 'cost', 'buyprice'],
      },
      {
        key: 'sellPrice',
        label: 'فی فروش (ریال)',
        hint: 'قیمت فروش هر واحد به ریال',
        example: '1950000',
        aliases: ['قیمت فروش', 'فی فروش', 'نرخ فروش', 'قیمت', 'sell price', 'price', 'sellprice'],
      },
      {
        key: 'stock',
        label: 'موجودی اولیه',
        hint: 'مقدار موجودی به واحد اصلی',
        example: '1250',
        aliases: ['موجودی', 'موجودی اولیه', 'تعداد', 'وزن', 'stock', 'qty', 'quantity'],
      },
      {
        key: 'reorderPoint',
        label: 'حداقل موجودی (نقطه سفارش)',
        hint: 'آستانه هشدار کسری انبار',
        example: '300',
        aliases: ['حداقل موجودی', 'نقطه سفارش', 'حداقل', 'reorder', 'min stock', 'reorderpoint'],
      },
      {
        key: 'kgPerCarton',
        label: 'وزن هر کارتن (کیلو)',
        hint: 'ضریب تبدیل کارتن به کیلوگرم',
        example: '25',
        aliases: ['وزن کارتن', 'ضریب کارتن', 'kg per carton', 'kgpercarton'],
      },
      {
        key: 'lotNumber',
        label: 'شماره لات',
        hint: 'کد لات رنگرزی یا واردات',
        example: 'LOT-405-Z1',
        aliases: ['لات', 'شماره لات', 'سری ساخت', 'lot', 'batch'],
      },
    ],
    sampleRows: [
      {
        'نام کالا / شرح نخ': 'نخ پلی‌استر DTY 150/48 نیمه‌مات درجه یک',
        'کد کالا (SKU)': 'YN-DTY-150',
        'گروه کالا': 'نخ پلی‌استر DTY',
        'انبار': 'انبار مرکزی نخ',
        'واحد اصلی': 'کیلوگرم',
        'فی خرید (ریال)': 1680000,
        'فی فروش (ریال)': 1920000,
        'موجودی اولیه': 1850,
        'حداقل موجودی (نقطه سفارش)': 400,
        'وزن هر کارتن (کیلو)': 25,
        'شماره لات': 'LOT-405A',
      },
      {
        'نام کالا / شرح نخ': 'نخ پنبه شانه ۳۰/۱ هندی ممتاز',
        'کد کالا (SKU)': 'YN-COT-301',
        'گروه کالا': 'نخ پنبه شانه (Combed)',
        'انبار': 'انبار مرکزی نخ',
        'واحد اصلی': 'کیلوگرم',
        'فی خرید (ریال)': 2150000,
        'فی فروش (ریال)': 2450000,
        'موجودی اولیه': 220,
        'حداقل موجودی (نقطه سفارش)': 350,
        'وزن هر کارتن (کیلو)': 30,
        'شماره لات': 'LOT-405B',
      },
    ],
  },

  accounts: {
    id: 'accounts',
    title: 'کدینگ حساب‌ها (کل و معین)',
    subtitle: 'ساختار درختی حساب‌ها برای انتقال سرفصل از سایر سیستم‌ها',
    fields: [
      {
        key: 'code',
        label: 'کد حساب',
        required: true,
        hint: 'کد سرفصل کل یا معین (مثلاً ۱۰۲۰۵)',
        example: '10205',
        aliases: ['کد حساب', 'کد', 'شماره حساب', 'code', 'account code'],
      },
      {
        key: 'title',
        label: 'عنوان حساب',
        required: true,
        hint: 'نام سرفصل حسابداری',
        example: 'بانک سامان — حساب ارزی',
        aliases: ['عنوان حساب', 'عنوان', 'نام حساب', 'شرح حساب', 'title', 'name', 'account title'],
      },
      {
        key: 'level',
        label: 'سطح حساب',
        hint: 'گروه، کل، معین یا تفصیلی',
        example: 'معین',
        aliases: ['سطح', 'سطح حساب', 'level'],
      },
      {
        key: 'category',
        label: 'طبقه حساب',
        hint: 'دارایی، بدهی، سرمایه، درآمد، بهای تمام‌شده، هزینه',
        example: 'دارایی',
        aliases: ['طبقه', 'ماهیت طبقه', 'گروه حساب', 'category'],
      },
      {
        key: 'nature',
        label: 'ماهیت',
        hint: 'بدهکار، بستانکار یا هردو',
        example: 'بدهکار',
        aliases: ['ماهیت', 'nature'],
      },
      {
        key: 'parentCode',
        label: 'کد حساب والد',
        hint: 'کد کل یا گروه بالادستی',
        example: '102',
        aliases: ['کد والد', 'حساب والد', 'والد', 'parent', 'parent code'],
      },
    ],
    sampleRows: [
      {
        'کد حساب': '10209',
        'عنوان حساب': 'بانک پاسارگاد — حساب جاری تجاری',
        'سطح حساب': 'معین',
        'طبقه حساب': 'دارایی',
        'ماهیت': 'بدهکار',
        'کد حساب والد': '102',
      },
      {
        'کد حساب': '80309',
        'عنوان حساب': 'هزینه بسته‌بندی و لیبلینگ صادراتی',
        'سطح حساب': 'معین',
        'طبقه حساب': 'هزینه',
        'ماهیت': 'بدهکار',
        'کد حساب والد': '803',
      },
    ],
  },

  vouchers: {
    id: 'vouchers',
    title: 'اسناد حسابداری (دفتر روزنامه)',
    subtitle: 'ردیف‌های هم‌شماره به‌صورت خودکار در یک سند تراز گروه‌بندی می‌شوند',
    fields: [
      {
        key: 'groupKey',
        label: 'شماره / گروه سند',
        required: true,
        hint: 'ردیف‌های دارای شماره یکسان در یک سند ثبت می‌شوند',
        example: 'DOC-101',
        aliases: ['شماره سند', 'گروه سند', 'سند', 'عطف', 'voucher', 'voucher number', 'doc'],
      },
      {
        key: 'date',
        label: 'تاریخ سند (شمسی)',
        hint: 'فرمت ۱۴۰۵/۰۱/۱۵',
        example: '1405/05/12',
        aliases: ['تاریخ', 'تاریخ سند', 'date'],
      },
      {
        key: 'accountCode',
        label: 'کد معین',
        required: true,
        hint: 'کد سرفصل حسابداری (مثلاً ۱۰۲۰۱)',
        example: '80201',
        aliases: ['کد معین', 'کد حساب', 'معین', 'حساب', 'account code', 'account'],
      },
      {
        key: 'description',
        label: 'شرح آرتیکل / سند',
        required: true,
        hint: 'توضیح ردیف سند',
        example: 'پرداخت اجاره انبار مرداد ماه',
        aliases: ['شرح', 'شرح آرتیکل', 'شرح سند', 'توضیحات', 'description', 'memo'],
      },
      {
        key: 'debit',
        label: 'بدهکار (ریال)',
        hint: 'مبلغ بدهکار به ریال',
        example: '150000000',
        aliases: ['بدهکار', 'مبلغ بدهکار', 'debit', 'dr'],
      },
      {
        key: 'credit',
        label: 'بستانکار (ریال)',
        hint: 'مبلغ بستانکار به ریال',
        example: '0',
        aliases: ['بستانکار', 'مبلغ بستانکار', 'credit', 'cr'],
      },
      {
        key: 'partyName',
        label: 'طرف‌حساب (اختیاری)',
        hint: 'نام یا کد تفصیلی شخص',
        example: '',
        aliases: ['طرف حساب', 'تفصیلی', 'شخص', 'party', 'customer'],
      },
    ],
    sampleRows: [
      {
        'شماره / گروه سند': 'IMP-V1',
        'تاریخ سند (شمسی)': '1405/05/10',
        'کد معین': '80201',
        'شرح آرتیکل / سند': 'پرداخت هزینه اجاره انبار نخ مرداد ماه',
        'بدهکار (ریال)': 180000000,
        'بستانکار (ریال)': 0,
        'طرف‌حساب (اختیاری)': '',
      },
      {
        'شماره / گروه سند': 'IMP-V1',
        'تاریخ سند (شمسی)': '1405/05/10',
        'کد معین': '10201',
        'شرح آرتیکل / سند': 'برداشت از بانک ملت بابت اجاره انبار',
        'بدهکار (ریال)': 0,
        'بستانکار (ریال)': 180000000,
        'طرف‌حساب (اختیاری)': '',
      },
    ],
  },

  invoices: {
    id: 'invoices',
    title: 'فاکتورهای فروش، خرید و پیش‌فاکتور',
    subtitle: 'ورود یکپارچه اقلام فاکتور با تولید خودکار سند حسابداری و کاردکس انبار',
    fields: [
      {
        key: 'invoiceNumber',
        label: 'شماره فاکتور',
        required: true,
        hint: 'ردیف‌های هم‌شماره در یک فاکتور تجمیع می‌شوند',
        example: 'XL-1405-01',
        aliases: ['شماره فاکتور', 'فاکتور', 'شماره', 'invoice number', 'invoice', 'no'],
      },
      {
        key: 'invoiceType',
        label: 'نوع فاکتور',
        hint: 'فروش، خرید یا پیش‌فاکتور',
        example: 'فروش',
        aliases: ['نوع فاکتور', 'نوع', 'type', 'invoice type'],
      },
      {
        key: 'sourceInvoiceNumber',
        label: 'شماره فاکتور مرجع برگشت',
        hint: 'برای برگشت از فروش یا خرید، شماره فاکتور اصلی را وارد کنید',
        example: 'F-1405-101',
        aliases: ['شماره فاکتور مرجع', 'فاکتور مرجع', 'شماره فاکتور اصلی', 'source invoice number', 'source invoice'],
      },
      {
        key: 'date',
        label: 'تاریخ فاکتور',
        hint: 'فرمت شمسی ۱۴۰۵/۰۵/۱۴',
        example: '1405/05/14',
        aliases: ['تاریخ', 'تاریخ فاکتور', 'date'],
      },
      {
        key: 'partyName',
        label: 'نام طرف‌حساب',
        required: true,
        hint: 'نام خریدار یا فروشنده',
        example: 'کارخانه بافندگی سپهر یزد',
        aliases: ['طرف حساب', 'خریدار', 'مشتری', 'فروشنده', 'party', 'customer'],
      },
      {
        key: 'productName',
        label: 'نام یا کد کالا',
        required: true,
        hint: 'نام یا SKU کالا',
        example: 'نخ پلی‌استر DTY 150/48',
        aliases: ['کالا', 'نام کالا', 'کد کالا', 'شرح کالا', 'product', 'sku', 'item'],
      },
      {
        key: 'quantity',
        label: 'وزن / مقدار',
        required: true,
        hint: 'مقدار به کیلوگرم یا واحد اصلی',
        example: '250',
        aliases: ['مقدار', 'وزن', 'تعداد', 'quantity', 'qty', 'weight'],
      },
      {
        key: 'unitPrice',
        label: 'فی واحد (ریال)',
        required: true,
        hint: 'قیمت هر واحد به ریال',
        example: '1900000',
        aliases: ['فی', 'فی واحد', 'قیمت واحد', 'نرخ', 'unit price', 'price'],
      },
      {
        key: 'discount',
        label: 'تخفیف ردیف (ریال)',
        hint: 'مبلغ تخفیف ریالی',
        example: '0',
        aliases: ['تخفیف', 'discount'],
      },
      {
        key: 'vatRate',
        label: 'درصد مالیات',
        hint: 'مثلاً ۱۰ برای ۱۰ درصد یا ۰ برای معاف',
        example: '10',
        aliases: ['مالیات', 'درصد مالیات', 'ارزش افزوده', 'vat', 'tax'],
      },
    ],
    sampleRows: [
      {
        'شماره فاکتور': 'XL-1405-101',
        'نوع فاکتور': 'فروش',
        'تاریخ فاکتور': '1405/05/14',
        'نام طرف‌حساب': 'کارخانه بافندگی سپهر یزد',
        'نام یا کد کالا': 'نخ پلی‌استر DTY 150/48',
        'وزن / مقدار': 200,
        'فی واحد (ریال)': 1900000,
        'تخفیف ردیف (ریال)': 0,
        'درصد مالیات': 10,
      },
    ],
  },

  cheques: {
    id: 'cheques',
    title: 'چک‌های صیادی (دریافتنی و پرداختنی)',
    subtitle: 'ثبت دسته‌ای چک‌های در جریان با شناسه ۱۶ رقمی صیادی و سررسید',
    fields: [
      {
        key: 'sayadiId',
        label: 'شناسه صیادی',
        required: true,
        hint: 'شناسه ۱۶ رقمی صیاد',
        example: '1405123456789012',
        aliases: ['صیادی', 'شناسه صیادی', 'کد صیادی', 'sayadi', 'sayadi id'],
      },
      {
        key: 'serial',
        label: 'سریال چک',
        hint: 'شماره سریال برگه چک',
        example: '884512',
        aliases: ['سریال', 'شماره چک', 'شماره سریال', 'serial', 'cheque no'],
      },
      {
        key: 'direction',
        label: 'نوع چک',
        hint: 'دریافتنی یا پرداختنی',
        example: 'دریافتنی',
        aliases: ['نوع', 'نوع چک', 'جهت', 'direction', 'type'],
      },
      {
        key: 'partyName',
        label: 'طرف‌حساب',
        required: true,
        hint: 'صادرکننده یا ذینفع چک',
        example: 'نساجی پارس‌بافت',
        aliases: ['طرف حساب', 'شخص', 'مشتری', 'ذینفع', 'صادرکننده', 'party'],
      },
      {
        key: 'bankName',
        label: 'نام بانک',
        required: true,
        hint: 'بانک عهده چک',
        example: 'بانک ملت',
        aliases: ['بانک', 'نام بانک', 'bank', 'bank name'],
      },
      {
        key: 'amount',
        label: 'مبلغ چک (ریال)',
        required: true,
        hint: 'مبلغ اسمی چک به ریال',
        example: '1200000000',
        aliases: ['مبلغ', 'مبلغ چک', 'amount'],
      },
      {
        key: 'dueDate',
        label: 'تاریخ سررسید',
        required: true,
        hint: 'تاریخ شمسی سررسید چک',
        example: '1405/07/20',
        aliases: ['سررسید', 'تاریخ سررسید', 'due date', 'duedate'],
      },
      {
        key: 'issueDate',
        label: 'تاریخ صدور',
        hint: 'تاریخ شمسی صدور چک',
        example: '1405/05/14',
        aliases: ['تاریخ صدور', 'صدور', 'issue date', 'date'],
      },
      {
        key: 'notes',
        label: 'توضیحات',
        hint: 'شرح یا بابت چک',
        example: 'بابت تسویه فاکتور شماره ۱۰۲',
        aliases: ['توضیحات', 'شرح', 'بابت', 'notes', 'description'],
      },
    ],
    sampleRows: [
      {
        'شناسه صیادی': '1405112233445566',
        'سریال چک': '774120',
        'نوع چک': 'دریافتنی',
        'طرف‌حساب': 'کارخانه بافندگی سپهر یزد',
        'نام بانک': 'بانک ملت',
        'مبلغ چک (ریال)': 1500000000,
        'تاریخ سررسید': '1405/07/25',
        'تاریخ صدور': '1405/05/14',
        'توضیحات': 'بابت فروش نخ پلی‌استر',
      },
    ],
  },

  employees: {
    id: 'employees',
    title: 'پرسنل و حقوق و دستمزد',
    subtitle: 'ورود لیست پرسنل، حقوق پایه، حق مسکن، بن کارگری و تعداد اولاد',
    fields: [
      {
        key: 'fullName',
        label: 'نام و نام خانوادگی',
        required: true,
        hint: 'نام کامل پرسنل',
        example: 'علیرضا محمدی',
        aliases: ['نام', 'نام و نام خانوادگی', 'پرسنل', 'کارمند', 'full name', 'name', 'employee'],
      },
      {
        key: 'personnelCode',
        label: 'کد پرسنلی',
        hint: 'کد یکتای کارمندی',
        example: 'EMP-105',
        aliases: ['کد پرسنلی', 'کد', 'شماره پرسنلی', 'code', 'personnel code'],
      },
      {
        key: 'department',
        label: 'واحد / دپارتمان',
        hint: 'بخش محل خدمت',
        example: 'انبار و توزین',
        aliases: ['واحد', 'دپارتمان', 'بخش', 'سمت', 'department'],
      },
      {
        key: 'baseSalary',
        label: 'حقوق پایه ماهانه (ریال)',
        required: true,
        hint: 'حقوق پایه ریالی ماهانه',
        example: '110000000',
        aliases: ['حقوق پایه', 'حقوق', 'دستمزد', 'base salary', 'salary'],
      },
      {
        key: 'housingAllowance',
        label: 'حق مسکن (ریال)',
        hint: 'کمک‌هزینه مسکن ماهانه',
        example: '9000000',
        aliases: ['حق مسکن', 'مسکن', 'housing'],
      },
      {
        key: 'foodAllowance',
        label: 'بن کارگری / خواربار (ریال)',
        hint: 'بن نقدی ماهانه',
        example: '14000000',
        aliases: ['بن', 'بن کارگری', 'خواربار', 'food'],
      },
      {
        key: 'childrenCount',
        label: 'تعداد فرزندان',
        hint: 'تعداد اولاد مشمول حق اولاد',
        example: '1',
        aliases: ['فرزند', 'تعداد فرزندان', 'اولاد', 'children'],
      },
      {
        key: 'overtimeHours',
        label: 'ساعت اضافه‌کاری',
        hint: 'مجموع ساعات اضافه‌کاری ماه',
        example: '12',
        aliases: ['اضافه کاری', 'ساعت اضافه کاری', 'overtime'],
      },
    ],
    sampleRows: [
      {
        'نام و نام خانوادگی': 'مهدی رضایی‌نژاد',
        'کد پرسنلی': 'EMP-201',
        'واحد / دپارتمان': 'فروش و بازرگانی',
        'حقوق پایه ماهانه (ریال)': 125000000,
        'حق مسکن (ریال)': 9000000,
        'بن کارگری / خواربار (ریال)': 14000000,
        'تعداد فرزندان': 2,
        'ساعت اضافه‌کاری': 10,
      },
    ],
  },

  costCenters: {
    id: 'costCenters',
    title: 'مراکز هزینه و پروژه‌ها',
    subtitle: 'تعریف کد مرکز هزینه، مدیر پروژه و بودجه مصوب',
    fields: [
      {
        key: 'code',
        label: 'کد مرکز هزینه',
        required: true,
        hint: 'کد یکتای مرکز هزینه',
        example: 'CC-201',
        aliases: ['کد', 'کد مرکز هزینه', 'code'],
      },
      {
        key: 'name',
        label: 'عنوان مرکز هزینه / پروژه',
        required: true,
        hint: 'نام واحد یا پروژه',
        example: 'خط تولید رنگرزی بوبین',
        aliases: ['نام', 'عنوان', 'مرکز هزینه', 'پروژه', 'name', 'title'],
      },
      {
        key: 'budget',
        label: 'بودجه مصوب (ریال)',
        hint: 'سقف بودجه ریالی دوره',
        example: '2500000000',
        aliases: ['بودجه', 'بودجه مصوب', 'budget'],
      },
      {
        key: 'manager',
        label: 'مسئول / مدیر',
        hint: 'نام مسئول مرکز هزینه',
        example: 'مهندس کریمی',
        aliases: ['مدیر', 'مسئول', 'manager'],
      },
    ],
    sampleRows: [
      {
        'کد مرکز هزینه': 'CC-301',
        'عنوان مرکز هزینه / پروژه': 'واحد واردات و ترخیص بندرعباس',
        'بودجه مصوب (ریال)': 3500000000,
        'مسئول / مدیر': 'حسین شریفی',
      },
    ],
  },
};

export function mapModuleToImportEntity(mod: ActiveModule): UniversalImportEntity {
  switch (mod) {
    case 'parties':
      return 'parties';
    case 'inventory':
    case 'warehouse-crm':
      return 'products';
    case 'accounts':
      return 'accounts';
    case 'vouchers':
    case 'audit':
    case 'finance-ops':
      return 'vouchers';
    case 'invoices':
    case 'commercial':
      return 'invoices';
    case 'treasury':
    case 'currencies':
      return 'cheques';
    case 'corporate':
      return 'employees';
    default:
      return 'parties';
  }
}

/**
 * Parses an Excel (.xlsx / .xls) or CSV binary buffer into headers and raw row records.
 */
export function parseExcelArrayBuffer(
  buffer: ArrayBuffer | Uint8Array,
  preferredSheetName?: string
): ParsedExcelSheet {
  const workbook = XLSX.read(buffer, { type: 'array', raw: false });
  const sheetNames = workbook.SheetNames || [];
  if (sheetNames.length === 0) {
    return { sheetName: '', sheetNames: [], headers: [], rows: [] };
  }
  const targetSheet =
    preferredSheetName && sheetNames.includes(preferredSheetName)
      ? preferredSheetName
      : sheetNames[0];
  const worksheet = workbook.Sheets[targetSheet];
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(worksheet, {
    header: 1,
    defval: '',
    blankrows: false,
  });

  if (matrix.length === 0) {
    return { sheetName: targetSheet, sheetNames, headers: [], rows: [] };
  }

  // Find the first non-empty row as header row
  const headerRowIdx = matrix.findIndex(
    (row: unknown[]) => Array.isArray(row) && row.some((cell) => cleanStr(cell).length > 0)
  );
  if (headerRowIdx < 0) {
    return { sheetName: targetSheet, sheetNames, headers: [], rows: [] };
  }

  const rawHeaders = (matrix[headerRowIdx] as unknown[]).map((h, idx) => {
    const cleaned = cleanStr(h);
    return cleaned || `ستون ${idx + 1}`;
  });

  // Deduplicate identical headers safely
  const headerCounts = new Map<string, number>();
  const headers = rawHeaders.map((h) => {
    const count = headerCounts.get(h) ?? 0;
    headerCounts.set(h, count + 1);
    return count === 0 ? h : `${h} (${count + 1})`;
  });

  const rows: Record<string, unknown>[] = [];
  for (let i = headerRowIdx + 1; i < matrix.length; i++) {
    const rawRow = matrix[i] as unknown[];
    if (!Array.isArray(rawRow)) continue;
    const obj: Record<string, unknown> = {};
    let hasValue = false;
    headers.forEach((header, colIdx) => {
      const val = rawRow[colIdx] ?? '';
      if (cleanStr(val).length > 0) hasValue = true;
      obj[header] = val;
    });
    if (hasValue) rows.push(obj);
  }

  return {
    sheetName: targetSheet,
    sheetNames,
    headers,
    rows,
  };
}

/**
 * Automatically maps Excel headers to target entity fields using Persian & English synonyms.
 */
export function autoMapExcelColumns(
  headers: string[],
  entity: UniversalImportEntity
): Record<string, string> {
  const schema = UNIVERSAL_IMPORT_SCHEMAS[entity];
  const normalizedHeaders = headers.map((h) => ({
    original: h,
    norm: normalizeHeaderToken(h),
  }));

  const mapping: Record<string, string> = {};
  const usedHeaders = new Set<string>();

  for (const field of schema.fields) {
    const targets = [field.label, field.key, ...field.aliases].map(normalizeHeaderToken);

    let bestHeader = '';
    let bestScore = 0;

    for (const h of normalizedHeaders) {
      if (usedHeaders.has(h.original) || !h.norm) continue;
      for (const target of targets) {
        if (!target) continue;
        let score = 0;
        if (h.norm === target) {
          score = 100;
        } else if (h.norm.includes(target) && target.length >= 2) {
          score = 75 + Math.min(20, target.length);
        } else if (target.includes(h.norm) && h.norm.length >= 3) {
          score = 60 + Math.min(15, h.norm.length);
        }
        if (score > bestScore) {
          bestScore = score;
          bestHeader = h.original;
        }
      }
    }

    if (bestHeader && bestScore >= 60) {
      mapping[field.key] = bestHeader;
      usedHeaders.add(bestHeader);
    }
  }

  return mapping;
}

function parsePartyTypeCell(raw: unknown): PartyType {
  const n = normalizeHeaderToken(String(raw ?? ''));
  if (n.includes('واسطه') || n.includes('بازاریاب') || n.includes('intermediary')) return 'intermediary';
  if (n.includes('هر دو') || n.includes('هردو') || n.includes('both')) return 'both';
  if (n.includes('تامین') || n.includes('فروشنده') || n.includes('vendor') || n.includes('supplier')) return 'vendor';
  return 'customer';
}

function parseAccountCategoryCell(raw: unknown, code: string): AccountCategory {
  const n = normalizeHeaderToken(String(raw ?? ''));
  if (n.includes('دارایی') || n.includes('asset')) return 'asset';
  if (n.includes('بدهی') || n.includes('liability')) return 'liability';
  if (n.includes('سرمایه') || n.includes('حقوق') || n.includes('equity')) return 'equity';
  if (n.includes('درآمد') || n.includes('فروش') || n.includes('revenue')) return 'revenue';
  if (n.includes('بهای تمام') || n.includes('cogs')) return 'cogs';
  if (n.includes('هزینه') || n.includes('expense')) return 'expense';
  if (n.includes('انتظامی') || n.includes('memo')) return 'memo';
  if (code.startsWith('1') || code.startsWith('2')) return 'asset';
  if (code.startsWith('3') || code.startsWith('4')) return 'liability';
  if (code.startsWith('5')) return 'equity';
  if (code.startsWith('6')) return 'revenue';
  if (code.startsWith('7')) return 'cogs';
  return 'expense';
}

function parseAccountLevelCell(raw: unknown, code: string): AccountLevel {
  const n = normalizeHeaderToken(String(raw ?? ''));
  if (n.includes('گروه') || n.includes('group')) return 'group';
  if (n.includes('کل') || n.includes('kol')) return 'kol';
  if (n.includes('تفصیلی') || n.includes('tafsili')) return 'tafsili';
  if (code.length <= 1) return 'group';
  if (code.length <= 3) return 'kol';
  return 'moein';
}

function parseAccountNatureCell(raw: unknown, cat: AccountCategory): AccountNature {
  const n = normalizeHeaderToken(String(raw ?? ''));
  if (n.includes('هردو') || n.includes('هر دو') || n.includes('both')) return 'both';
  if (n.includes('بستانکار') || n.includes('credit')) return 'credit';
  if (n.includes('بدهکار') || n.includes('debit')) return 'debit';
  return cat === 'asset' || cat === 'cogs' || cat === 'expense' ? 'debit' : 'credit';
}

function parseInvoiceTypeCell(raw: unknown): InvoiceType {
  const n = normalizeHeaderToken(String(raw ?? ''));
  if (n.includes('پیش') || n.includes('proforma')) return 'proforma';
  if (n.includes('برگشت') && n.includes('خرید')) return 'purchase_return';
  if (n.includes('برگشت') || n.includes('مرجوع')) return 'sale_return';
  if (n.includes('ضایعات') || n.includes('waste')) return 'waste';
  if (n.includes('خرید') || n.includes('purchase') || n.includes('واردات')) return 'purchase';
  return 'sale';
}

function parseChequeDirectionCell(raw: unknown): ChequeDirection {
  const n = normalizeHeaderToken(String(raw ?? ''));
  if (n.includes('پرداخت') || n.includes('payable')) return 'payable';
  return 'receivable';
}

/**
 * Validates and transforms raw Excel rows into clean typed payloads for the chosen entity.
 */
export function validateAndTransformImportRows(
  entity: UniversalImportEntity,
  rawRows: Record<string, unknown>[],
  columnMap: Record<string, string>,
  fallbackDate?: string
): TransformedImportResult {
  const today = fallbackDate || getTodayShamsi();
  const validRows: Record<string, unknown>[] = [];
  const errors: ImportRowError[] = [];

  const getCell = (row: Record<string, unknown>, fieldKey: string): unknown => {
    const header = columnMap[fieldKey];
    if (!header) return '';
    return row[header];
  };

  if (entity === 'parties') {
    rawRows.forEach((row, idx) => {
      const name = cleanStr(getCell(row, 'name'));
      if (!name) {
        errors.push({ rowIndex: idx + 1, message: 'ستون «نام طرف‌حساب» خالی است.' });
        return;
      }
      const partyType = parsePartyTypeCell(getCell(row, 'partyType'));
      const code = cleanStr(getCell(row, 'code')) || `XL-P-${idx + 1}`;
      validRows.push({
        code,
        name,
        partyType,
        phone: cleanStr(getCell(row, 'phone')) || undefined,
        nationalId: cleanStr(getCell(row, 'nationalId')) || undefined,
        economicCode: cleanStr(getCell(row, 'economicCode')) || undefined,
        creditLimit: Math.max(0, Math.round(parsePersianExcelNumber(getCell(row, 'creditLimit')))),
        openingBalance: Math.round(parsePersianExcelNumber(getCell(row, 'openingBalance'))),
        address: cleanStr(getCell(row, 'address')) || undefined,
        accountCode: partyType === 'vendor' ? '30101' : '10401',
      });
    });
  } else if (entity === 'products') {
    rawRows.forEach((row, idx) => {
      const name = cleanStr(getCell(row, 'name'));
      if (!name) {
        errors.push({ rowIndex: idx + 1, message: 'ستون «نام کالا» خالی است.' });
        return;
      }
      const sku = cleanStr(getCell(row, 'sku')) || `XL-SKU-${idx + 1}`;
      const buyPrice = Math.max(0, Math.round(parsePersianExcelNumber(getCell(row, 'buyPrice'))));
      const sellPrice = Math.max(
        0,
        Math.round(parsePersianExcelNumber(getCell(row, 'sellPrice')) || buyPrice)
      );
      const stock = Math.max(0, parsePersianExcelNumber(getCell(row, 'stock')));
      const reorderPoint = Math.max(0, parsePersianExcelNumber(getCell(row, 'reorderPoint')));
      const kgPerCarton = Math.max(0, parsePersianExcelNumber(getCell(row, 'kgPerCarton')));
      validRows.push({
        sku,
        name,
        category: cleanStr(getCell(row, 'category')) || 'عمومی',
        warehouse: cleanStr(getCell(row, 'warehouse')) || 'انبار مرکزی',
        unit: cleanStr(getCell(row, 'unit')) || 'کیلوگرم',
        secondaryUnit: kgPerCarton > 0 ? 'کارتن' : undefined,
        kgPerCarton: kgPerCarton > 0 ? kgPerCarton : undefined,
        lotNumber: cleanStr(getCell(row, 'lotNumber')) || undefined,
        buyPrice,
        sellPrice,
        stock,
        reorderPoint,
        vatExempt: false,
      });
    });
  } else if (entity === 'accounts') {
    rawRows.forEach((row, idx) => {
      const code = cleanStr(getCell(row, 'code'))
        .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 1776))
        .replace(/\s+/g, '');
      const title = cleanStr(getCell(row, 'title'));
      if (!code || !title) {
        errors.push({ rowIndex: idx + 1, message: 'کد حساب و عنوان حساب هر دو الزامی هستند.' });
        return;
      }
      const category = parseAccountCategoryCell(getCell(row, 'category'), code);
      const level = parseAccountLevelCell(getCell(row, 'level'), code);
      const nature = parseAccountNatureCell(getCell(row, 'nature'), category);
      const parentCode = cleanStr(getCell(row, 'parentCode')) || (code.length > 3 ? code.slice(0, 3) : undefined);
      validRows.push({
        code,
        title,
        level,
        parentCode,
        category,
        nature,
        isSystem: false,
        active: true,
      });
    });
  } else if (entity === 'vouchers') {
    // Group rows by groupKey and enforce double-entry balance
    const grouped = new Map<
      string,
      {
        groupKey: string;
        date: string;
        description: string;
        voucherType: VoucherType;
        lines: {
          accountCode: string;
          description: string;
          debit: number;
          credit: number;
          partyName?: string;
        }[];
        firstRow: number;
      }
    >();

    rawRows.forEach((row, idx) => {
      const groupKey = cleanStr(getCell(row, 'groupKey')) || `ROW-${idx + 1}`;
      const accountCode = cleanStr(getCell(row, 'accountCode')).replace(
        /[۰-۹]/g,
        (d) => String(d.charCodeAt(0) - 1776)
      );
      const description = cleanStr(getCell(row, 'description')) || `سند اکسل ${groupKey}`;
      const debit = Math.max(0, Math.round(parsePersianExcelNumber(getCell(row, 'debit'))));
      const credit = Math.max(0, Math.round(parsePersianExcelNumber(getCell(row, 'credit'))));
      const partyName = cleanStr(getCell(row, 'partyName')) || undefined;

      if (!accountCode) {
        errors.push({ rowIndex: idx + 1, message: `در سند ${groupKey} کد معین خالی است.` });
        return;
      }
      if (debit === 0 && credit === 0) {
        errors.push({ rowIndex: idx + 1, message: `در سند ${groupKey} هر دو ستون بدهکار و بستانکار صفر هستند.` });
        return;
      }

      const existing = grouped.get(groupKey);
      const line = { accountCode, description, debit, credit, partyName };
      if (existing) {
        existing.lines.push(line);
      } else {
        grouped.set(groupKey, {
          groupKey,
          date: normalizeShamsiDateCell(getCell(row, 'date'), today),
          description,
          voucherType: 'general',
          lines: [line],
          firstRow: idx + 1,
        });
      }
    });

    grouped.forEach((doc) => {
      const totalDebit = doc.lines.reduce((s, l) => s + l.debit, 0);
      const totalCredit = doc.lines.reduce((s, l) => s + l.credit, 0);
      if (doc.lines.length < 2 || Math.abs(totalDebit - totalCredit) > 1) {
        errors.push({
          rowIndex: doc.firstRow,
          message: `سند «${doc.groupKey}» تراز نیست (جمع بدهکار: ${totalDebit.toLocaleString()} / جمع بستانکار: ${totalCredit.toLocaleString()}).`,
        });
        return;
      }
      validRows.push(doc);
    });
  } else if (entity === 'invoices') {
    const grouped = new Map<
      string,
      {
        invoiceNumber: string;
        invoiceType: InvoiceType;
        date: string;
        partyName: string;
        items: {
          productName: string;
          quantity: number;
          unitPrice: number;
          discount: number;
          vatRate: number;
        }[];
        firstRow: number;
      }
    >();

    rawRows.forEach((row, idx) => {
      const invoiceNumber = cleanStr(getCell(row, 'invoiceNumber')) || `XL-INV-${idx + 1}`;
      const partyName = cleanStr(getCell(row, 'partyName'));
      const productName = cleanStr(getCell(row, 'productName'));
      const quantity = parsePersianExcelNumber(getCell(row, 'quantity'));
      const unitPrice = Math.round(parsePersianExcelNumber(getCell(row, 'unitPrice')));
      const discount = Math.max(0, Math.round(parsePersianExcelNumber(getCell(row, 'discount'))));
      const rawVat = getCell(row, 'vatRate');
      const vatRate = cleanStr(rawVat) === '' ? 10 : Math.max(0, parsePersianExcelNumber(rawVat));

      if (!partyName || !productName) {
        errors.push({
          rowIndex: idx + 1,
          message: `در فاکتور ${invoiceNumber} نام طرف‌حساب و کالا الزامی است.`,
        });
        return;
      }
      if (quantity <= 0 || unitPrice <= 0) {
        errors.push({
          rowIndex: idx + 1,
          message: `در فاکتور ${invoiceNumber} مقدار و فی واحد باید بزرگ‌تر از صفر باشند.`,
        });
        return;
      }

      const existing = grouped.get(invoiceNumber);
      const item = { productName, quantity, unitPrice, discount, vatRate };
      if (existing) {
        existing.items.push(item);
      } else {
        grouped.set(invoiceNumber, {
          invoiceNumber,
          invoiceType: parseInvoiceTypeCell(getCell(row, 'invoiceType')),
          date: normalizeShamsiDateCell(getCell(row, 'date'), today),
          partyName,
          items: [item],
          firstRow: idx + 1,
        });
      }
    });

    grouped.forEach((inv) => validRows.push(inv));
  } else if (entity === 'cheques') {
    rawRows.forEach((row, idx) => {
      const sayadiId = cleanStr(getCell(row, 'sayadiId')).replace(
        /[۰-۹]/g,
        (d) => String(d.charCodeAt(0) - 1776)
      );
      const partyName = cleanStr(getCell(row, 'partyName'));
      const bankName = cleanStr(getCell(row, 'bankName')) || 'بانک ملت';
      const amount = Math.round(parsePersianExcelNumber(getCell(row, 'amount')));
      const dueDate = normalizeShamsiDateCell(getCell(row, 'dueDate'), '');

      if (!sayadiId || !partyName || amount <= 0 || !dueDate) {
        errors.push({
          rowIndex: idx + 1,
          message: 'شناسه صیادی، طرف‌حساب، مبلغ معتبر و تاریخ سررسید شمسی الزامی هستند.',
        });
        return;
      }
      const status: ChequeStatus = 'in_box';
      validRows.push({
        sayadiId,
        serial: cleanStr(getCell(row, 'serial')) || sayadiId.slice(-6),
        direction: parseChequeDirectionCell(getCell(row, 'direction')),
        partyName,
        bankName,
        amount,
        issueDate: normalizeShamsiDateCell(getCell(row, 'issueDate'), today),
        dueDate,
        status,
        notes: cleanStr(getCell(row, 'notes')) || undefined,
      });
    });
  } else if (entity === 'employees') {
    rawRows.forEach((row, idx) => {
      const fullName = cleanStr(getCell(row, 'fullName'));
      const baseSalary = Math.round(parsePersianExcelNumber(getCell(row, 'baseSalary')));
      if (!fullName || baseSalary <= 0) {
        errors.push({
          rowIndex: idx + 1,
          message: 'نام پرسنل و حقوق پایه معتبر الزامی است.',
        });
        return;
      }
      validRows.push({
        personnelCode: cleanStr(getCell(row, 'personnelCode')) || `XL-EMP-${idx + 1}`,
        fullName,
        department: cleanStr(getCell(row, 'department')) || 'عمومی',
        baseSalary,
        housingAllowance: Math.max(0, Math.round(parsePersianExcelNumber(getCell(row, 'housingAllowance')))),
        foodAllowance: Math.max(0, Math.round(parsePersianExcelNumber(getCell(row, 'foodAllowance')))),
        childrenCount: Math.max(0, Math.round(parsePersianExcelNumber(getCell(row, 'childrenCount')))),
        overtimeHours: Math.max(0, parsePersianExcelNumber(getCell(row, 'overtimeHours'))),
        active: true,
      });
    });
  } else if (entity === 'costCenters') {
    rawRows.forEach((row, idx) => {
      const code = cleanStr(getCell(row, 'code')) || `CC-XL-${idx + 1}`;
      const name = cleanStr(getCell(row, 'name'));
      if (!name) {
        errors.push({ rowIndex: idx + 1, message: 'عنوان مرکز هزینه خالی است.' });
        return;
      }
      validRows.push({
        code,
        name,
        budget: Math.max(0, Math.round(parsePersianExcelNumber(getCell(row, 'budget')))),
        manager: cleanStr(getCell(row, 'manager')) || undefined,
        active: true,
      });
    });
  }

  return {
    entity,
    totalRows: rawRows.length,
    validRows,
    errors,
  };
}

export function buildEntityTemplateWorkbook(entity: UniversalImportEntity): XLSX.WorkBook {
  const schema = UNIVERSAL_IMPORT_SCHEMAS[entity];
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(schema.sampleRows);
  XLSX.utils.book_append_sheet(wb, ws, schema.title.slice(0, 30));
  return wb;
}

export function downloadEntityExcelTemplate(entity: UniversalImportEntity): void {
  const wb = buildEntityTemplateWorkbook(entity);
  XLSX.writeFile(wb, `holoo-billion-template-${entity}.xlsx`);
}
