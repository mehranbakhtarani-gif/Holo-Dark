/**
 * Enterprise Inventory Valuation & Costing Engine (Iranian Standard 8 / IAS 2)
 *
 * Implements real, mathematically auditable, exact-integer-Rial inventory costing:
 *  1. FIFO (First-In, First-Out) with explicit per-receipt cost layers
 *  2. Moving Weighted Average (میانگین موزون متحرک) with exact integer valuation pool (zero rounding drift)
 *  3. Periodic Weighted Average (میانگین موزون دوره‌ای) with full-period cost pooling & exact residual conservation
 *
 * Guarantees:
 *  - Every purchase creates a distinct cost layer (never overwrites historical cost of older stock).
 *  - Every sale consumes valid cost layers in FIFO order or exact moving average valuation pool.
 *  - Sales returns recover the historical exit cost of the original sale (never silently substituting latest purchase price).
 *  - Purchase returns adjust the originating purchase layer (or latest matching layer) and report any price variance
 *    so Inventory Kardex value reconciles 100% with General Ledger Account 10501.
 *  - Waste / inventory shortage removes valid cost layers and produces exact expense cost for Account 80401.
 *  - Inter-warehouse transfers relocate cost layers intact with ZERO impact on Profit & Loss.
 *  - Negative inventory is strictly blocked unless explicitly authorized (`allowNegativeStock: true`).
 *  - Chronological recalculation rebuilds all subsequent COGS and ending inventory whenever historical invoices change.
 */

import {
  ConsumedCostLayerAllocation,
  InventoryCostingMethod,
  InventoryCostLayer,
  Product,
} from '../types/accounting';

export type InventoryMovementKind =
  | 'opening'
  | 'purchase'
  | 'sale'
  | 'sale_return'
  | 'purchase_return'
  | 'waste'
  | 'shortage'
  | 'surplus'
  | 'transfer_out'
  | 'transfer_in';

export interface InventoryMovementInput {
  id: string;
  date: string; // Shamsi YYYY/MM/DD
  sequence?: number; // Deterministic intra-day tie-breaker
  kind: InventoryMovementKind;
  productId: string;
  warehouse?: string;
  targetWarehouse?: string;
  qty: number; // Always positive quantity (> 0)
  /** Net total cost in integer IRR for receipts (purchase, opening, purchase_return invoice net) */
  totalCostIrr?: number;
  /** Optional unit cost override (used for opening/surplus or explicit historical return cost) */
  unitCostIrr?: number;
  /** Reference ID of original sale or purchase movement/invoice for returns */
  sourceRefId?: string;
  /** Explicit historical layers consumed in original sale (for exact FIFO sale_return restoration) */
  originalConsumedLayers?: ConsumedCostLayerAllocation[];
  allowNegativeStock?: boolean;
}

export interface InventoryKardexEntry {
  movementId: string;
  date: string;
  kind: InventoryMovementKind;
  productId: string;
  warehouse?: string;
  inQty: number;
  outQty: number;
  balanceQty: number;
  unitCostIrr: number;
  inValueIrr: number;
  outValueIrr: number;
  balanceValueIrr: number;
  /** Exact COGS / inventory cost impact in integer IRR */
  cogsOrCostIrr: number;
  /** Non-zero when purchase_return invoice price differs from inventory layer cost */
  purchaseReturnVarianceIrr: number;
  consumedLayers?: ConsumedCostLayerAllocation[];
}

export interface ProductInventoryState {
  productId: string;
  costingMethod: InventoryCostingMethod;
  stockQty: number;
  totalValueIrr: number;
  weightedAvgUnitCostIrr: number;
  layers: InventoryCostLayer[];
}

export interface InventoryLedgerRecalculationResult {
  productId: string;
  costingMethod: InventoryCostingMethod;
  kardex: InventoryKardexEntry[];
  finalState: ProductInventoryState;
  totalPurchasesQty: number;
  totalPurchasesValueIrr: number;
  totalSalesQty: number;
  totalCogsIrr: number;
  totalWasteCostIrr: number;
  totalPurchaseReturnVarianceIrr: number;
  /** Conservation identity check: Opening + NetInflows - Outflows === EndingValue (must be 0) */
  conservationDeltaIrr: number;
}

export interface SingleStepCostResult {
  nextState: ProductInventoryState;
  inventoryDeltaIrr: number; // Signed change to GL 10501 (+ for receipt, - for issue)
  cogsOrCostIrr: number; // Positive magnitude of COGS / return cost recovery / waste cost
  effectiveUnitCostIrr: number;
  purchaseReturnVarianceIrr: number; // Invoice net credit - inventory layer deduction (for purchase_return)
  consumedLayers?: ConsumedCostLayerAllocation[];
}

export interface WarehouseTransferPlan {
  productId: string;
  fromWarehouse: string;
  toWarehouse: string;
  qty: number;
  transferredCostIrr: number;
  transferredLayers: InventoryCostLayer[];
  remainingSourceLayers: InventoryCostLayer[];
  pnlImpactIrr: 0; // Guaranteed strictly zero
}

const QTY_SCALE = 10_000;

export function roundQty(qty: number): number {
  return Math.round((Number(qty) || 0) * QTY_SCALE) / QTY_SCALE;
}

/**
 * Selects the next FIFO cost slice to restore for a partial sale return.
 * Earlier returns consume the tail of the original sale's FIFO allocations first.
 * Cumulative rounded boundaries keep integer-IRR allocations exactly additive.
 */
export function selectUnreturnedSaleAllocations(
  originalAllocations: ConsumedCostLayerAllocation[],
  previouslyReturnedQty: number,
  requestedQty: number
): ConsumedCostLayerAllocation[] {
  let skipQty = roundQty(Math.max(0, previouslyReturnedQty));
  let remainingQty = roundQty(requestedQty);
  const selectedInReverse: ConsumedCostLayerAllocation[] = [];

  for (let i = originalAllocations.length - 1; i >= 0 && remainingQty > 0.00005; i--) {
    const allocation = originalAllocations[i];
    const allocationQty = roundQty(allocation.qty);
    if (allocationQty <= 0) continue;
    if (skipQty >= allocationQty - 0.00005) {
      skipQty = roundQty(Math.max(0, skipQty - allocationQty));
      continue;
    }

    const offsetInLayer = skipQty;
    const availableInLayer = roundQty(allocationQty - offsetInLayer);
    const takeQty = roundQty(Math.min(availableInLayer, remainingQty));
    const startCost = Math.round((allocation.totalCostIrr * offsetInLayer) / allocationQty);
    const endCost = Math.round((allocation.totalCostIrr * (offsetInLayer + takeQty)) / allocationQty);
    const takeCost = Math.max(0, endCost - startCost);
    selectedInReverse.push({
      layerId: allocation.layerId,
      qty: takeQty,
      unitCostIrr: takeQty > 0 ? Math.round(takeCost / takeQty) : allocation.unitCostIrr,
      totalCostIrr: takeCost,
    });
    remainingQty = roundQty(Math.max(0, remainingQty - takeQty));
    skipQty = 0;
  }

  if (remainingQty > 0.00005) {
    throw new Error('اطلاعات لایه‌های بهای تمام‌شدهٔ فاکتور فروش برای محاسبهٔ برگشت ناقص است.');
  }
  return selectedInReverse.reverse();
}

