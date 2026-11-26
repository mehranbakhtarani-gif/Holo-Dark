/**
 * Multi-Warehouse Inventory & Tracked Transfer Engine
 *
 * Provides full ERP warehouse controls on top of `inventoryCostingEngine.ts`:
 *  - Physical Stock (موجودی فیزیکی)
 *  - Reserved Stock (موجودی رزروشده از سفارشات فروش باز و فاکتورهای رزرو)
 *  - Available-to-Sell Stock (موجودی قابل فروش = فیزیکی - رزروشده)
 *  - In-Transit Stock (کالای در راه از انتقالات بین انبار و پرونده‌های واردات در راه)
 *  - Per-Warehouse, Per-Product Independent Kardex
 *  - Auditable Tracked Inter-Warehouse Transfers preserving FIFO layers & 0 P&L impact
 *  - Shortage / Surplus Variance Control
 */

import {
  ImportDossier,
  InventoryCostingMethod,
  InventoryCostLayer,
  Invoice,
  Product,
  SalesOrder,
} from '../types/accounting';
import {
  normalizeProductCostState,
  planWarehouseTransfer,
  roundQty,
  WarehouseTransferPlan,
} from './inventoryCostingEngine';
import { addIrr, mulQtyByIrr, roundQtyFixed, sumIrr, toExactIrr } from './moneyMath';

export type WarehouseTransferStatus = 'in_transit' | 'received' | 'cancelled';

export interface TrackedWarehouseTransfer {
  id: string;
  transferNumber: string;
  date: string;
  receivedDate?: string;
  productId: string;
  sku: string;
  productName: string;
  fromWarehouse: string;
  toWarehouse: string;
  qty: number;
  transferredCostIrr: number;
  transferredLayers: InventoryCostLayer[];
  status: WarehouseTransferStatus;
  voucherId?: string;
  operatorName?: string;
  notes?: string;
}

export interface WarehouseProductPosition {
  warehouse: string;
  productId: string;
  sku: string;
  productName: string;
  unit: string;
  costingMethod: InventoryCostingMethod;
  physicalQty: number;
  reservedQty: number;
  availableToSellQty: number;
  inTransitInQty: number;
  inTransitOutQty: number;
  valuationIrr: number;
  unitCostIrr: number;
  reorderPoint: number;
  isLowStock: boolean;
  isNegative: boolean;
}

export interface WarehouseKardexRow {
  date: string;
  refNumber: string;
  movementType:
    | 'opening'
    | 'purchase'
    | 'sale'
    | 'sale_return'
    | 'purchase_return'
    | 'waste'
    | 'transfer_in'
    | 'transfer_out';
  warehouse: string;
  inQty: number;
  outQty: number;
  balanceQty: number;
  valueIrr: number;
  notes: string;
}

export interface WarehouseSummaryRow {
  warehouse: string;
  skuCount: number;
  totalPhysicalQty: number;
  totalReservedQty: number;
  totalAvailableQty: number;
  totalInTransitQty: number;
  totalValuationIrr: number;
}

export interface ShortageSurplusCheck {
  productId: string;
  sku: string;
  productName: string;
  warehouse: string;
  bookQty: number;
  countedQty: number;
  varianceQty: number; // + surplus, - shortage
  unitCostIrr: number;
  varianceValueIrr: number;
  kind: 'exact' | 'surplus' | 'shortage';
}

const TRANSFERS_STORAGE_KEY = 'holoo_apex_warehouse_transfers_v1';

export function loadTrackedWarehouseTransfers(): TrackedWarehouseTransfer[] {
  try {
    const raw = localStorage.getItem(TRANSFERS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as TrackedWarehouseTransfer[]) : [];
  } catch {
    return [];
  }
}

export function saveTrackedWarehouseTransfers(transfers: TrackedWarehouseTransfer[]): void {
  try {
    localStorage.setItem(TRANSFERS_STORAGE_KEY, JSON.stringify(transfers.slice(0, 200)));
  } catch {
    // ignore storage errors
  }
}

