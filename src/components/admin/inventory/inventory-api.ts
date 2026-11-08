import {
  listInventoryFn,
  listStockHistoryFn,
  setLowStockThresholdFn,
} from "@/lib/inventory.functions";
import type { StockMovement } from "@/lib/inventory-data.server";
import type { InventoryRow } from "@/lib/inventory-logic";
import { adjustStockFn, listBatchesFn, receiveStockFn } from "@/lib/pos.functions";
import {
  cancelStockTakeFn,
  getStockTakeFn,
  postStockTakeFn,
  quickAdjustStockFn,
  receiveDeliveryFn,
  recordStockCountFn,
  recordStockCountsFn,
  startStockTakeFn,
} from "@/lib/stock-ops.functions";
import type { StockTakeView } from "@/lib/stock-ops.server";

export type Batch = {
  id: string;
  batch_code: string;
  qty_on_hand: number;
  qty_held: number;
  available: number;
  expires_at: string | null;
};

/** Everything the Inventory tab asks the server for. Injected so the panel can be tested without a server. */
export type InventoryApi = {
  list: () => Promise<InventoryRow[]>;
  history: (productId: string) => Promise<StockMovement[]>;
  batches: (productId: string) => Promise<Batch[]>;
  receive: (input: {
    productId: string;
    batchCode: string;
    quantity: number;
    expiresAt: string | null;
    unitCost: string | null;
    notes: string | null;
    key: string;
  }) => Promise<unknown>;
  adjust: (input: {
    batchId: string;
    delta: number;
    reason: string;
    key: string;
  }) => Promise<{ before: number; after: number }>;
  setThreshold: (productId: string, threshold: number) => Promise<unknown>;
};

export const serverInventoryApi: InventoryApi = {
  list: () => listInventoryFn() as Promise<InventoryRow[]>,
  history: (productId) => listStockHistoryFn({ data: { productId } }) as Promise<StockMovement[]>,
  batches: (productId) => listBatchesFn({ data: { productId } }) as Promise<Batch[]>,
  receive: (data) => receiveStockFn({ data }),
  adjust: (data) => adjustStockFn({ data }) as Promise<{ before: number; after: number }>,
  setThreshold: (productId, threshold) =>
    setLowStockThresholdFn({ data: { productId, threshold } }),
};

export type { StockMovement, StockTakeView };

/** Stock takes, quick add / remove and deliveries (5 Nov 2026). Injected like InventoryApi so screens test offline. */
export type StockOpsApi = {
  getStockTake: () => Promise<StockTakeView>;
  startStockTake: (input: {
    note: string | null;
    category: string | null;
    key: string;
  }) => Promise<unknown>;
  recordCount: (input: {
    stockTakeId: string;
    productId: string;
    counted: number;
    key: string;
  }) => Promise<{ expected: number; counted: number; difference: number }>;
  recordCounts: (input: {
    stockTakeId: string;
    lines: { productId: string; counted: number }[];
    key: string;
  }) => Promise<{ saved: number; failed: { productId: string; problem: string }[] }>;
  postStockTake: (input: { stockTakeId: string; key: string }) => Promise<{
    lines: number;
    changed: number;
    units_added: number;
    units_removed: number;
  }>;
  cancelStockTake: (input: { stockTakeId: string; key: string }) => Promise<unknown>;
  quickAdjust: (input: {
    productId: string;
    delta: number;
    reason: string;
    key: string;
  }) => Promise<{ before: number; after: number }>;
  receiveDelivery: (input: {
    supplier: string | null;
    reference: string | null;
    lines: {
      productId: string;
      quantity: number;
      unitCost: string | null;
      expiresOn: string | null;
    }[];
    key: string;
  }) => Promise<{ lines: number; units: number; batch_code: string }>;
};

export const serverStockOpsApi: StockOpsApi = {
  getStockTake: () => getStockTakeFn() as Promise<StockTakeView>,
  startStockTake: (data) => startStockTakeFn({ data }),
  recordCount: (data) =>
    recordStockCountFn({ data }) as Promise<{
      expected: number;
      counted: number;
      difference: number;
    }>,
  recordCounts: (data) =>
    recordStockCountsFn({ data }) as Promise<{
      saved: number;
      failed: { productId: string; problem: string }[];
    }>,
  postStockTake: (data) =>
    postStockTakeFn({ data }) as Promise<{
      lines: number;
      changed: number;
      units_added: number;
      units_removed: number;
    }>,
  cancelStockTake: (data) => cancelStockTakeFn({ data }),
  quickAdjust: (data) => quickAdjustStockFn({ data }) as Promise<{ before: number; after: number }>,
  receiveDelivery: (data) =>
    receiveDeliveryFn({ data }) as Promise<{ lines: number; units: number; batch_code: string }>,
};
