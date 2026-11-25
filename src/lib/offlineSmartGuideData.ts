import type { ActiveModule } from '../types/accounting';

export interface GuideSubLink {
  label: string;
  module: ActiveModule;
  intent?: string;
  subKey?: string;
}

export interface ModuleGuideItem {
  id: string;
  title: string;
  modules: ActiveModule[];
  shortcut?: string;
  summary: string;
  primaryTarget: {
    module: ActiveModule;
    intent?: string;
    subKey?: string;
  };
  steps: string[];
  tips: string[];
  quickLinks: GuideSubLink[];
  keywords: string;
}

export type SyncGuideActionId =
  | 'open_local_mesh_settings'
  | 'open_queue_monitor'
  | 'open_audit_p2p_log'
  | 'open_dual_cloud_settings'
  | 'open_mesh_wizard';

export interface SyncMethodGuide {
  id: string;
  title: string;
  subtitle: string;
  offlineCapable: '100% آفلاین' | 'آفلاین + همگام‌سازی خودکار هنگام آنلاین شدن' | 'نیازمند اینترنت';
  bestFor: string;
  howItWorks: string[];
  conflictPolicy: string;
  actionLabel: string;
  actionId: SyncGuideActionId;
  keywords: string;
}

export interface OfflineScenarioItem {
  id: string;
  question: string;
  badge: string;
  answer: string;
  steps: string[];
  actionLabel?: string;
  actionId?: SyncGuideActionId;
  keywords: string;
}

