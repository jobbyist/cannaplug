import {
  listInventoryFn,
  listStockHistoryFn,
  setLowStockThresholdFn,
} from "@/lib/inventory.functions";
import type { StockMovement } from "@/lib/inventory-data.server";
import type { InventoryRow } from "@/lib/inventory-logic";
import { adjustStockFn, listBatchesFn, receiveStockFn } from "@/lib/pos.functions";

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

export type { StockMovement };