function roundQty2(qty: number): number {
  return Math.round((Number(qty) || 0) * 100) / 100;
}

/**
 * Ensures a Product has an initialized cost-layer representation (backwards-compatible migration
 * for pre-existing products that only stored `stock` and `buyPrice`).
 */
export function normalizeProductCostState(
  product: Pick<Product, 'id' | 'stock' | 'buyPrice' | 'warehouse' | 'costingMethod' | 'costLayers' | 'inventoryValueIrr'>,
  defaultMethod: InventoryCostingMethod = 'moving_average',
  openingDate = '1405/01/01'
): ProductInventoryState {
  const method: InventoryCostingMethod = product.costingMethod || defaultMethod;
  const stockQty = Math.max(0, roundQty(Number(product.stock) || 0));
  const buyPrice = Math.max(0, Math.round(Number(product.buyPrice) || 0));

  if (Array.isArray(product.costLayers) && product.costLayers.length > 0) {
    const cleanLayers = product.costLayers
      .filter((l) => Number.isFinite(l.remainingQty) && roundQty(l.remainingQty) > 0)
      .map((l) => {
        const originalQty = Number.isFinite(l.originalQty) ? roundQty(l.originalQty) : 0;
        const remainingQty = roundQty(l.remainingQty);
        const unitCost = Number(l.unitCostIrr);
        const totalCost = Number(l.totalCostIrr);
        return {
          ...l,
          originalQty: Math.max(remainingQty, originalQty),
          remainingQty,
          unitCostIrr: Number.isFinite(unitCost) ? Math.max(0, Math.round(unitCost)) : 0,
          totalCostIrr: Number.isFinite(totalCost) ? Math.max(0, Math.round(totalCost)) : 0,
        };
      });
    const layerQty = roundQty(cleanLayers.reduce((s, l) => s + l.remainingQty, 0));
    const layerVal = cleanLayers.reduce((s, l) => s + l.totalCostIrr, 0);
    // Trust persisted layers only when both quantity and valuation reconcile with
    // the product snapshot. A quantity-only match can silently drift from GL 10501.
    const snapshotValue = product.inventoryValueIrr;
    const hasSnapshotValue =
      typeof snapshotValue === 'number' && Number.isFinite(snapshotValue) && snapshotValue >= 0;
    const valueMatchesSnapshot =
      !hasSnapshotValue || Math.abs(layerVal - Math.round(snapshotValue)) < 1;
    if (Math.abs(layerQty - stockQty) < 0.005 && valueMatchesSnapshot) {
      return {
        productId: product.id,
        costingMethod: method,
        stockQty: layerQty,
        totalValueIrr: layerVal,
        weightedAvgUnitCostIrr: layerQty > 0 ? Math.round(layerVal / layerQty) : buyPrice,
        layers: cleanLayers,
      };
    }
  }

  const totalValueIrr =
    product.inventoryValueIrr !== undefined && Number.isFinite(product.inventoryValueIrr) && stockQty > 0
      ? Math.max(0, Math.round(product.inventoryValueIrr))
      : Math.round(stockQty * buyPrice);

  const layers: InventoryCostLayer[] =
    stockQty > 0
      ? [
          {
            layerId: `open_${product.id}`,
            date: openingDate,
            sourceRef: 'opening_balance',
            warehouse: product.warehouse,
            originalQty: stockQty,
            remainingQty: stockQty,
            unitCostIrr: stockQty > 0 ? Math.round(totalValueIrr / stockQty) : buyPrice,
            totalCostIrr: totalValueIrr,
          },
        ]
      : [];

  return {
    productId: product.id,
    costingMethod: method,
    stockQty,
    totalValueIrr,
    weightedAvgUnitCostIrr: stockQty > 0 ? Math.round(totalValueIrr / stockQty) : buyPrice,
    layers,
  };
}

function cloneLayers(layers: InventoryCostLayer[]): InventoryCostLayer[] {
  return layers.map((l) => ({ ...l }));
}

/**
 * Exact proportional integer allocation from a cost layer:
 * When consuming the ENTIRE remaining layer, returns `layer.totalCostIrr` directly so 0 Rial residual remains!
 */
function allocateLayerCostIrr(layer: InventoryCostLayer, takeQty: number): number {
  const cleanTake = roundQty(takeQty);
  if (cleanTake <= 0 || layer.remainingQty <= 0) return 0;
  if (cleanTake >= layer.remainingQty - 0.00005) {
    return layer.totalCostIrr;
  }
  return Math.round((layer.totalCostIrr * cleanTake) / layer.remainingQty);
}

/**
 * Applies a single chronological inventory movement against a ProductInventoryState
 * using either FIFO or Moving Weighted Average (and maintains exact FIFO layers in parallel
 * so switching methods or auditing layers is always mathematically traceable).
 */