/**
 * Computes Physical, Reserved, Available-to-Sell, and In-Transit positions
 * for every product across all warehouses.
 */
export function computeMultiWarehouseMatrix(params: {
  products: Product[];
  salesOrders?: SalesOrder[];
  reservedInvoiceItems?: { productId: string; warehouse?: string; quantity: number }[];
  importDossiers?: ImportDossier[];
  transfers?: TrackedWarehouseTransfer[];
  defaultCostingMethod?: InventoryCostingMethod;
}): {
  positions: WarehouseProductPosition[];
  warehouseSummaries: WarehouseSummaryRow[];
  totalPhysicalValuationIrr: number;
} {
  const {
    products,
    salesOrders = [],
    reservedInvoiceItems = [],
    importDossiers = [],
    transfers = [],
    defaultCostingMethod = 'moving_average',
  } = params;

  // 1. Aggregate reserved quantities from open (ordered) sales orders & reserved invoices
  const reservedByKey = new Map<string, number>();
  for (const so of salesOrders) {
    if (so.status !== 'ordered') continue;
    for (const item of so.items) {
      const k = `${so.warehouse}::${item.productId}`;
      reservedByKey.set(k, roundQtyFixed((reservedByKey.get(k) || 0) + (item.orderedWeightKg || 0), 4));
    }
  }
  for (const r of reservedInvoiceItems) {
    const prod = products.find((p) => p.id === r.productId);
    const wh = r.warehouse || prod?.warehouse || 'انبار مرکزی';
    const k = `${wh}::${r.productId}`;
    reservedByKey.set(k, roundQtyFixed((reservedByKey.get(k) || 0) + (r.quantity || 0), 4));
  }

  // 2. Aggregate in-transit quantities (from active in_transit transfers + in_transit/customs import dossiers)
  const inTransitInByKey = new Map<string, number>();
  const inTransitOutByKey = new Map<string, number>();
  const inTransitValueByKey = new Map<string, number>();
  for (const trf of transfers) {
    if (trf.status !== 'in_transit') continue;
    const inKey = `${trf.toWarehouse}::${trf.productId}`;
    const outKey = `${trf.fromWarehouse}::${trf.productId}`;
    inTransitInByKey.set(inKey, roundQtyFixed((inTransitInByKey.get(inKey) || 0) + trf.qty, 4));
    inTransitOutByKey.set(outKey, roundQtyFixed((inTransitOutByKey.get(outKey) || 0) + trf.qty, 4));
    inTransitValueByKey.set(inKey, addIrr(inTransitValueByKey.get(inKey) || 0, trf.transferredCostIrr));
  }
  for (const imp of importDossiers) {
    if (imp.status !== 'in_transit' && imp.status !== 'customs') continue;
    for (const item of imp.items) {
      const inKey = `${imp.warehouse}::${item.productId}`;
      inTransitInByKey.set(inKey, roundQtyFixed((inTransitInByKey.get(inKey) || 0) + (item.weightKg || 0), 4));
    }
  }

  // 3. Build positions from product cost layers (grouped by warehouse)
  const positions: WarehouseProductPosition[] = [];

  for (const p of products) {
    const state = normalizeProductCostState(p, defaultCostingMethod);
    const byWh = new Map<string, { qty: number; valIrr: number }>();

    if (state.layers.length > 0) {
      for (const layer of state.layers) {
        const wh = layer.warehouse || p.warehouse || 'انبار مرکزی';
        // In-transit layers remain part of inventory valuation, but are not physical
        // stock in either warehouse until the receiving transaction is committed.
        if (wh.startsWith('در راه → ')) continue;
        const cur = byWh.get(wh) || { qty: 0, valIrr: 0 };
        cur.qty = roundQtyFixed(cur.qty + layer.remainingQty, 4);
        cur.valIrr = addIrr(cur.valIrr, layer.totalCostIrr);
        byWh.set(wh, cur);
      }
    } else {
      const wh = p.warehouse || 'انبار مرکزی';
      byWh.set(wh, {
        qty: roundQtyFixed(p.stock, 4),
        valIrr:
          p.inventoryValueIrr !== undefined
            ? toExactIrr(p.inventoryValueIrr)
            : mulQtyByIrr(p.stock, p.buyPrice),
      });
    }

    // Ensure warehouses with pending in-transit inflows appear even if physical stock is 0
    for (const trf of transfers) {
      if (trf.productId === p.id && trf.status === 'in_transit' && !byWh.has(trf.toWarehouse)) {
        byWh.set(trf.toWarehouse, { qty: 0, valIrr: 0 });
      }
    }

    for (const [warehouse, bucket] of byWh.entries()) {
      const key = `${warehouse}::${p.id}`;
      const reservedQty = reservedByKey.get(key) || 0;
      const inTransitInQty = inTransitInByKey.get(key) || 0;
      const inTransitOutQty = inTransitOutByKey.get(key) || 0;
      const availableToSellQty = roundQtyFixed(Math.max(0, bucket.qty - reservedQty), 4);
      const unitCostIrr = bucket.qty > 0 ? Math.round(bucket.valIrr / bucket.qty) : toExactIrr(p.buyPrice);

      positions.push({
        warehouse,
        productId: p.id,
        sku: p.sku,
        productName: p.name,
        unit: p.unit,
        costingMethod: state.costingMethod,
        physicalQty: roundQtyFixed(bucket.qty, 2),
        reservedQty: roundQtyFixed(reservedQty, 2),
        availableToSellQty: roundQtyFixed(availableToSellQty, 2),
        inTransitInQty: roundQtyFixed(inTransitInQty, 2),
        inTransitOutQty: roundQtyFixed(inTransitOutQty, 2),
        valuationIrr: bucket.valIrr,
        unitCostIrr,
        reorderPoint: p.reorderPoint,
        isLowStock: availableToSellQty <= p.reorderPoint,
        isNegative: bucket.qty < 0,
      });
    }
  }

  // 4. Aggregate warehouse summaries
  const summaryMap = new Map<string, WarehouseSummaryRow>();
  for (const pos of positions) {
    const existing = summaryMap.get(pos.warehouse) || {
      warehouse: pos.warehouse,
      skuCount: 0,
      totalPhysicalQty: 0,
      totalReservedQty: 0,
      totalAvailableQty: 0,
      totalInTransitQty: 0,
      totalValuationIrr: 0,
    };
    existing.skuCount += 1;
    existing.totalPhysicalQty = roundQtyFixed(existing.totalPhysicalQty + pos.physicalQty, 2);
    existing.totalReservedQty = roundQtyFixed(existing.totalReservedQty + pos.reservedQty, 2);
    existing.totalAvailableQty = roundQtyFixed(existing.totalAvailableQty + pos.availableToSellQty, 2);
    existing.totalInTransitQty = roundQtyFixed(existing.totalInTransitQty + pos.inTransitInQty, 2);
    existing.totalValuationIrr = addIrr(existing.totalValuationIrr, pos.valuationIrr);
    summaryMap.set(pos.warehouse, existing);
  }

  // Attribute in-transit inventory value to its destination summary without counting
  // it as physical quantity or duplicating it in the source/destination warehouses.
  for (const [key, valueIrr] of inTransitValueByKey.entries()) {
    const separator = key.indexOf('::');
    const warehouse = key.slice(0, separator);
    const existing = summaryMap.get(warehouse);
    if (existing) existing.totalValuationIrr = addIrr(existing.totalValuationIrr, valueIrr);
  }

  return {
    positions,
    warehouseSummaries: Array.from(summaryMap.values()).sort(
      (a, b) => b.totalValuationIrr - a.totalValuationIrr
    ),
    // Inventory asset valuation includes goods in transit until receipt; physical
    // warehouse quantities above deliberately exclude those layers.
    totalPhysicalValuationIrr: sumIrr(products.map((product) =>
      normalizeProductCostState(product, defaultCostingMethod).totalValueIrr
    )),
  };
}