export const MODULE_GUIDES: ModuleGuideItem[] = [
  {
    id: 'dashboard',
    title: 'داشبورد مدیریت مالی',
    modules: ['dashboard'],
    shortcut: 'F10',
    summary: 'نمای یکپارچه سود و زیان، نقدینگی صندوق و بانک، هشدار چک‌های سررسید نزدیک و دسترسی سریع به عملیات روزانه.',
    primaryTarget: { module: 'dashboard', subKey: 'dashboard' },
    steps: [
      'در کارت‌های بالای صفحه، وضعیت فروش، موجودی نقد/بانک، مطالبات مشتریان و وضعیت تراز حسابرسی را بررسی کنید.',
      'چک‌های نزدیک به سررسید یا معوقه در پنل هشدار و زنگوله بالای صفحه با تفکیک دریافتی و پرداختی نمایش داده می‌شوند.',
      'از دکمه‌های اقدام سریع برای صدور فوری فاکتور فروش (F2)، سند حسابداری (F3) یا باز کردن دستیار هوشمند آفلاین استفاده کنید.',
    ],
    tips: [
      'با کلیک روی دکمه تومان/ریال در نوار بالا، تمام مبالغ داشبورد و گزارش‌ها به‌صورت لحظه‌ای تبدیل می‌شوند.',
      'می‌توانید کلید Ctrl+K را بزنید تا پنجره فرمان سریع باز شود و بدون موس به هر منویی بروید.',
    ],
    quickLinks: [
      { label: 'باز کردن داشبورد', module: 'dashboard', subKey: 'dashboard' },
      { label: 'سلامت و حسابرسی دفاتر', module: 'audit', subKey: 'audit-center' },
    ],
    keywords: 'داشبورد صفحه اصلی نمای کلی سود زیان نقدینگی هشدار چک فوری',
  },
  {
    id: 'base',
    title: 'اطلاعات اول دوره و پایه',
    modules: ['accounts', 'parties'],
    shortcut: 'F5',
    summary: 'تعریف کدینگ حساب‌ها (کل و معین)، صندوق و بانک‌ها، مشتریان و تأمین‌کنندگان، کالاها و ثبت سند افتتاحیه.',
    primaryTarget: { module: 'accounts', subKey: 'accounts-all' },
    steps: [
      'ابتدا در بخش «کدینگ حساب‌ها» حساب‌های کل و معین، صندوق‌ها و حساب‌های بانکی شرکت را بررسی یا اضافه کنید.',
      'در بخش «طرف‌حساب‌ها و اشخاص (F5)»، مشتریان، فروشندگان و واسطه‌ها را با سقف اعتبار و کد اقتصادی ثبت کنید.',
      'برای شروع سال مالی جدید، از گزینه «ثبت سند افتتاحیه اول دوره» مانده‌های ابتدای دوره را وارد نمایید.',
    ],
    tips: [
      'برای هر طرف‌حساب می‌توانید سقف اعتبار تعریف کنید تا هنگام صدور فاکتور فروش نسیه، سیستم هشدار هوشمند بدهد.',
      'کدهای حسابداری استاندارد هلو شرکتی به‌صورت پیش‌فرض آماده و با مودیان و ترازنامه متصل هستند.',
    ],
    quickLinks: [
      { label: 'کدینگ حساب‌ها', module: 'accounts', subKey: 'accounts-all' },
      { label: 'صندوق و بانک‌ها', module: 'accounts', intent: 'banks-cash', subKey: 'accounts-banks' },
      { label: 'طرف‌حساب‌ها (F5)', module: 'parties', subKey: 'parties' },
      { label: 'سند افتتاحیه', module: 'vouchers', intent: 'new-opening', subKey: 'opening-voucher' },
    ],
    keywords: 'اطلاعات پایه اول دوره کدینگ حساب کل معین تفصیلی بانک صندوق مشتری فروشنده افتتاحیه',
  },
  {
    id: 'accounting',
    title: 'عملیات حسابداری، اسناد و کارتابل',
    modules: ['vouchers', 'finance-ops'],
    shortcut: 'F3',
    summary: 'صدور سند دوطرفه، کارتابل اسناد موقت و قطعی، اسناد تکرارشونده دوره‌ای و انتقال سال مالی.',
    primaryTarget: { module: 'vouchers', intent: 'new-voucher', subKey: 'voucher-new' },
    steps: [
      'با کلید F3 یا منوی «صدور سند حسابداری جدید»، ردیف‌های بدهکار و بستانکار را انتخاب و شرح سند را ثبت کنید.',
      'سیستم به‌صورت خودکار تراز بودن سند (جمع بدهکار = جمع بستانکار) و الزامی بودن تفصیلی را بررسی می‌کند.',
      'اسناد «موقت» تا زمان قطعی‌سازی در کارتابل نگهداری می‌شوند؛ با قطعی کردن سند، مهر یکپارچگی ثبت و در دفاتر رسمی اعمال می‌شود.',
      'برای هزینه‌های ماهانه مانند اجاره یا بیمه، از «اسناد تکرارشونده دوره‌ای» استفاده کنید.',
    ],
    tips: [
      'اسناد ایجادشده توسط فاکتورها و چک‌ها به‌صورت خودکار لینک ردیابی (Lineage) دارند.',
      'می‌توانید در بخش «مرکز حسابرسی» تمام اسناد را بر اساس تاریخ مرتب و شماره‌گذاری مجدد کنید.',
    ],
    quickLinks: [
      { label: 'صدور سند جدید (F3)', module: 'vouchers', intent: 'new-voucher', subKey: 'voucher-new' },
      { label: 'کارتابل اسناد', module: 'vouchers', intent: 'cartable', subKey: 'voucher-cartable' },
      { label: 'اسناد موقت', module: 'vouchers', intent: 'drafts', subKey: 'voucher-drafts' },
      { label: 'اسناد تکرارشونده', module: 'finance-ops', intent: 'recurring', subKey: 'fin-recurring' },
    ],
    keywords: 'سند حسابداری دوطرفه بدهکار بستانکار موقت قطعی کارتابل دفتر روزنامه افتتاحیه تکرارشونده',
  },
  {
    id: 'invoices',
    title: 'خرید، فروش، پیش‌فاکتور و مودیان',
    modules: ['invoices'],
    shortcut: 'F2 / F4',
    summary: 'صدور فاکتور فروش (F2)، خرید (F4)، برگشت از فروش/خرید، پیش‌فاکتور، تسویه ترکیبی (نقد+بانک+چک+نسیه) و قالب چاپ چندواحدی.',
    primaryTarget: { module: 'invoices', intent: 'new-sale', subKey: 'inv-sale' },
    steps: [
      'نوع فاکتور (فروش، خرید، پیش‌فاکتور یا برگشت) را انتخاب کرده و طرف‌حساب را مشخص کنید.',
      'کالاها را با مقدار (کیلوگرم، بوبین یا کارتن)، نرخ واحد، تخفیف و مالیات ارزش افزوده ۱۰٪ اضافه نمایید.',
      'در بخش تسویه، می‌توانید مبلغ را به صورت ترکیبی میان صندوق، کارتخوان/بانک، چک صیادی و مانده نسیه تقسیم کنید.',
      'با ثبت نهایی، به‌صورت اتمی و همزمان موجودی انبار کسر/اضافه، بهای تمام‌شده (FIFO/میانگین) محاسبه و سند حسابداری صادر می‌شود.',
    ],
    tips: [
      'اگر فروش هنوز قطعی نیست، آن را در «صف فاکتورهای رزرو موقت» نگه دارید تا موجودی رزرو شود.',
      'از منوی «طراحی قالب فاکتور» می‌توانید رنگ، اندازه کاغذ (A4/A5) و واحدهای چاپ را سفارشی کنید.',
    ],
    quickLinks: [
      { label: 'فاکتور فروش (F2)', module: 'invoices', intent: 'new-sale', subKey: 'inv-sale' },
      { label: 'فاکتور خرید (F4)', module: 'invoices', intent: 'new-purchase', subKey: 'inv-purchase' },
      { label: 'صف فاکتورهای رزرو', module: 'invoices', intent: 'reserved', subKey: 'inv-reserved' },
      { label: 'طراحی قالب فاکتور', module: 'settings', intent: 'invoice-designer', subKey: 'inv-designer' },
    ],
    keywords: 'فاکتور فروش خرید پیش فاکتور برگشت ضایعات مودیان ارزش افزوده تسویه ترکیبی رزرو چاپ',
  },
  {
    id: 'commercial',
    title: 'بازرگانی واردات، باسکول و رنگرزی',
    modules: ['commercial'],
    summary: 'مدیریت پرونده‌های واردات نخ و محاسبه بهای تمام‌شده گمرکی، حواله باسکول با بارکد و پیمانکاری کارمزدی رنگرزی/بافندگی.',
    primaryTarget: { module: 'commercial', intent: 'imports', subKey: 'comm-imports' },
    steps: [
      'در «پرونده واردات»، نرخ ارز، کرایه حمل، بیمه و حقوق گمرکی را ثبت کنید تا قیمت تمام‌شده هر کیلو کالا دقیق محاسبه شود.',
      'در «سفارش فروش و باسکول»، وزن خالص و ناخالص محموله را ثبت و لیبل بارکد صادر کنید.',
      'در «پیمانکاری کارمزدی»، ارسال نخ خام به رنگرزی یا بافندگی و تحویل کالای تکمیل‌شده همراه با ضایعات مجاز را پیگیری کنید.',
    ],
    tips: [
      'پیمانکاری رنگرزی به‌صورت خودکار هزینه دستمزد کارمزدی را به بهای تمام‌شده کالای نهایی سرشکن می‌کند.',
    ],
    quickLinks: [
      { label: 'پرونده واردات', module: 'commercial', intent: 'imports', subKey: 'comm-imports' },
      { label: 'سفارش و باسکول', module: 'commercial', intent: 'orders', subKey: 'comm-orders' },
      { label: 'پیمانکاری رنگرزی', module: 'commercial', intent: 'subcontract', subKey: 'comm-subcontract' },
    ],
    keywords: 'واردات گمرک بهای تمام شده باسکول بارکد رنگرزی بافندگی پیمانکاری کارمزدی نخ',
  },
  {
    id: 'warehouse',
    title: 'انبارداری، کاردکس، لات رنگ و BOM',
    modules: ['inventory', 'warehouse-crm'],
    shortcut: 'F6',
    summary: 'کنترل موجودی چندانباره، کاردکس ریالی (FIFO و میانگین موزون)، ردیابی لات/شید رنگ، فرمول تولید (BOM) و انبارگردانی.',
    primaryTarget: { module: 'inventory', subKey: 'inv-products' },
    steps: [
      'کالاها را با واحد اصلی/فرعی، حداقل موجودی و انبار پیش‌فرض در بخش «انبارداری (F6)» تعریف کنید یا از اکسل/CSV گروهی وارد نمایید.',
      'برای مشاهده گردش ریالی و تعدادی هر کالا، تب «کاردکس ریالی» را باز کنید.',
      'هنگام انتقال کالا بین انبارها از «حواله انتقال بین انبارها» استفاده کنید (لایه‌های بهای تمام‌شده بدون اثر سود و زیان منتقل می‌شوند).',
      'در پایان دوره، از «انبارگردانی گروهی» شمارش واقعی را وارد کنید تا سند تعدیل کسری/اضافه خودکار صادر شود.',
    ],
    tips: [
      'سیستم از منفی شدن موجودی انبار جلوگیری می‌کند تا بهای تمام‌شده همیشه دقیق بماند.',
      'در بخش ردیابی لات (Dye Lot) می‌توانید موجودی هر شید رنگ را جداگانه کنترل کنید.',
    ],
    quickLinks: [
      { label: 'فهرست کالاها (F6)', module: 'inventory', subKey: 'inv-products' },
      { label: 'کاردکس ریالی', module: 'inventory', intent: 'kardex', subKey: 'inv-kardex' },
      { label: 'انتقال بین انبارها', module: 'inventory', intent: 'transfer', subKey: 'inv-transfer' },
      { label: 'لات رنگ و فرمول تولید', module: 'warehouse-crm', intent: 'dye-lots', subKey: 'wh-dyelots' },
    ],
    keywords: 'انبار کالا موجودی کاردکس میانگین fifo انبارگردانی انتقال بارکد اکسل لات رنگ bom تولید',
  },
  {
    id: 'treasury',
    title: 'خزانه‌داری، چک صیادی و امور ارزی',
    modules: ['treasury', 'currencies'],
    shortcut: 'F7',
    summary: 'چرخه کامل چک صیادی (واگذاری، وصول، خرج، برگشت)، چاپ کالیبره چک، مغایرت‌گیری بانکی، راس‌گیری و تسعیر ارز.',
    primaryTarget: { module: 'treasury', intent: 'cheques', subKey: 'tr-cheques' },
    steps: [
      'چک‌های دریافتی و پرداختی را با شناسه ۱۶ رقمی صیادی در «مدیریت چک (F7)» ثبت و وضعیت آن‌ها را با یک کلیک تغییر دهید.',
      'هر تغییر وضعیت چک (واگذاری به بانک، وصول یا برگشت) سند حسابداری دقیق و متناظر خود را خودکار صادر می‌کند.',
      'برای تطبیق صورتحساب بانک، فایل CSV بانک را در بخش «مغایرت‌گیری خودکار بانکی» بارگذاری کنید.',
      'در بخش «امور ارزی»، نرخ روز ارزها را ثبت و در پایان دوره سند «تسعیر ارز» را خودکار محاسبه نمایید.',
    ],
    tips: [
      'در بخش «چاپ کالیبره چک» می‌توانید موقعیت دقیق تاریخ، مبلغ و در وجه را بر حسب میلی‌متر تنظیم کنید.',
      'ماشین‌حساب راس‌گیری چک میانگین وزنی سررسید مجموعه چک‌ها را فوری حساب می‌کند.',
    ],
    quickLinks: [
      { label: 'مدیریت چک صیادی (F7)', module: 'treasury', intent: 'cheques', subKey: 'tr-cheques' },
      { label: 'مغایرت‌گیری بانکی', module: 'treasury', intent: 'reconciliation', subKey: 'tr-reconciliation' },
      { label: 'دریافت و پرداخت سریع', module: 'treasury', intent: 'quick', subKey: 'tr-quick' },
      { label: 'نرخ ارز و تسعیر', module: 'currencies', intent: 'converter', subKey: 'tr-fx-rates' },
    ],
    keywords: 'خزانه چک صیادی وصول برگشتی خرج چک راس گیری مغایرت بانکی ارز دلار تسعیر تنخواه وام',
  },
  {
    id: 'corporate',
    title: 'امور شرکتی (حقوق، اموال و مراکز هزینه)',
    modules: ['corporate'],
    shortcut: 'F8',
    summary: 'محاسبه حقوق و دستمزد طبق قانون بودجه ۱۴۰۴/۱۴۰۵، فیش حقوقی، استهلاک دارایی ثابت و بودجه‌بندی مراکز هزینه.',
    primaryTarget: { module: 'corporate', intent: 'payroll', subKey: 'corp-payroll' },
    steps: [
      'در «حقوق و دستمزد»، اطلاعات پرسنل و کارکرد ماهانه را وارد کنید تا بیمه، مالیات پلکانی و خالص پرداختی خودکار محاسبه شود.',
      'در «اموال و دارایی ثابت»، دارایی‌ها را با نرخ استهلاک ثبت کنید تا سند استهلاک دوره‌ای صادر گردد.',
      'با تعریف «مراکز هزینه»، سودآوری هر پروژه یا خط تولید را جداگانه تحلیل کنید.',
    ],
    tips: [
      'عملیات بستن حساب‌های موقت پایان سال و صدور سند اختتامیه نیز از بخش امور شرکتی و مرکز حسابرسی در دسترس است.',
    ],
    quickLinks: [
      { label: 'حقوق و دستمزد (F8)', module: 'corporate', intent: 'payroll', subKey: 'corp-payroll' },
      { label: 'اموال و استهلاک', module: 'corporate', intent: 'assets', subKey: 'corp-assets' },
      { label: 'مراکز هزینه', module: 'corporate', intent: 'costcenters', subKey: 'corp-cc' },
    ],
    keywords: 'حقوق دستمزد فیش بیمه مالیات اموال دارایی ثابت استهلاک مرکز هزینه بستن حساب سال مالی',
  },
  {
    id: 'reports',
    title: 'گزارش‌ها و دفاتر قانونی',
    modules: ['reports'],
    shortcut: 'F9',
    summary: 'تراز آزمایشی ۲ تا ۸ ستونی، سود و زیان، ترازنامه، مرور حساب‌ها با دریل‌داون، گزارش سنی مطالبات، فصلی ۱۶۹ و فایل بیمه/مالیات.',
    primaryTarget: { module: 'reports', intent: 'trial', subKey: 'rep-trial' },
    steps: [
      'از تب‌های بالای صفحه گزارش‌ها، تراز آزمایشی، سود و زیان، ترازنامه یا صورتحساب طرف‌حساب را انتخاب کنید.',
      'در «مرور حساب‌ها» و «دفتر کل/معین»، با کلیک روی هر ردیف می‌توانید تا ریز سند مربوطه وارد شوید (دریل‌داون).',
      'برای ارائه به سازمان امور مالیاتی و تأمین اجتماعی، از تب «خروجی‌های قانونی» فایل‌های استاندارد DSK، TTMS و مودیان را بگیرید.',
    ],
    tips: [
      'تمام گزارش‌ها قابل چاپ مستقیم با صفحه‌بندی تمیز و خروجی CSV/اکسل هستند.',
    ],
    quickLinks: [
      { label: 'تراز آزمایشی (F9)', module: 'reports', intent: 'trial', subKey: 'rep-trial' },
      { label: 'صورت سود و زیان', module: 'reports', intent: 'pnl', subKey: 'rep-pnl' },
      { label: 'ترازنامه', module: 'reports', intent: 'balance', subKey: 'rep-balance' },
      { label: 'معاملات فصلی ۱۶۹', module: 'reports', intent: 'seasonal-169', subKey: 'rep-169' },
    ],
    keywords: 'گزارش تراز آزمایشی سود زیان ترازنامه مرور حساب دفتر کل معین سنی مطالبات مودیان فصلی ۱۶۹ بیمه',
  },
  {
    id: 'audit',
    title: 'مرکز حسابرسی هوشمند و گزارش همگام‌سازی P2P',
    modules: ['audit'],
    summary: 'کنترل ۱۷ نقطه یکپارچگی دفاتر، گزارش زنده همگام‌سازی PeerJS بین ۳ دستگاه، محیط آزمایشی Sandbox، مهاجرت هلو ۲.۰.۳ و بایگانی مدارک.',
    primaryTarget: { module: 'audit', subKey: 'audit-center' },
    steps: [
      'در تب «حسابرسی و تطبیق کل/معین»، تطابق ریاضی دفتر کل با تفصیلی مشتریان، انبار، چک‌ها و ارزش افزوده را بررسی کنید.',
      'در تب جدید «گزارش همگام‌سازی P2P (Mesh)»، تاریخچه کامل تبادل بردار نسخه، ادغام‌های LWW و خطاهای اتصال بین ۳ دستگاه را مشاهده و فیلتر کنید.',
      'برای آزمایش تغییرات پرریسک بدون دستکاری دفاتر اصلی، از تب «محیط آزمایشی (Sandbox)» استفاده نمایید.',
    ],
    tips: [
      'امتیاز سلامت حسابرسی همیشه در نوار بالای صفحه نمایش داده می‌شود؛ در حالت ایده‌آل باید ۱۰۰٪ بدون خطای تراز باشد.',
    ],
    quickLinks: [
      { label: 'حسابرسی و تطبیق دفاتر', module: 'audit', subKey: 'audit-center' },
      { label: 'گزارش همگام‌سازی P2P (Mesh)', module: 'audit', intent: 'p2p_mesh_log', subKey: 'audit-center' },
    ],
    keywords: 'حسابرسی تطبیق کل معین گزارش همگام سازی p2p peerjs mesh بردار نسخه sandbox مهاجرت بایگانی مدارک',
  },
  {
    id: 'settings',
    title: 'تنظیمات، پوشه محلی، همگام‌سازی و کاربران (RBAC)',
    modules: ['settings', 'studio'],
    summary: 'تنظیم مسیر پوشه محلی، شبکه ۳ دستگاه P2P، ذخیره ابری مستقل Supabase و Firebase، کاربران RBAC، نصب PWA و استودیو اسناد.',
    primaryTarget: { module: 'settings', subKey: 'tool-settings' },
    steps: [
      'از نوار «جستجوی هوشمند تنظیمات» در بالای صفحه تنظیمات، سریع به بخش موردنظر (پوشه محلی، P2P، ابر، کاربران یا قالب فاکتور) بروید.',
      'در بخش اول، پوشه ذخیره‌سازی محلی خود را انتخاب و نقش دستگاه را برای شبکه ۳ دستگاه P2P مشخص کنید.',
      'در بخش دوم، در صورت تمایل پشتیبان‌گیری ابری مستقل Supabase (۳ نسخه چرخشی) یا Firebase را فعال نمایید.',
      'در بخش RBAC، اپراتورهای جدید با نقش‌های مدیر، حسابدار، انباردار یا فروشنده بسازید.',
    ],
    tips: [
      'حتماً از بخش نصب PWA، برنامه را روی گوشی یا ویندوز نصب کنید تا انتخاب پوشه محلی و کار ۱۰۰٪ آفلاین با بالاترین سرعت کار کند.',
    ],
    quickLinks: [
      { label: 'تنظیم پوشه محلی و P2P', module: 'settings', intent: 'local-folder-mesh', subKey: 'tool-settings' },
      { label: 'کاربران و دسترسی (RBAC)', module: 'settings', intent: 'rbac', subKey: 'tool-rbac' },
      { label: 'استودیو اسناد و کاتالوگ', module: 'studio', subKey: 'tool-studio' },
    ],
    keywords: 'تنظیمات پوشه محلی p2p ابر supabase firebase کاربران rbac نصب pwa قالب فاکتور استودیو',
  },
];