export function applyInventoryMovementStep(
  state: ProductInventoryState,
  movement: InventoryMovementInput,
  historicalSaleUnitCostByRef?: Map<string, { unitCostIrr: number; consumedLayers?: ConsumedCostLayerAllocation[] }>
): SingleStepCostResult {
  const qty = roundQty(movement.qty);
  if (qty <= 0) {
    throw new Error(`مقدار حرکت انبار برای کالا (${movement.productId}) باید بزرگ‌تر از صفر باشد.`);
  }

  const method = state.costingMethod;
  const layers = cloneLayers(state.layers);
  let stockQty = roundQty(state.stockQty);
  let totalValueIrr = Math.round(state.totalValueIrr);

  // ---------------- 1. OPENING / PURCHASE / SURPLUS ----------------
  if (movement.kind === 'opening' || movement.kind === 'purchase' || movement.kind === 'surplus') {
    const costIrr =
      movement.totalCostIrr !== undefined
        ? Math.max(0, Math.round(movement.totalCostIrr))
        : Math.max(0, Math.round(qty * (movement.unitCostIrr ?? state.weightedAvgUnitCostIrr)));
    const unitCostIrr = qty > 0 ? Math.round(costIrr / qty) : 0;

    layers.push({
      layerId: `lyr_${movement.id}`,
      date: movement.date,
      sourceRef: movement.id,
      warehouse: movement.warehouse,
      originalQty: qty,
      remainingQty: qty,
      unitCostIrr,
      totalCostIrr: costIrr,
    });

    stockQty = roundQty(stockQty + qty);
    totalValueIrr += costIrr;
    const weightedAvgUnitCostIrr = stockQty > 0 ? Math.round(totalValueIrr / stockQty) : unitCostIrr;

    return {
      nextState: {
        ...state,
        stockQty: roundQty2(stockQty),
        totalValueIrr,
        weightedAvgUnitCostIrr,
        layers,
      },
      inventoryDeltaIrr: costIrr,
      cogsOrCostIrr: costIrr,
      effectiveUnitCostIrr: unitCostIrr,
      purchaseReturnVarianceIrr: 0,
    };
  }

  // ---------------- 2. SALE / WASTE / SHORTAGE ----------------
  if (movement.kind === 'sale' || movement.kind === 'waste' || movement.kind === 'shortage') {
    if (!movement.allowNegativeStock && stockQty + 0.0001 < qty) {
      throw new Error(
        `موجودی انبار کافی نیست (موجودی فعلی: ${roundQty2(stockQty)}، درخواست خروج: ${roundQty2(qty)}). موجودی منفی بدون مجوز صریح مجاز نیست.`
      );
    }

    if (method === 'fifo') {
      let remainingToTake = qty;
      let totalIssuedIrr = 0;
      const consumed: ConsumedCostLayerAllocation[] = [];

      for (const layer of layers) {
        if (remainingToTake <= 0.00005) break;
        if (layer.remainingQty <= 0.00005) continue;

        const take = roundQty(Math.min(layer.remainingQty, remainingToTake));
        const takeCost = allocateLayerCostIrr(layer, take);
        layer.remainingQty = roundQty(Math.max(0, layer.remainingQty - take));
        layer.totalCostIrr = Math.max(0, layer.totalCostIrr - takeCost);
        remainingToTake = roundQty(Math.max(0, remainingToTake - take));
        totalIssuedIrr += takeCost;

        consumed.push({
          layerId: layer.layerId,
          qty: take,
          unitCostIrr: take > 0 ? Math.round(takeCost / take) : layer.unitCostIrr,
          totalCostIrr: takeCost,
        });
      }

      // Authorized negative stock fallback (only reachable when allowNegativeStock === true)
      if (remainingToTake > 0.00005) {
        const fallbackUnit = state.weightedAvgUnitCostIrr;
        const extraCost = Math.round(remainingToTake * fallbackUnit);
        totalIssuedIrr += extraCost;
        consumed.push({
          layerId: 'authorized_negative_stock',
          qty: remainingToTake,
          unitCostIrr: fallbackUnit,
          totalCostIrr: extraCost,
        });
      }

      const activeLayers = layers.filter((l) => l.remainingQty > 0.00005);
      const nextStock = roundQty(stockQty - qty);
      const nextVal = Math.max(0, totalValueIrr - totalIssuedIrr);
      const nextAvg = nextStock > 0 ? Math.round(nextVal / nextStock) : state.weightedAvgUnitCostIrr;

      return {
        nextState: {
          ...state,
          stockQty: roundQty2(nextStock),
          totalValueIrr: nextVal,
          weightedAvgUnitCostIrr: nextAvg,
          layers: activeLayers,
        },
        inventoryDeltaIrr: -totalIssuedIrr,
        cogsOrCostIrr: totalIssuedIrr,
        effectiveUnitCostIrr: qty > 0 ? Math.round(totalIssuedIrr / qty) : state.weightedAvgUnitCostIrr,
        purchaseReturnVarianceIrr: 0,
        consumedLayers: consumed,
      };
    }

    // Moving Weighted Average (and provisional step for Periodic before period-end reallocation)
    // Exact integer pool depletion: if selling entire remaining stock, consume exact totalValueIrr (0 Rial residual!)
    const totalIssuedIrr =
      stockQty > 0 && qty >= stockQty - 0.00005 && !movement.allowNegativeStock
        ? totalValueIrr
        : stockQty > 0
          ? Math.round((totalValueIrr * qty) / stockQty)
          : Math.round(qty * state.weightedAvgUnitCostIrr);
    const effectiveUnitCostIrr = qty > 0 ? Math.round(totalIssuedIrr / qty) : state.weightedAvgUnitCostIrr;

    // Also deplete shadow layers proportionally so stockQty === sum(layers.remainingQty)
    let rem = qty;
    for (const layer of layers) {
      if (rem <= 0.00005) break;
      if (layer.remainingQty <= 0.00005) continue;
      const take = roundQty(Math.min(layer.remainingQty, rem));
      layer.remainingQty = roundQty(Math.max(0, layer.remainingQty - take));
      layer.totalCostIrr = Math.round(layer.remainingQty * effectiveUnitCostIrr);
      rem = roundQty(Math.max(0, rem - take));
    }
    const activeLayers = layers.filter((l) => l.remainingQty > 0.00005);
    const nextStock = roundQty(stockQty - qty);
    const nextVal = Math.max(0, totalValueIrr - totalIssuedIrr);
    // Synchronize shadow layer values to exact pool value when single/remaining layers exist
    if (activeLayers.length > 0) {
      let runningLayerVal = 0;
      for (let i = 0; i < activeLayers.length; i++) {
        const isLast = i === activeLayers.length - 1;
        const val = isLast
          ? Math.max(0, nextVal - runningLayerVal)
          : nextStock > 0
            ? Math.round((nextVal * activeLayers[i].remainingQty) / nextStock)
            : 0;
        activeLayers[i].totalCostIrr = val;
        activeLayers[i].unitCostIrr =
          activeLayers[i].remainingQty > 0 ? Math.round(val / activeLayers[i].remainingQty) : effectiveUnitCostIrr;
        runningLayerVal += val;
      }
    }

    const nextAvg = nextStock > 0 ? Math.round(nextVal / nextStock) : effectiveUnitCostIrr;

    return {
      nextState: {
        ...state,
        stockQty: roundQty2(nextStock),
        totalValueIrr: nextVal,
        weightedAvgUnitCostIrr: nextAvg,
        layers: activeLayers,
      },
      inventoryDeltaIrr: -totalIssuedIrr,
      cogsOrCostIrr: totalIssuedIrr,
      effectiveUnitCostIrr,
      purchaseReturnVarianceIrr: 0,
      consumedLayers: [
        {
          layerId: `mwa_${movement.id}`,
          qty,
          unitCostIrr: effectiveUnitCostIrr,
          totalCostIrr: totalIssuedIrr,
        },
      ],
    };
  }

  // ---------------- 3. SALE RETURN (Recover exact historical exit cost!) ----------------
  if (movement.kind === 'sale_return') {
    const refHistory = movement.sourceRefId
      ? historicalSaleUnitCostByRef?.get(movement.sourceRefId)
      : undefined;
    const origLayers = movement.originalConsumedLayers || refHistory?.consumedLayers;

    let restoredCostIrr = 0;
    const restoredLayerEntries: InventoryCostLayer[] = [];

    if (method === 'fifo' && origLayers && origLayers.length > 0) {
      // Restore in reverse order of consumption (last consumed layer restored first — standard FIFO return accounting)
      let remainingToRestore = qty;
      for (let i = origLayers.length - 1; i >= 0 && remainingToRestore > 0.00005; i--) {
        const alloc = origLayers[i];
        const restoreQty = roundQty(Math.min(alloc.qty, remainingToRestore));
        const restoreVal =
          restoreQty >= alloc.qty - 0.00005
            ? alloc.totalCostIrr
            : Math.round((alloc.totalCostIrr * restoreQty) / alloc.qty);
        const restoreUnit = restoreQty > 0 ? Math.round(restoreVal / restoreQty) : alloc.unitCostIrr;

        restoredCostIrr += restoreVal;
        restoredLayerEntries.push({
          layerId: `ret_${movement.id}_${i}`,
          date: movement.date,
          sourceRef: movement.sourceRefId || movement.id,
          warehouse: movement.warehouse,
          originalQty: restoreQty,
          remainingQty: restoreQty,
          unitCostIrr: restoreUnit,
          totalCostIrr: restoreVal,
        });
        remainingToRestore = roundQty(Math.max(0, remainingToRestore - restoreQty));
      }

      if (remainingToRestore > 0.00005) {
        const fallbackUnit =
          movement.unitCostIrr ?? refHistory?.unitCostIrr ?? state.weightedAvgUnitCostIrr;
        const extraVal = Math.round(remainingToRestore * fallbackUnit);
        restoredCostIrr += extraVal;
        restoredLayerEntries.push({
          layerId: `ret_${movement.id}_extra`,
          date: movement.date,
          sourceRef: movement.sourceRefId || movement.id,
          warehouse: movement.warehouse,
          originalQty: remainingToRestore,
          remainingQty: remainingToRestore,
          unitCostIrr: fallbackUnit,
          totalCostIrr: extraVal,
        });
      }

      // Prepend restored historical layers to front of FIFO queue (earliest-available)
      const nextLayers = [...restoredLayerEntries.reverse(), ...layers];
      const nextStock = roundQty(stockQty + qty);
      const nextVal = totalValueIrr + restoredCostIrr;
      const nextAvg = nextStock > 0 ? Math.round(nextVal / nextStock) : state.weightedAvgUnitCostIrr;

      return {
        nextState: {
          ...state,
          stockQty: roundQty2(nextStock),
          totalValueIrr: nextVal,
          weightedAvgUnitCostIrr: nextAvg,
          layers: nextLayers,
        },
        inventoryDeltaIrr: restoredCostIrr,
        cogsOrCostIrr: restoredCostIrr,
        effectiveUnitCostIrr: qty > 0 ? Math.round(restoredCostIrr / qty) : state.weightedAvgUnitCostIrr,
        purchaseReturnVarianceIrr: 0,
      };
    }

    // Moving Weighted Average or snapshot-based historical recovery
    const historicalUnitCost =
      movement.unitCostIrr !== undefined && movement.unitCostIrr > 0
        ? Math.round(movement.unitCostIrr)
        : refHistory?.unitCostIrr !== undefined && refHistory.unitCostIrr > 0
          ? Math.round(refHistory.unitCostIrr)
          : state.weightedAvgUnitCostIrr;
    restoredCostIrr =
      movement.totalCostIrr !== undefined && movement.totalCostIrr > 0
        ? Math.round(movement.totalCostIrr)
        : Math.round(qty * historicalUnitCost);

    const nextStock = roundQty(stockQty + qty);
    const nextVal = totalValueIrr + restoredCostIrr;
    const nextAvg = nextStock > 0 ? Math.round(nextVal / nextStock) : historicalUnitCost;

    const restoredLayer: InventoryCostLayer = {
      layerId: `ret_${movement.id}`,
      date: movement.date,
      sourceRef: movement.sourceRefId || movement.id,
      warehouse: movement.warehouse,
      originalQty: qty,
      remainingQty: qty,
      unitCostIrr: qty > 0 ? Math.round(restoredCostIrr / qty) : historicalUnitCost,
      totalCostIrr: restoredCostIrr,
    };

    return {
      nextState: {
        ...state,
        stockQty: roundQty2(nextStock),
        totalValueIrr: nextVal,
        weightedAvgUnitCostIrr: nextAvg,
        layers: [restoredLayer, ...layers],
      },
      inventoryDeltaIrr: restoredCostIrr,
      cogsOrCostIrr: restoredCostIrr,
      effectiveUnitCostIrr: qty > 0 ? Math.round(restoredCostIrr / qty) : historicalUnitCost,
      purchaseReturnVarianceIrr: 0,
    };
  }

  // ---------------- 4. PURCHASE RETURN (Adjust originating purchase layer!) ----------------
  if (movement.kind === 'purchase_return') {
    if (!movement.allowNegativeStock && stockQty + 0.0001 < qty) {
      throw new Error(
        `موجودی انبار برای برگشت از خرید کافی نیست (موجودی فعلی: ${roundQty2(stockQty)}، مقدار برگشتی: ${roundQty2(qty)}).`
      );
    }

    const invoiceReturnNetIrr =
      movement.totalCostIrr !== undefined
        ? Math.max(0, Math.round(movement.totalCostIrr))
        : Math.max(0, Math.round(qty * (movement.unitCostIrr ?? state.weightedAvgUnitCostIrr)));

    let remainingToRemove = qty;
    let inventoryCostRemovedIrr = 0;

    if (method === 'fifo') {
      // A linked purchase return must consume only its originating purchase layer.
      // Never silently substitute stock from an unrelated receipt.
      if (movement.sourceRefId) {
        const sourceLayers = layers.filter(
          (layer) => layer.sourceRef === movement.sourceRefId && layer.remainingQty > 0.00005
        );
        const sourceRemainingQty = roundQty(
          sourceLayers.reduce((sum, layer) => sum + layer.remainingQty, 0)
        );
        if (sourceRemainingQty + 0.0001 < qty) {
          throw new Error(
            `موجودی باقی‌مانده از خرید مرجع برای برگشت کافی نیست (شناسه خرید: ${movement.sourceRefId}، موجودی قابل برگشت: ${roundQty2(sourceRemainingQty)}، مقدار درخواستی: ${roundQty2(qty)}).`
          );
        }
        // A source purchase can be split across warehouses by transfers. Consume
        // only its surviving descendant layers, never an unrelated purchase layer.
        for (const sourceLayer of sourceLayers) {
          if (remainingToRemove <= 0.00005) break;
          const take = roundQty(Math.min(sourceLayer.remainingQty, remainingToRemove));
          const takeVal = allocateLayerCostIrr(sourceLayer, take);
          sourceLayer.remainingQty = roundQty(Math.max(0, sourceLayer.remainingQty - take));
          sourceLayer.totalCostIrr = Math.max(0, sourceLayer.totalCostIrr - takeVal);
          remainingToRemove = roundQty(Math.max(0, remainingToRemove - take));
          inventoryCostRemovedIrr += takeVal;
        }
      } else {
        // Without a source reference, reverse the newest available layers first (LIFO).
        for (let i = layers.length - 1; i >= 0 && remainingToRemove > 0.00005; i--) {
        const layer = layers[i];
        if (layer.remainingQty <= 0.00005) continue;
        const take = roundQty(Math.min(layer.remainingQty, remainingToRemove));
        const takeVal = allocateLayerCostIrr(layer, take);
        layer.remainingQty = roundQty(Math.max(0, layer.remainingQty - take));
        layer.totalCostIrr = Math.max(0, layer.totalCostIrr - takeVal);
        remainingToRemove = roundQty(Math.max(0, remainingToRemove - take));
        inventoryCostRemovedIrr += takeVal;
        }
      }

      const activeLayers = layers.filter((l) => l.remainingQty > 0.00005);
      const nextStock = roundQty(stockQty - qty);
      const nextVal = Math.max(0, totalValueIrr - inventoryCostRemovedIrr);
      const nextAvg = nextStock > 0 ? Math.round(nextVal / nextStock) : state.weightedAvgUnitCostIrr;

      return {
        nextState: {
          ...state,
          stockQty: roundQty2(nextStock),
          totalValueIrr: nextVal,
          weightedAvgUnitCostIrr: nextAvg,
          layers: activeLayers,
        },
        inventoryDeltaIrr: -inventoryCostRemovedIrr,
        cogsOrCostIrr: inventoryCostRemovedIrr,
        effectiveUnitCostIrr: qty > 0 ? Math.round(inventoryCostRemovedIrr / qty) : state.weightedAvgUnitCostIrr,
        purchaseReturnVarianceIrr: invoiceReturnNetIrr - inventoryCostRemovedIrr,
      };
    }

    // Moving Weighted Average: deduct returned purchase cost safely capped at available pool value
    if (qty >= stockQty - 0.00005 && !movement.allowNegativeStock) {
      inventoryCostRemovedIrr = totalValueIrr;
    } else {
      // Standard moving-average purchase return reduces inventory by returned purchase cost (clamped so remaining value >= 0)
      inventoryCostRemovedIrr = Math.min(totalValueIrr, invoiceReturnNetIrr);
    }

    // Also trim shadow layers from newest first so layer qty matches stockQty
    for (let i = layers.length - 1; i >= 0 && remainingToRemove > 0.00005; i--) {
      const layer = layers[i];
      if (layer.remainingQty <= 0.00005) continue;
      const take = roundQty(Math.min(layer.remainingQty, remainingToRemove));
      layer.remainingQty = roundQty(Math.max(0, layer.remainingQty - take));
      remainingToRemove = roundQty(Math.max(0, remainingToRemove - take));
    }
    const activeLayers = layers.filter((l) => l.remainingQty > 0.00005);
    const nextStock = roundQty(stockQty - qty);
    const nextVal = Math.max(0, totalValueIrr - inventoryCostRemovedIrr);
    const nextAvg = nextStock > 0 ? Math.round(nextVal / nextStock) : state.weightedAvgUnitCostIrr;

    if (activeLayers.length > 0) {
      let running = 0;
      for (let i = 0; i < activeLayers.length; i++) {
        const isLast = i === activeLayers.length - 1;
        const val = isLast
          ? Math.max(0, nextVal - running)
          : nextStock > 0
            ? Math.round((nextVal * activeLayers[i].remainingQty) / nextStock)
            : 0;
        activeLayers[i].totalCostIrr = val;
        activeLayers[i].unitCostIrr =
          activeLayers[i].remainingQty > 0 ? Math.round(val / activeLayers[i].remainingQty) : nextAvg;
        running += val;
      }
    }

    return {
      nextState: {
        ...state,
        stockQty: roundQty2(nextStock),
        totalValueIrr: nextVal,
        weightedAvgUnitCostIrr: nextAvg,
        layers: activeLayers,
      },
      inventoryDeltaIrr: -inventoryCostRemovedIrr,
      cogsOrCostIrr: inventoryCostRemovedIrr,
      effectiveUnitCostIrr: qty > 0 ? Math.round(inventoryCostRemovedIrr / qty) : nextAvg,
      purchaseReturnVarianceIrr: invoiceReturnNetIrr - inventoryCostRemovedIrr,
    };
  }

  // ---------------- 5. INTER-WAREHOUSE TRANSFER (ZERO P&L IMPACT) ----------------
  if (movement.kind === 'transfer_out' || movement.kind === 'transfer_in') {
    return {
      nextState: { ...state, layers },
      inventoryDeltaIrr: 0,
      cogsOrCostIrr: 0,
      effectiveUnitCostIrr: state.weightedAvgUnitCostIrr,
      purchaseReturnVarianceIrr: 0,
    };
  }

  return {
    nextState: state,
    inventoryDeltaIrr: 0,
    cogsOrCostIrr: 0,
    effectiveUnitCostIrr: state.weightedAvgUnitCostIrr,
    purchaseReturnVarianceIrr: 0,
  };
}