/**
 * Executes a deterministic tracked inter-warehouse transfer preserving FIFO layers,
 * producing updated product state + TrackedWarehouseTransfer record + strictly 0 P&L impact.
 */
export function executeTrackedWarehouseTransfer(params: {
  product: Product;
  fromWarehouse: string;
  toWarehouse: string;
  qty: number;
  date: string;
  transferNumber: string;
  mode: 'immediate' | 'in_transit';
  operatorName?: string;
  notes?: string;
  defaultCostingMethod?: InventoryCostingMethod;
}): {
  plan: WarehouseTransferPlan;
  updatedProduct: Product;
  transferRecord: TrackedWarehouseTransfer;
  pnlImpactIrr: 0;
} {
  const {
    product,
    fromWarehouse,
    toWarehouse,
    qty,
    date,
    transferNumber,
    mode,
    operatorName,
    notes,
    defaultCostingMethod = 'moving_average',
  } = params;

  const state = normalizeProductCostState(product, defaultCostingMethod);
  // Filter layers belonging to source warehouse
  const sourceLayers = state.layers.filter((l) => (l.warehouse || product.warehouse) === fromWarehouse);
  const otherLayers = state.layers.filter((l) => (l.warehouse || product.warehouse) !== fromWarehouse);
  const sourceQty = roundQty(sourceLayers.reduce((s, l) => s + l.remainingQty, 0));
  const sourceVal = sumIrr(sourceLayers.map((l) => l.totalCostIrr));

  const sourceState = {
    ...state,
    stockQty: sourceQty,
    totalValueIrr: sourceVal,
    layers: sourceLayers,
  };

  const transferId = `trf_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const plan = planWarehouseTransfer({
    state: sourceState,
    fromWarehouse,
    toWarehouse,
    qty,
    transferId,
    date,
  });

  // In 'immediate' mode, destination layers become active immediately in toWarehouse.
  // In 'in_transit' mode, destination layers are tagged 'کالای در راه' until received!
  const movedLayers = plan.transferredLayers.map((l) => ({
    ...l,
    warehouse: mode === 'immediate' ? toWarehouse : `در راه → ${toWarehouse}`,
  }));

  const combinedLayers = [...otherLayers, ...plan.remainingSourceLayers, ...movedLayers];
  const totalQty = roundQtyFixed(combinedLayers.reduce((s, l) => s + l.remainingQty, 0), 2);
  const totalValIrr = sumIrr(combinedLayers.map((l) => l.totalCostIrr));

  const updatedProduct: Product = {
    ...product,
    warehouse:
      plan.remainingSourceLayers.length === 0 && otherLayers.length === 0 && mode === 'immediate'
        ? toWarehouse
        : product.warehouse,
    stock: totalQty,
    inventoryValueIrr: totalValIrr,
    costLayers: combinedLayers,
  };

  const transferRecord: TrackedWarehouseTransfer = {
    id: transferId,
    transferNumber,
    date,
    receivedDate: mode === 'immediate' ? date : undefined,
    productId: product.id,
    sku: product.sku,
    productName: product.name,
    fromWarehouse,
    toWarehouse,
    qty: plan.qty,
    transferredCostIrr: plan.transferredCostIrr,
    transferredLayers: plan.transferredLayers,
    status: mode === 'immediate' ? 'received' : 'in_transit',
    operatorName,
    notes,
  };

  return {
    plan,
    updatedProduct,
    transferRecord,
    pnlImpactIrr: 0,
  };
}

/**
 * Receives a tracked in-transit transfer without changing total stock or valuation.
 * Only the exact layer IDs created by the transfer may be moved into the destination.
 */
export function receiveTrackedWarehouseTransfer(params: {
  product: Product;
  transfer: TrackedWarehouseTransfer;
  receivedDate: string;
}): {
  updatedProduct: Product;
  updatedTransfer: TrackedWarehouseTransfer;
  pnlImpactIrr: 0;
} {
  const { product, transfer, receivedDate } = params;
  if (!receivedDate.trim()) throw new Error('تاریخ دریافت انتقال الزامی است.');
  if (product.id !== transfer.productId) throw new Error('انتقال متعلق به این کالا نیست.');
  if (transfer.status !== 'in_transit') {
    throw new Error('فقط انتقالی که در وضعیت «در راه» است قابل دریافت است.');
  }
  if (!transfer.transferredLayers.length) {
    throw new Error('لایه‌های بهای تمام‌شده انتقال موجود نیستند.');
  }

  const expectedById = new Map(transfer.transferredLayers.map((layer) => [layer.layerId, layer]));
  if (expectedById.size !== transfer.transferredLayers.length) {
    throw new Error('شناسه لایه در اطلاعات انتقال تکراری است.');
  }

  const layers = product.costLayers || [];
  const actualIndexes = new Map<string, number>();
  layers.forEach((layer, index) => {
    if (expectedById.has(layer.layerId)) {
      if (actualIndexes.has(layer.layerId)) {
        throw new Error('شناسه لایه انتقال در موجودی کالا تکراری است.');
      }
      actualIndexes.set(layer.layerId, index);
    }
  });

  if (actualIndexes.size !== expectedById.size) {
    throw new Error('تمام لایه‌های انتقال در موجودی در راه یافت نشدند؛ دریافت انجام نشد.');
  }

  let actualQty = 0;
  let actualValue = 0;
  const nextLayers = layers.map((layer) => {
    const expected = expectedById.get(layer.layerId);
    if (!expected) return layer;
    if (
      layer.warehouse !== `در راه → ${transfer.toWarehouse}` ||
      layer.sourceRef !== expected.sourceRef ||
      Math.abs(layer.remainingQty - expected.remainingQty) > 0.00005 ||
      layer.totalCostIrr !== expected.totalCostIrr
    ) {
      throw new Error('اطلاعات لایه انتقال با سند انتقال مطابقت ندارد؛ دریافت متوقف شد.');
    }
    actualQty += layer.remainingQty;
    actualValue += layer.totalCostIrr;
    return { ...layer, warehouse: transfer.toWarehouse };
  });

  if (
    Math.abs(actualQty - transfer.qty) > 0.0001 ||
    actualValue !== transfer.transferredCostIrr
  ) {
    throw new Error('مقدار یا ارزش لایه‌های انتقال با سند انتقال مغایرت دارد.');
  }

  const updatedProduct: Product = {
    ...product,
    costLayers: nextLayers,
    // Receiving only changes the warehouse tag; total quantity and value remain unchanged.
  };
  const updatedTransfer: TrackedWarehouseTransfer = {
    ...transfer,
    status: 'received',
    receivedDate,
  };

  return { updatedProduct, updatedTransfer, pnlImpactIrr: 0 };
}

/**
 * Builds an independent per-warehouse Kardex for a specific product.
 */
export function computeWarehouseProductKardex(params: {
  product: Product;
  warehouse: string;
  invoices: Invoice[];
  transfers?: TrackedWarehouseTransfer[];
}): WarehouseKardexRow[] {
  const { product, warehouse, invoices, transfers = [] } = params;

  type RawEvent = {
    date: string;
    refNumber: string;
    movementType: WarehouseKardexRow['movementType'];
    inQty: number;
    outQty: number;
    valueIrr: number;
    notes: string;
  };

  const events: RawEvent[] = [];

  for (const inv of invoices) {
    if (inv.status === 'cancelled' || inv.invoiceType === 'proforma') continue;
    if (inv.warehouse !== warehouse) continue;
    for (const item of inv.items) {
      if (item.productId !== product.id) continue;
      const qty = roundQtyFixed(item.quantity, 4);
      const val =
        item.totalCostIrr !== undefined
          ? toExactIrr(item.totalCostIrr)
          : mulQtyByIrr(qty, item.unitCostSnapshot ?? product.buyPrice);

      if (inv.invoiceType === 'purchase' || inv.invoiceType === 'sale_return') {
        events.push({
          date: inv.date,
          refNumber: inv.invoiceNumber,
          movementType: inv.invoiceType,
          inQty: qty,
          outQty: 0,
          valueIrr: val,
          notes: `${inv.invoiceType === 'purchase' ? 'خرید از' : 'برگشت فروش از'} ${inv.partyName}`,
        });
      } else {
        events.push({
          date: inv.date,
          refNumber: inv.invoiceNumber,
          movementType:
            inv.invoiceType === 'sale'
              ? 'sale'
              : inv.invoiceType === 'purchase_return'
                ? 'purchase_return'
                : 'waste',
          inQty: 0,
          outQty: qty,
          valueIrr: val,
          notes: `${inv.invoiceType === 'sale' ? 'فروش به' : inv.invoiceType === 'purchase_return' ? 'برگشت خرید به' : 'ضایعات'} ${inv.partyName}`,
        });
      }
    }
  }

  for (const trf of transfers) {
    if (trf.productId !== product.id || trf.status === 'cancelled') continue;
    if (trf.fromWarehouse === warehouse) {
      events.push({
        date: trf.date,
        refNumber: trf.transferNumber,
        movementType: 'transfer_out',
        inQty: 0,
        outQty: trf.qty,
        valueIrr: trf.transferredCostIrr,
        notes: `انتقال خروجی به ${trf.toWarehouse}`,
      });
    }
    if (trf.toWarehouse === warehouse && trf.status === 'received') {
      events.push({
        date: trf.receivedDate || trf.date,
        refNumber: trf.transferNumber,
        movementType: 'transfer_in',
        inQty: trf.qty,
        outQty: 0,
        valueIrr: trf.transferredCostIrr,
        notes: `انتقال ورودی از ${trf.fromWarehouse}`,
      });
    }
  }

  events.sort((a, b) => a.date.localeCompare(b.date));

  let runningQty = 0;
  return events.map((ev) => {
    runningQty = roundQtyFixed(runningQty + ev.inQty - ev.outQty, 2);
    return {
      ...ev,
      warehouse,
      balanceQty: runningQty,
    };
  });
}

export interface WarehouseKardexReconciliation {
  warehouse: string;
  productId: string;
  openingQty: number;
  openingValueIrr: number;
  kardexQty: number;
  kardexValueIrr: number;
  physicalQty: number;
  physicalValueIrr: number;
  quantityDifference: number;
  valueDifferenceIrr: number;
  isQuantityBalanced: boolean;
  isValueBalanced: boolean;
  isBalanced: boolean;
}

/**
 * Reconciles a warehouse Kardex against its current physical FIFO layers.
 * Opening balances must represent the balance immediately before the supplied
 * invoices/transfers; in-transit layers are excluded from physical warehouse stock.
 */
export function reconcileWarehouseKardex(params: {
  product: Product;
  warehouse: string;
  invoices: Invoice[];
  transfers?: TrackedWarehouseTransfer[];
  openingQty: number;
  openingValueIrr: number;
  defaultCostingMethod?: InventoryCostingMethod;
}): WarehouseKardexReconciliation {
  const {
    product,
    warehouse,
    invoices,
    transfers = [],
    openingQty,
    openingValueIrr,
    defaultCostingMethod = 'moving_average',
  } = params;
  if (!Number.isFinite(openingQty) || openingQty < 0) {
    throw new Error('موجودی افتتاحیه کاردکس باید عددی معتبر و غیرمنفی باشد.');
  }
  if (!Number.isSafeInteger(openingValueIrr) || openingValueIrr < 0) {
    throw new Error('ارزش افتتاحیه کاردکس باید مبلغ صحیح و غیرمنفی باشد.');
  }

  const rows = computeWarehouseProductKardex({ product, warehouse, invoices, transfers });
  const movementQty = rows.reduce((sum, row) => sum + row.inQty - row.outQty, 0);
  const movementValueIrr = rows.reduce(
    (sum, row) => addIrr(sum, row.inQty > 0 ? row.valueIrr : -row.valueIrr),
    0
  );
  const kardexQty = roundQtyFixed(openingQty + movementQty, 4);
  const kardexValueIrr = addIrr(openingValueIrr, movementValueIrr);

  const state = normalizeProductCostState(product, defaultCostingMethod);
  const physicalLayers = state.layers.filter((layer) => {
    const layerWarehouse = layer.warehouse || product.warehouse || 'انبار مرکزی';
    return layerWarehouse === warehouse && !layerWarehouse.startsWith('در راه → ');
  });
  const physicalQty = roundQtyFixed(
    physicalLayers.length > 0
      ? physicalLayers.reduce((sum, layer) => sum + layer.remainingQty, 0)
      : state.layers.length === 0 && product.warehouse === warehouse
        ? product.stock
        : 0,
    4
  );
  const physicalValueIrr = physicalLayers.length > 0
    ? sumIrr(physicalLayers.map((layer) => layer.totalCostIrr))
    : state.layers.length === 0 && product.warehouse === warehouse
      ? toExactIrr(product.inventoryValueIrr ?? mulQtyByIrr(product.stock, product.buyPrice))
      : 0;

  const quantityDifference = roundQtyFixed(kardexQty - physicalQty, 4);
  const valueDifferenceIrr = subIrr(kardexValueIrr, physicalValueIrr);
  const isQuantityBalanced = Math.abs(quantityDifference) < 0.0001;
  const isValueBalanced = Math.abs(valueDifferenceIrr) <= 1;

  return {
    warehouse,
    productId: product.id,
    openingQty: roundQtyFixed(openingQty, 4),
    openingValueIrr: toExactIrr(openingValueIrr),
    kardexQty,
    kardexValueIrr,
    physicalQty,
    physicalValueIrr,
    quantityDifference,
    valueDifferenceIrr,
    isQuantityBalanced,
    isValueBalanced,
    isBalanced: isQuantityBalanced && isValueBalanced,
  };
}

/**
 * Evaluates physical stocktake count vs book stock for shortage/surplus control.
 */
export function evaluateWarehouseShortageSurplus(params: {
  product: Product;
  warehouse: string;
  countedQty: number;
  defaultCostingMethod?: InventoryCostingMethod;
}): ShortageSurplusCheck {
  const { product, warehouse, countedQty, defaultCostingMethod = 'moving_average' } = params;
  const state = normalizeProductCostState(product, defaultCostingMethod);
  const whLayers = state.layers.filter((l) => (l.warehouse || product.warehouse) === warehouse);
  const bookQty = roundQtyFixed(
    whLayers.length > 0
      ? whLayers.reduce((s, l) => s + l.remainingQty, 0)
      : product.warehouse === warehouse
        ? product.stock
        : 0,
    2
  );
  const cleanCounted = roundQtyFixed(Math.max(0, countedQty), 2);
  const varianceQty = roundQtyFixed(cleanCounted - bookQty, 2);
  const unitCostIrr = state.weightedAvgUnitCostIrr || toExactIrr(product.buyPrice);
  const varianceValueIrr = mulQtyByIrr(varianceQty, unitCostIrr);

  return {
    productId: product.id,
    sku: product.sku,
    productName: product.name,
    warehouse,
    bookQty,
    countedQty: cleanCounted,
    varianceQty,
    unitCostIrr,
    varianceValueIrr,
    kind: Math.abs(varianceQty) < 0.005 ? 'exact' : varianceQty > 0 ? 'surplus' : 'shortage',
  };
}