export const SYNC_ARCHITECTURE_GUIDES: SyncMethodGuide[] = [
  {
    id: 'dexie_indexeddb',
    title: '۱. حافظه داخلی دائمی دستگاه (Dexie IndexedDB)',
    subtitle: 'لایه پایه و همیشه فعال با محافظت Persistent Storage',
    offlineCapable: '100% آفلاین',
    bestFor: 'نگهداری ایمن و پرسرعت تمام اسناد روی خود گوشی یا لپ‌تاپ بدون نیاز به اینترنت و بدون نگرانی از پاک شدن کش مرورگر.',
    howItWorks: [
      'با اولین اجرای برنامه، درخواست navigator.storage.persist() ارسال می‌شود تا سیستم‌عامل داده‌های حسابداری را پاک نکند.',
      'هر رکورد با شناسه‌های یکتا (uuid، deviceId، updatedAt و isDeleted) در پایگاه داده Dexie ذخیره می‌شود.',
      'حتی اگر اینترنت قطع باشد یا مرورگر بسته شود، تمام اطلاعات شما بلافاصله هنگام باز کردن مجدد آماده است.',
    ],
    conflictPolicy: 'منبع اصلی محلی هر دستگاه؛ پایه ادغام در تمام روش‌های دیگر.',
    actionLabel: 'مشاهده وضعیت حافظه در مانیتور صف',
    actionId: 'open_queue_monitor',
    keywords: 'حافظه داخلی دائمی dexie indexeddb آفلاین persistent storage ذخیره پایه',
  },
  {
    id: 'local_folder',
    title: '۲. پوشه ذخیره‌سازی محلی کاربر (File System Access API)',
    subtitle: 'آینه‌سازی لحظه‌ای فایل زنده holoo_live_db.json + بکاپ روزانه (۱۴ روز)',
    offlineCapable: '100% آفلاین',
    bestFor: 'زمانی که می‌خواهید فایل واقعی پایگاه داده همیشه داخل یک پوشه مشخص روی هارد کامپیوتر (مثل Holoo_Data) یا حافظه دستگاه باشد.',
    howItWorks: [
      'از تنظیمات یا نوار بالا روی «انتخاب پوشه ذخیره‌سازی محلی» بزنید و یک پوشه روی دستگاه انتخاب کنید.',
      'پس از هر تغییر حسابداری، فایل زنده holoo_live_db.json و اسنپ‌شات روزانه holoo_daily_YYYY-MM-DD.json خودکار در آن پوشه نوشته می‌شود (تا ۱۴ روز نگهداری).',
      'با دکمه «بازیابی از پوشه انتخابی» می‌توانید هر زمان فایل پوشه را با الگوریتم LWW دوباره به برنامه برگردانید.',
      'در موبایل‌ها یا مرورگرهایی که انتخاب مستقیم پوشه را محدود می‌کنند، دکمه «ذخیره در پوشه دانلودها» به‌عنوان جایگزین هوشمند فعال است.',
    ],
    conflictPolicy: 'هنگام بازیابی از پوشه، ادغام فیلدبه‌فیلد LWW انجام می‌شود تا هیچ سند جدیدتری از دست نرود.',
    actionLabel: 'تنظیم یا تغییر پوشه محلی',
    actionId: 'open_local_mesh_settings',
    keywords: 'پوشه محلی مسیر ذخیره فایل holoo_live_db.json file system access دانلودها موبایل بازیابی',
  },
  {
    id: 'p2p_mesh',
    title: '۳. همگام‌سازی مستقیم و خودکار ۳ دستگاه (PeerJS P2P Mesh)',
    subtitle: 'اتصال مستقیم WebRTC بین لپ‌تاپ مهران، موبایل من و موبایل همکار + Mesh Relay',
    offlineCapable: 'آفلاین + همگام‌سازی خودکار هنگام آنلاین شدن',
    bestFor: 'همگام‌سازی سریع، مستقیم و رایگان میان ۳ دستگاه ثابت بدون وابستگی به سرور ابری.',
    howItWorks: [
      'روی هر دستگاه فقط یک‌بار نقش ثابت آن را انتخاب کنید: «لپ‌تاپ مهران»، «موبایل من» یا «موبایل همکار» (کلید امنیتی مشترک در هر ۳ دستگاه باید یکسان باشد).',
      'هر بار که برنامه باز شود، به صفحه برگردید یا اینترنت وصل شود، PeerMeshConnector به‌صورت خودکار به ۲ دستگاه دیگر متصل شده و بردار نسخه (Version Vector) را تبادل می‌کند.',
      'رله سه‌دستگاهی (Mesh Relay): اگر دستگاه ۳ خاموش باشد، تغییرات در صف sync_outbox دستگاه ۱ و ۲ می‌ماند و به محض آنلاین شدن دستگاه ۳ از طریق هر دستگاه آنلاینی به آن تحویل می‌شود.',
      'در نوار بالای صفحه، دکمه P2P با افکت موج ظریف (Pulse) زنده بودن اتصال و تعداد همتاهای متصل را نشان می‌دهد و گزارش کامل آن در تب «گزارش همگام‌سازی P2P» در بخش حسابرسی ثبت می‌شود.',
    ],
    conflictPolicy: 'ادغام قطعی فیلدبه‌فیلد LWW (جدیدترین زمان ویرایش برنده است)؛ هر ۳ دستگاه صرف‌نظر از ترتیب اتصال به یک وضعیت یکسان می‌رسند.',
    actionLabel: 'تنظیم دستگاه‌ها و همگام‌سازی P2P',
    actionId: 'open_local_mesh_settings',
    keywords: 'peerjs p2p mesh سه دستگاه لپ تاپ موبایل همکار رله بردار نسخه webrtc کلید امنیتی',
  },
  {
    id: 'offline_outbox',
    title: '۴. مانیتور صف آفلاین (sync_outbox)',
    subtitle: 'تضمین عدم از دست رفتن حتی یک سند در زمان قطع اینترنت یا آفلاین بودن همتاها',
    offlineCapable: '100% آفلاین',
    bestFor: 'بررسی دقیق اینکه کدام تغییرات به کدام دستگاه تحویل شده و ارسال مجدد دستی یا خودکار موارد در انتظار.',
    howItWorks: [
      'وقتی آفلاین هستید یا یکی از دستگاه‌ها خاموش است، هر تغییر به‌صورت یک بسته در صف sync_outbox در Dexie ثبت می‌شود.',
      'در پنل «مانیتور صف آفلاین» می‌توانید برای هر بسته تیک تحویل هر دستگاه (لپ‌تاپ / موبایل من / موبایل همکار)، صف پوشه محلی و صف Supabase را ببینید.',
      'پس از بازگشت اینترنت یا اتصال همتا و دریافت تاییدیه (ACK)، وضعیت بسته به «تحویل کامل» تغییر می‌کند.',
    ],
    conflictPolicy: 'دارای قابلیت ارسال مجدد تکی و گروهی (Idempotent) بدون ایجاد سند تکراری.',
    actionLabel: 'باز کردن مانیتور صف آفلاین',
    actionId: 'open_queue_monitor',
    keywords: 'صف آفلاین sync_outbox مانیتور ارسال مجدد ack تحویل دستگاه انتظار',
  },
  {
    id: 'supabase_cloud',
    title: '۵. همگام‌سازی ابری مستقل Supabase PostgreSQL',
    subtitle: 'پشتیبان‌گیری ابری کاملاً مستقل (بدون نیاز به ورود گوگل یا Firebase) با ۳ نسخه چرخشی',
    offlineCapable: 'آفلاین + همگام‌سازی خودکار هنگام آنلاین شدن',
    bestFor: 'نگهداری پشتیبان مطمئن ابری روی دیتابیس PostgreSQL با رمز اختصاصی فضای کاری و امکان بازیابی روی هر دستگاه جدید.',
    howItWorks: [
      'در تنظیمات بخش «ذخیره‌سازی ابری دوگانه»، شناسه فضای کاری و رمز عبور مستقل Supabase را وارد و فعال کنید.',
      'نشست ورود شما با کوکی امن سرور ذخیره می‌شود و نیازی به ورود با اکانت گوگل ندارد.',
      'حداکثر ۳ نسخه پشتیبان آخر نگهداری و نسخه‌های قدیمی‌تر به‌صورت خودکار پاکسازی می‌شوند. دکمه «تست زنده سرور» سلامت اتصال و دیتابیس را لحظه‌ای بررسی می‌کند.',
    ],
    conflictPolicy: 'قابل انتخاب توسط کاربر میان «آخرین تغییر برنده (LWW)» یا «حفظ نسخه قدیمی‌تر (FWW)».',
    actionLabel: 'تنظیمات و تست زنده Supabase',
    actionId: 'open_dual_cloud_settings',
    keywords: 'supabase ابر سرور postgresql پشتیبان مستقل سه نسخه چرخشی تست سرور کوکی رمز',
  },
  {
    id: 'firebase_cloud',
    title: '۶. پشتیبان ابری اختیاری Firebase (ورود گوگل)',
    subtitle: 'سرویس ابری دوم و کاملاً مجزا با ورود یک‌کلیکی گوگل',
    offlineCapable: 'نیازمند اینترنت',
    bestFor: 'افرادی که می‌خواهند در کنار پوشه محلی، P2P و Supabase یک نسخه ابری اضافی هم متصل به اکانت گوگل داشته باشند.',
    howItWorks: [
      'از منوی ابر در نوار بالا یا بخش تنظیمات روی «ورود با گوگل» کلیک کنید.',
      'مشابه Supabase، حداکثر ۳ نسخه پشتیبان چرخشی در کلود نگهداری می‌شود و کاملاً مستقل از سایر روش‌هاست.',
    ],
    conflictPolicy: 'تشخیص تعارض بر اساس نسخه (Revision) با امکان دریافت یا بازنویسی آگاهانه.',
    actionLabel: 'تنظیمات ابر دوگانه',
    actionId: 'open_dual_cloud_settings',
    keywords: 'firebase فایربیس گوگل ابر اختیاری پشتیبان ورود خروج',
  },
];