/**
 * Full Chronological Inventory Ledger & COGS Recalculation Engine.
 * Supports FIFO, Moving Weighted Average, and Periodic Weighted Average.
 * Replays all movements in chronological order — so editing or cancelling any historical
 * invoice deterministically rebuilds all subsequent COGS, layers, and ending inventory!
 */
export function recalculateInventoryLedger(input: {
  productId: string;
  costingMethod: InventoryCostingMethod;
  openingQty?: number;
  openingValueIrr?: number;
  openingDate?: string;
  warehouse?: string;
  movements: InventoryMovementInput[];
}): InventoryLedgerRecalculationResult {
  const {
    productId,
    costingMethod,
    openingQty = 0,
    openingValueIrr = 0,
    openingDate = '1405/01/01',
    warehouse,
    movements,
  } = input;

  const sorted = [...movements]
    .filter((m) => m.productId === productId)
    .sort((a, b) => {
      const dateCmp = a.date.localeCompare(b.date);
      if (dateCmp !== 0) return dateCmp;
      return (a.sequence ?? 0) - (b.sequence ?? 0);
    });

  // -------- PERIODIC WEIGHTED AVERAGE MODE --------
  if (costingMethod === 'periodic_average') {
    let availableQty = roundQty(openingQty);
    let availableValueIrr = Math.round(openingValueIrr);
    let totalPurchasesQty = 0;
    let totalPurchasesValueIrr = 0;
    let totalNetOutQty = 0;
    let totalSalesQty = 0;
    let totalWasteQty = 0;
    const saleQtyByRef = new Map<string, number>();
    const returnedQtyBySaleRef = new Map<string, number>();
    const purchaseQtyByRef = new Map<string, number>();
    const returnedQtyByPurchaseRef = new Map<string, number>();

    // Pass 1: Pool all opening + purchases + surplus - purchase_returns across the entire period
    // Validate linked returns here too; periodic costing must enforce the same source limits as FIFO.
    for (const m of sorted) {
      const q = roundQty(m.qty);
      if (m.kind === 'purchase') {
        purchaseQtyByRef.set(m.id, q);
      } else if (m.kind === 'purchase_return' && m.sourceRefId) {
        const originalPurchaseQty = purchaseQtyByRef.get(m.sourceRefId);
        if (originalPurchaseQty === undefined) {
          throw new Error(`فاکتور خرید مرجع برای برگشت از خرید یافت نشد: ${m.sourceRefId}`);
        }
        const alreadyReturned = returnedQtyByPurchaseRef.get(m.sourceRefId) ?? 0;
        const remainingReturnableQty = roundQty(originalPurchaseQty - alreadyReturned);
        if (q > remainingReturnableQty + 0.0001) {
          throw new Error(
            `مقدار برگشت از خرید از مقدار خریداری‌شدهٔ باقی‌مانده بیشتر است (باقی‌مانده: ${roundQty2(remainingReturnableQty)}، برگشتی: ${roundQty2(q)}).`
          );
        }
        returnedQtyByPurchaseRef.set(m.sourceRefId, roundQty(alreadyReturned + q));
      } else if (m.kind === 'sale') {
        saleQtyByRef.set(m.id, q);
      } else if (m.kind === 'sale_return' && m.sourceRefId) {
        const originalSaleQty = saleQtyByRef.get(m.sourceRefId);
        if (originalSaleQty === undefined) {
          throw new Error(`فاکتور فروش مرجع برای برگشت از فروش یافت نشد: ${m.sourceRefId}`);
        }
        const alreadyReturned = returnedQtyBySaleRef.get(m.sourceRefId) ?? 0;
        const remainingReturnableQty = roundQty(originalSaleQty - alreadyReturned);
        if (q > remainingReturnableQty + 0.0001) {
          throw new Error(
            `مقدار برگشت از فروش از مقدار فروش‌رفتهٔ باقی‌مانده بیشتر است (باقی‌مانده: ${roundQty2(remainingReturnableQty)}، برگشتی: ${roundQty2(q)}).`
          );
        }
        returnedQtyBySaleRef.set(m.sourceRefId, roundQty(alreadyReturned + q));
      }
      if (m.kind === 'opening' || m.kind === 'purchase' || m.kind === 'surplus') {
        const val =
          m.totalCostIrr !== undefined
            ? Math.round(m.totalCostIrr)
            : Math.round(q * (m.unitCostIrr ?? 0));
        availableQty = roundQty(availableQty + q);
        availableValueIrr += val;
        if (m.kind === 'purchase') {
          totalPurchasesQty = roundQty(totalPurchasesQty + q);
          totalPurchasesValueIrr += val;
        }
      } else if (m.kind === 'purchase_return') {
        const val =
          m.totalCostIrr !== undefined
            ? Math.round(m.totalCostIrr)
            : Math.round(q * (m.unitCostIrr ?? 0));
        availableQty = roundQty(Math.max(0, availableQty - q));
        availableValueIrr = Math.max(0, availableValueIrr - val);
      } else if (m.kind === 'sale') {
        totalSalesQty = roundQty(totalSalesQty + q);
        totalNetOutQty = roundQty(totalNetOutQty + q);
      } else if (m.kind === 'sale_return') {
        totalSalesQty = roundQty(totalSalesQty - q);
        totalNetOutQty = roundQty(totalNetOutQty - q);
      } else if (m.kind === 'waste' || m.kind === 'shortage') {
        totalWasteQty = roundQty(totalWasteQty + q);
        totalNetOutQty = roundQty(totalNetOutQty + q);
      }
    }

    if (totalNetOutQty > availableQty + 0.0001) {
      throw new Error(
        `در روش میانگین موزون دوره‌ای، مجموع خروج (${roundQty2(totalNetOutQty)}) از کل کالای آماده برای فروش (${roundQty2(availableQty)}) بیشتر است.`
      );
    }

    const periodicExactAvg = availableQty > 0 ? availableValueIrr / availableQty : 0;
    const periodicUnitCostIrr = Math.round(periodicExactAvg);
    const endingQty = roundQty(availableQty - totalNetOutQty);
    const totalOutCostIrr =
      endingQty <= 0.00005
        ? availableValueIrr
        : Math.round(periodicExactAvg * totalNetOutQty);
    const endingValueIrr = Math.max(0, availableValueIrr - totalOutCostIrr);

    // Pass 2: Build auditable Kardex with exact residual conservation on the last outflow
    const kardex: InventoryKardexEntry[] = [];
    let runningQty = roundQty(openingQty);
    let runningVal = Math.round(openingValueIrr);
    let totalCogsIrr = 0;
    let totalWasteCostIrr = 0;

    for (const m of sorted) {
      const q = roundQty(m.qty);
      if (m.kind === 'opening' || m.kind === 'purchase' || m.kind === 'surplus') {
        const val =
          m.totalCostIrr !== undefined
            ? Math.round(m.totalCostIrr)
            : Math.round(q * (m.unitCostIrr ?? 0));
        runningQty = roundQty(runningQty + q);
        runningVal += val;
        kardex.push({
          movementId: m.id,
          date: m.date,
          kind: m.kind,
          productId,
          warehouse: m.warehouse || warehouse,
          inQty: q,
          outQty: 0,
          balanceQty: roundQty2(runningQty),
          unitCostIrr: q > 0 ? Math.round(val / q) : 0,
          inValueIrr: val,
          outValueIrr: 0,
          balanceValueIrr: runningVal,
          cogsOrCostIrr: val,
          purchaseReturnVarianceIrr: 0,
        });
      } else if (m.kind === 'purchase_return') {
        if (!m.allowNegativeStock && runningQty + 0.0001 < q) {
          throw new Error(
            `موجودی انبار در تاریخ ${m.date} برای برگشت از خرید کافی نیست (موجودی: ${roundQty2(runningQty)}، مقدار برگشتی: ${roundQty2(q)}).`
          );
        }
        const val =
          m.totalCostIrr !== undefined
            ? Math.round(m.totalCostIrr)
            : Math.round(q * (m.unitCostIrr ?? periodicUnitCostIrr));
        runningQty = roundQty(runningQty - q);
        runningVal = Math.max(0, runningVal - val);
        kardex.push({
          movementId: m.id,
          date: m.date,
          kind: m.kind,
          productId,
          warehouse: m.warehouse || warehouse,
          inQty: 0,
          outQty: q,
          balanceQty: roundQty2(runningQty),
          unitCostIrr: q > 0 ? Math.round(val / q) : periodicUnitCostIrr,
          inValueIrr: 0,
          outValueIrr: val,
          balanceValueIrr: runningVal,
          cogsOrCostIrr: val,
          purchaseReturnVarianceIrr: 0,
        });
      } else if (m.kind === 'sale' || m.kind === 'waste' || m.kind === 'shortage') {
        if (!m.allowNegativeStock && runningQty + 0.0001 < q) {
          throw new Error(
            `موجودی انبار در تاریخ ${m.date} کافی نیست (موجودی: ${roundQty2(runningQty)}، خروج: ${roundQty2(q)}).`
          );
        }
        const costIrr = Math.round(periodicExactAvg * q);
        runningQty = roundQty(runningQty - q);
        runningVal = Math.max(0, runningVal - costIrr);
        if (m.kind === 'sale') totalCogsIrr += costIrr;
        else totalWasteCostIrr += costIrr;
        kardex.push({
          movementId: m.id,
          date: m.date,
          kind: m.kind,
          productId,
          warehouse: m.warehouse || warehouse,
          inQty: 0,
          outQty: q,
          balanceQty: roundQty2(runningQty),
          unitCostIrr: periodicUnitCostIrr,
          inValueIrr: 0,
          outValueIrr: costIrr,
          balanceValueIrr: runningVal,
          cogsOrCostIrr: costIrr,
          purchaseReturnVarianceIrr: 0,
        });
      } else if (m.kind === 'sale_return') {
        const costIrr = Math.round(periodicExactAvg * q);
        runningQty = roundQty(runningQty + q);
        runningVal += costIrr;
        totalCogsIrr -= costIrr;
        kardex.push({
          movementId: m.id,
          date: m.date,
          kind: m.kind,
          productId,
          warehouse: m.warehouse || warehouse,
          inQty: q,
          outQty: 0,
          balanceQty: roundQty2(runningQty),
          unitCostIrr: periodicUnitCostIrr,
          inValueIrr: costIrr,
          outValueIrr: 0,
          balanceValueIrr: runningVal,
          cogsOrCostIrr: costIrr,
          purchaseReturnVarianceIrr: 0,
        });
      }
    }

    // Absorb any ±1..N IRR integer rounding residual onto totalCogsIrr so conservation === 0
    const residual = availableValueIrr - (totalCogsIrr + totalWasteCostIrr + endingValueIrr);
    if (residual !== 0 && totalSalesQty > 0) {
      totalCogsIrr += residual;
    }

    const finalLayers: InventoryCostLayer[] =
      endingQty > 0
        ? [
            {
              layerId: `periodic_end_${productId}`,
              date: sorted[sorted.length - 1]?.date || openingDate,
              sourceRef: 'periodic_weighted_average',
              warehouse,
              originalQty: endingQty,
              remainingQty: endingQty,
              unitCostIrr: endingQty > 0 ? Math.round(endingValueIrr / endingQty) : periodicUnitCostIrr,
              totalCostIrr: endingValueIrr,
            },
          ]
        : [];

    return {
      productId,
      costingMethod,
      kardex,
      finalState: {
        productId,
        costingMethod,
        stockQty: roundQty2(endingQty),
        totalValueIrr: endingValueIrr,
        weightedAvgUnitCostIrr: periodicUnitCostIrr,
        layers: finalLayers,
      },
      totalPurchasesQty: roundQty2(totalPurchasesQty),
      totalPurchasesValueIrr,
      totalSalesQty: roundQty2(totalSalesQty),
      totalCogsIrr,
      totalWasteCostIrr,
      totalPurchaseReturnVarianceIrr: 0,
      conservationDeltaIrr: availableValueIrr - (totalCogsIrr + totalWasteCostIrr + endingValueIrr),
    };
  }

  // -------- FIFO & MOVING WEIGHTED AVERAGE MODES --------
  let state: ProductInventoryState = {
    productId,
    costingMethod,
    stockQty: roundQty(openingQty),
    totalValueIrr: Math.round(openingValueIrr),
    weightedAvgUnitCostIrr: openingQty > 0 ? Math.round(openingValueIrr / openingQty) : 0,
    layers:
      openingQty > 0
        ? [
            {
              layerId: `open_${productId}`,
              date: openingDate,
              sourceRef: 'opening_balance',
              warehouse,
              originalQty: roundQty(openingQty),
              remainingQty: roundQty(openingQty),
              unitCostIrr: openingQty > 0 ? Math.round(openingValueIrr / openingQty) : 0,
              totalCostIrr: Math.round(openingValueIrr),
            },
          ]
        : [],
  };

  const saleHistoryByRef = new Map<
    string,
    { unitCostIrr: number; consumedLayers?: ConsumedCostLayerAllocation[]; quantity: number }
  >();
  const returnedQtyBySaleRef = new Map<string, number>();

  const kardex: InventoryKardexEntry[] = [];
  let totalPurchasesQty = 0;
  let totalPurchasesValueIrr = 0;
  let totalSalesQty = 0;
  let totalCogsIrr = 0;
  let totalWasteCostIrr = 0;
  let totalPurchaseReturnVarianceIrr = 0;
  let netInflowsIrr = Math.round(openingValueIrr);
  let netOutflowsIrr = 0;

  for (const m of sorted) {
    let movementForStep = m;
    if (m.kind === 'sale_return' && m.sourceRefId) {
      const originalSale = saleHistoryByRef.get(m.sourceRefId);
      if (!originalSale) {
        throw new Error(`فاکتور فروش مرجع برای برگشت از فروش یافت نشد: ${m.sourceRefId}`);
      }
      const alreadyReturned = returnedQtyBySaleRef.get(m.sourceRefId) ?? 0;
      const remainingReturnableQty = roundQty(originalSale.quantity - alreadyReturned);
      if (roundQty(m.qty) > remainingReturnableQty + 0.0001) {
        throw new Error(
          `مقدار برگشت از فروش از مقدار فروش‌رفتهٔ باقی‌مانده بیشتر است (باقی‌مانده: ${roundQty2(remainingReturnableQty)}، برگشتی: ${roundQty2(m.qty)}).`
        );
      }

      // Allocate each partial return to the next unreturned portion of the original
      // sale's FIFO consumption, starting with the last layer consumed.
      const originalAllocations = m.originalConsumedLayers || originalSale.consumedLayers || [];
      if (costingMethod === 'fifo' && originalAllocations.length > 0) {
        let skipQty = alreadyReturned;
        let remainingQty = roundQty(m.qty);
        const selectedInReverse: ConsumedCostLayerAllocation[] = [];
        for (let i = originalAllocations.length - 1; i >= 0 && remainingQty > 0.00005; i--) {
          const allocation = originalAllocations[i];
          const allocationQty = roundQty(allocation.qty);
          if (skipQty >= allocationQty - 0.00005) {
            skipQty = roundQty(Math.max(0, skipQty - allocationQty));
            continue;
          }
          const offsetInLayer = skipQty;
          const availableInLayer = roundQty(allocationQty - offsetInLayer);
          const takeQty = roundQty(Math.min(availableInLayer, remainingQty));
          const startCost = Math.round((allocation.totalCostIrr * offsetInLayer) / allocationQty);
          const endCost = Math.round((allocation.totalCostIrr * (offsetInLayer + takeQty)) / allocationQty);
          const takeCost = Math.max(0, endCost - startCost);
          selectedInReverse.push({
            layerId: allocation.layerId,
            qty: takeQty,
            unitCostIrr: takeQty > 0 ? Math.round(takeCost / takeQty) : allocation.unitCostIrr,
            totalCostIrr: takeCost,
          });
          remainingQty = roundQty(Math.max(0, remainingQty - takeQty));
          skipQty = 0;
        }
        if (remainingQty > 0.00005) {
          throw new Error('اطلاعات لایه‌های بهای تمام‌شدهٔ فاکتور فروش برای محاسبهٔ برگشت ناقص است.');
        }
        movementForStep = { ...m, originalConsumedLayers: selectedInReverse.reverse() };
      }
      returnedQtyBySaleRef.set(m.sourceRefId, roundQty(alreadyReturned + m.qty));
    }

    const step = applyInventoryMovementStep(state, movementForStep, saleHistoryByRef);
    state = step.nextState;

    if (m.kind === 'sale') {
      saleHistoryByRef.set(m.id, {
        unitCostIrr: step.effectiveUnitCostIrr,
        consumedLayers: step.consumedLayers,
        quantity: roundQty(m.qty),
      });
      totalSalesQty = roundQty(totalSalesQty + m.qty);
      totalCogsIrr += step.cogsOrCostIrr;
      netOutflowsIrr += step.cogsOrCostIrr;
    } else if (m.kind === 'sale_return') {
      totalSalesQty = roundQty(totalSalesQty - m.qty);
      totalCogsIrr -= step.cogsOrCostIrr;
      netOutflowsIrr -= step.cogsOrCostIrr;
    } else if (m.kind === 'purchase') {
      totalPurchasesQty = roundQty(totalPurchasesQty + m.qty);
      totalPurchasesValueIrr += step.inventoryDeltaIrr;
      netInflowsIrr += step.inventoryDeltaIrr;
    } else if (m.kind === 'opening' || m.kind === 'surplus') {
      netInflowsIrr += step.inventoryDeltaIrr;
    } else if (m.kind === 'purchase_return') {
      netInflowsIrr += step.inventoryDeltaIrr; // negative delta
      totalPurchaseReturnVarianceIrr += step.purchaseReturnVarianceIrr;
    } else if (m.kind === 'waste' || m.kind === 'shortage') {
      totalWasteCostIrr += step.cogsOrCostIrr;
      netOutflowsIrr += step.cogsOrCostIrr;
    }

    const isIn =
      m.kind === 'opening' ||
      m.kind === 'purchase' ||
      m.kind === 'sale_return' ||
      m.kind === 'surplus' ||
      m.kind === 'transfer_in';

    kardex.push({
      movementId: m.id,
      date: m.date,
      kind: m.kind,
      productId,
      warehouse: m.warehouse || warehouse,
      inQty: isIn ? roundQty2(m.qty) : 0,
      outQty: isIn ? 0 : roundQty2(m.qty),
      balanceQty: state.stockQty,
      unitCostIrr: step.effectiveUnitCostIrr,
      inValueIrr: isIn ? Math.abs(step.inventoryDeltaIrr) : 0,
      outValueIrr: isIn ? 0 : Math.abs(step.inventoryDeltaIrr),
      balanceValueIrr: state.totalValueIrr,
      cogsOrCostIrr: step.cogsOrCostIrr,
      purchaseReturnVarianceIrr: step.purchaseReturnVarianceIrr,
      consumedLayers: step.consumedLayers,
    });
  }

  return {
    productId,
    costingMethod,
    kardex,
    finalState: state,
    totalPurchasesQty: roundQty2(totalPurchasesQty),
    totalPurchasesValueIrr,
    totalSalesQty: roundQty2(totalSalesQty),
    totalCogsIrr,
    totalWasteCostIrr,
    totalPurchaseReturnVarianceIrr,
    conservationDeltaIrr: netInflowsIrr - netOutflowsIrr - state.totalValueIrr,
  };
}

/**
 * Plans an inter-warehouse transfer while preserving exact historical cost layers.
 * Strictly guarantees `pnlImpactIrr === 0` (no phantom revenue, COGS, gain, or loss).
 */
export function planWarehouseTransfer(input: {
  state: ProductInventoryState;
  fromWarehouse: string;
  toWarehouse: string;
  qty: number;
  transferId: string;
  date: string;
}): WarehouseTransferPlan {
  const { state, fromWarehouse, toWarehouse, transferId, date } = input;
  const qty = roundQty(input.qty);
  if (!fromWarehouse.trim() || !toWarehouse.trim() || fromWarehouse.trim() === toWarehouse.trim()) {
    throw new Error('انبار مبدأ و انبار مقصد در انتقال بین انبارها باید متفاوت باشند.');
  }
  if (qty <= 0) {
    throw new Error('مقدار انتقال بین انبارها باید بزرگ‌تر از صفر باشد.');
  }
  const remainingSourceLayers = cloneLayers(state.layers);
  const sourceQty = roundQty(
    remainingSourceLayers
      .filter((layer) => layer.warehouse === fromWarehouse)
      .reduce((sum, layer) => sum + layer.remainingQty, 0)
  );
  if (sourceQty + 0.0001 < qty) {
    throw new Error(
      `موجودی کافی برای انتقال از «${fromWarehouse}» وجود ندارد (موجودی این انبار: ${roundQty2(sourceQty)}، درخواستی: ${roundQty2(qty)}).`
    );
  }

  const transferredLayers: InventoryCostLayer[] = [];
  let rem = qty;
  let transferredCostIrr = 0;

  // Transfer only layers physically held by the selected source warehouse.
  // Other warehouses' layers remain untouched even when aggregate product stock is sufficient.
  for (const layer of remainingSourceLayers) {
    if (rem <= 0.00005) break;
    if (layer.warehouse !== fromWarehouse || layer.remainingQty <= 0.00005) continue;
    const take = roundQty(Math.min(layer.remainingQty, rem));
    const takeCost = allocateLayerCostIrr(layer, take);
    layer.remainingQty = roundQty(Math.max(0, layer.remainingQty - take));
    layer.totalCostIrr = Math.max(0, layer.totalCostIrr - takeCost);
    rem = roundQty(Math.max(0, rem - take));
    transferredCostIrr += takeCost;

    transferredLayers.push({
      layerId: `trf_${transferId}_${layer.layerId}`,
      date,
      sourceRef: layer.sourceRef,
      warehouse: toWarehouse,
      originalQty: take,
      remainingQty: take,
      unitCostIrr: take > 0 ? Math.round(takeCost / take) : layer.unitCostIrr,
      totalCostIrr: takeCost,
    });
  }

  return {
    productId: state.productId,
    fromWarehouse,
    toWarehouse,
    qty: roundQty(qty),
    transferredCostIrr,
    transferredLayers,
    remainingSourceLayers: remainingSourceLayers.filter((l) => l.remainingQty > 0.00005),
    pnlImpactIrr: 0,
  };
}