export const OFFLINE_TROUBLESHOOTING_SCENARIOS: OfflineScenarioItem[] = [
  {
    id: 'scen-pure-offline',
    question: 'می‌خواهم بدون اینترنت کار کنم؛ آیا اطلاعاتم از بین می‌رود؟',
    badge: '۱۰۰٪ آفلاین',
    answer:
      'خیر. برنامه به‌صورت آفلاین-اول (Offline-First) طراحی شده است. تمام اسناد، فاکتورها و چک‌ها فوراً در Dexie IndexedDB (با محافظت Persistent) و پوشه انتخابی شما ذخیره می‌شوند و همزمان در صف sync_outbox قرار می‌گیرند تا هر زمان آنلاین شدید خودکار همگام‌سازی شوند.',
    steps: [
      'برای اطمینان بیشتر، برنامه را به‌صورت PWA نصب کنید تا بدون اینترنت هم باز شود.',
      'در لپ‌تاپ یک پوشه محلی انتخاب کنید تا فایل holoo_live_db.json همیشه روی هارد شما بماند.',
    ],
    actionLabel: 'تنظیم پوشه محلی',
    actionId: 'open_local_mesh_settings',
    keywords: 'آفلاین بدون اینترنت قطع نت ذخیره پاک شدن اطلاعات pwa',
  },
  {
    id: 'scen-3-devices',
    question: 'چطور لپ‌تاپ و ۲ موبایل را به هم وصل کنم که خودکار سینک شوند؟',
    badge: 'همگام‌سازی ۳ دستگاه',
    answer:
      'از همگام‌سازی مستقیم PeerJS Mesh استفاده کنید. کافی است هر دستگاه را یک‌بار با شناسه اختصاصی خودش تنظیم کنید و کلید امنیتی مشترک (Passphrase) در هر ۳ دستگاه یکسان باشد.',
    steps: [
      'روی لپ‌تاپ گزینه «لپ‌تاپ مهران»، روی گوشی اول «موبایل من» و روی گوشی دوم «موبایل همکار» را انتخاب کنید.',
      'مطمئن شوید کلید امنیتی مشترک در هر ۳ دستگاه دقیقاً یکسان است.',
      'از این به بعد هر بار برنامه را باز کنید، تبادل بردار نسخه و ادغام تغییرات خودکار انجام می‌شود و اگر دستگاه سومی خاموش باشد، از طریق Mesh Relay بعداً تحویل می‌گیرد.',
    ],
    actionLabel: 'باز کردن ویزارد انتخاب دستگاه',
    actionId: 'open_mesh_wizard',
    keywords: 'سه دستگاه لپ تاپ موبایل همکار اتصال همگام سازی خودکار peerjs کلید',
  },
  {
    id: 'scen-folder-permission',
    question: 'پیغام «نیاز به تایید مجدد مجوز پوشه انتخابی» نمایش داده شد؛ چه کار کنم؟',
    badge: 'پوشه محلی',
    answer:
      'به دلایل امنیتی مرورگرها، پس از بستن کامل مرورگر و باز کردن مجدد، ممکن است مرورگر برای نوشتن مجدد داخل پوشه محلی یک کلیک تأیید بخواهد. اطلاعات شما در این فاصله در حافظه داخلی Dexie و صف آفلاین کاملاً محفوظ است.',
    steps: [
      'روی دکمه نارنجی «تایید مجوز پوشه» در نوار بالا یا داخل تنظیمات کلیک کنید.',
      'در پنجره مرورگر گزینه Allow / Edit files را تایید کنید تا فایل holoo_live_db.json فوراً بروزرسانی شود.',
    ],
    actionLabel: 'تایید مجوز در تنظیمات',
    actionId: 'open_local_mesh_settings',
    keywords: 'مجوز پوشه تایید مجدد prompt permission دسترسی فایل محلی',
  },
  {
    id: 'scen-mobile-fallback',
    question: 'روی موبایل دکمه انتخاب پوشه مستقیم پشتیبانی نمی‌شود؛ راهکار چیست؟',
    badge: 'موبایل / iOS',
    answer:
      'برخی مرورگرهای موبایل (مانند Safari) یا نمای iframe اجازه دسترسی مستقیم به پوشه را نمی‌دهند. در این حالت حافظه دائمی Dexie IndexedDB به‌طور کامل فعال است و برای بکاپ فایلی می‌توانید از دکمه «ذخیره در پوشه دانلودها» استفاده کنید.',
    steps: [
      'تمام داده‌ها روی موبایل در Dexie IndexedDB دائمی ذخیره می‌شوند و با P2P به لپ‌تاپ می‌روند.',
      'برای ذخیره فایل JSON در گوشی، از تنظیمات روی «ذخیره در پوشه دانلودها (جایگزین موبایل)» بزنید.',
    ],
    actionLabel: 'رفتن به بخش ذخیره محلی',
    actionId: 'open_local_mesh_settings',
    keywords: 'موبایل گوشی سافاری آیفون انتخاب پوشه پشتیبانی نمی کند دانلودها جایگزین',
  },
  {
    id: 'scen-queue-pending',
    question: 'چرا تعدادی آیتم در «صف آفلاین» باقی مانده و ارسال نشده است؟',
    badge: 'صف sync_outbox',
    answer:
      'وقتی یکی از ۲ دستگاه همتا خاموش باشد یا اینترنت قطع باشد، بسته در صف sync_outbox باقی می‌ماند تا پس از آنلاین شدن تحویل گرفته شود و ACK برگرداند.',
    steps: [
      'پنل «مانیتور صف آفلاین» را باز کنید و ببینید کنار نام کدام دستگاه علامت انتظار (⏳) است.',
      'به محض باز شدن برنامه روی آن دستگاه، تحویل خودکار انجام می‌شود یا می‌توانید روی «تلاش مجدد همه صف» کلیک کنید.',
    ],
    actionLabel: 'باز کردن مانیتور صف آفلاین',
    actionId: 'open_queue_monitor',
    keywords: 'صف آفلاین باقی مانده ارسال نشده pending outbox ack رله',
  },
  {
    id: 'scen-p2p-audit',
    question: 'چطور بفهمم همگام‌سازی P2P موفق بوده یا خطایی رخ داده است؟',
    badge: 'حسابرسی P2P',
    answer:
      'تمامی رویدادهای اتصال، تبادل بردار نسخه، ادغام LWW و خطاهای احتمالی (مثل یکسان نبودن کلید امنیتی یا آفلاین بودن همتا) با تاریخ شمسی در تب اختصاصی مرکز حسابرسی ثبت می‌شوند.',
    steps: [
      'روی دکمه P2P در نوار بالای صفحه کلیک کنید یا به «مرکز حسابرسی > گزارش همگام‌سازی P2P (Mesh)» بروید.',
      'رویدادها را بر اساس «موفق» یا «ناموفق / خطا» و نام دستگاه فیلتر کنید.',
    ],
    actionLabel: 'مشاهده گزارش همگام‌سازی P2P',
    actionId: 'open_audit_p2p_log',
    keywords: 'گزارش خطا موفق ناموفق همگام سازی لاگ حسابرسی بردار نسخه کلید اشتباه',
  },
];

export function normalizePersianQuery(text: string): string {
  return (text || '')
    .trim()
    .toLowerCase()
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/\u200c/g, ' ')
    .replace(/\s+/g, ' ');
}

export function searchOfflineGuide(query: string): {
  modules: ModuleGuideItem[];
  syncMethods: SyncMethodGuide[];
  scenarios: OfflineScenarioItem[];
} {
  const norm = normalizePersianQuery(query);
  if (!norm) {
    return {
      modules: MODULE_GUIDES,
      syncMethods: SYNC_ARCHITECTURE_GUIDES,
      scenarios: OFFLINE_TROUBLESHOOTING_SCENARIOS,
    };
  }

  const tokens = norm.split(' ').filter(Boolean);
  const matches = (haystack: string) => {
    const h = normalizePersianQuery(haystack);
    return tokens.every((tok) => h.includes(tok));
  };

  return {
    modules: MODULE_GUIDES.filter((m) =>
      matches(
        `${m.title} ${m.summary} ${m.keywords} ${m.steps.join(' ')} ${m.tips.join(' ')} ${m.quickLinks.map((q) => q.label).join(' ')}`
      )
    ),
    syncMethods: SYNC_ARCHITECTURE_GUIDES.filter((s) =>
      matches(`${s.title} ${s.subtitle} ${s.bestFor} ${s.howItWorks.join(' ')} ${s.conflictPolicy} ${s.keywords}`)
    ),
    scenarios: OFFLINE_TROUBLESHOOTING_SCENARIOS.filter((sc) =>
      matches(`${sc.question} ${sc.badge} ${sc.answer} ${sc.steps.join(' ')} ${sc.keywords}`)
    ),
  };
}
