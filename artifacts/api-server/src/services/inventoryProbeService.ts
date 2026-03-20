import { db } from "@workspace/db";
import {
  inventoryTable,
  probeConfigsTable,
  magentoConnectionsTable,
} from "@workspace/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { MagentoConnector } from "./magentoConnector.js";
import { decrypt } from "../lib/crypto.js";
import { logger } from "../lib/logger.js";

export interface ProbeConfig {
  inventorySource: string;
  probeFrequency: string;
  cacheTtlMinutes: number;
  fallbackBehavior: string;
  lowStockThreshold: number;
}

export interface InventoryResult {
  sku: string;
  quantity: number | null;
  isInStock: boolean | null;
  source: string;
  latencyMs: number;
  cached: boolean;
  lastProbed: Date | null;
  error?: string;
}

async function getProbeConfig(merchantId: string): Promise<ProbeConfig> {
  const [cfg] = await db
    .select()
    .from(probeConfigsTable)
    .where(eq(probeConfigsTable.merchantId, merchantId))
    .limit(1);

  return {
    inventorySource: cfg?.inventorySource ?? "magento",
    probeFrequency: cfg?.probeFrequency ?? "cached",
    cacheTtlMinutes: cfg?.cacheTtlMinutes ?? 5,
    fallbackBehavior: cfg?.fallbackBehavior ?? "last_known",
    lowStockThreshold: cfg?.lowStockThreshold ?? 5,
  };
}

async function getConnector(merchantId: string): Promise<MagentoConnector | null> {
  const [conn] = await db
    .select()
    .from(magentoConnectionsTable)
    .where(eq(magentoConnectionsTable.merchantId, merchantId))
    .limit(1);

  if (!conn) return null;

  function safeDecrypt(val: string): string {
    try { return decrypt(val); } catch { return val; }
  }

  return new MagentoConnector({
    storeUrl: conn.storeUrl,
    accessToken: conn.accessToken ? safeDecrypt(conn.accessToken) : null,
  });
}

async function getCached(merchantId: string, sku: string, ttlMinutes: number): Promise<typeof inventoryTable.$inferSelect | null> {
  const [cached] = await db
    .select()
    .from(inventoryTable)
    .where(and(eq(inventoryTable.merchantId, merchantId), eq(inventoryTable.sku, sku)))
    .limit(1);

  if (!cached || !cached.lastProbed) return null;

  const ageMs = Date.now() - cached.lastProbed.getTime();
  const ttlMs = ttlMinutes * 60 * 1000;
  return ageMs < ttlMs ? cached : null;
}

export async function probeSingleSku(merchantId: string, sku: string): Promise<InventoryResult> {
  const cfg = await getProbeConfig(merchantId);

  if (cfg.probeFrequency === "cached") {
    const cached = await getCached(merchantId, sku, cfg.cacheTtlMinutes);
    if (cached) {
      return {
        sku,
        quantity: cached.quantity,
        isInStock: cached.isInStock,
        source: cached.sourceName ?? "magento",
        latencyMs: 0,
        cached: true,
        lastProbed: cached.lastProbed,
      };
    }
  }

  const connector = await getConnector(merchantId);
  if (!connector) {
    return handleFallback(merchantId, sku, cfg, "No Magento connection configured");
  }

  const start = Date.now();
  try {
    const stock = (await connector.checkInventory(sku)) as Record<string, unknown>;
    const latencyMs = Date.now() - start;

    const qty = typeof stock["qty"] === "number" ? stock["qty"] : null;
    const inStock = typeof stock["is_in_stock"] === "boolean" ? stock["is_in_stock"] : (qty !== null ? qty > 0 : null);

    await db
      .insert(inventoryTable)
      .values({
        merchantId,
        sku,
        quantity: qty !== null ? Math.round(qty) : null,
        isInStock: inStock,
        sourceName: "magento",
        lastProbed: new Date(),
        probeLatencyMs: latencyMs,
        lowStockThreshold: cfg.lowStockThreshold,
      })
      .onConflictDoUpdate({
        target: [inventoryTable.merchantId, inventoryTable.sku],
        set: {
          quantity: qty !== null ? Math.round(qty) : null,
          isInStock: inStock,
          lastProbed: new Date(),
          probeLatencyMs: latencyMs,
          updatedAt: new Date(),
        },
      });

    return { sku, quantity: qty !== null ? Math.round(qty) : null, isInStock: inStock, source: "magento", latencyMs, cached: false, lastProbed: new Date() };
  } catch (err) {
    const latencyMs = Date.now() - start;
    logger.warn({ merchantId, sku, err }, "Inventory probe failed");
    return handleFallback(merchantId, sku, cfg, String(err), latencyMs);
  }
}

async function persistInventoryResult(
  merchantId: string,
  sku: string,
  quantity: number | null,
  isInStock: boolean | null,
  sourceName: string,
  latencyMs: number,
  lowStockThreshold: number,
): Promise<void> {
  try {
    await db
      .insert(inventoryTable)
      .values({
        merchantId,
        sku,
        quantity,
        isInStock,
        sourceName,
        lastProbed: new Date(),
        probeLatencyMs: latencyMs,
        lowStockThreshold,
      })
      .onConflictDoUpdate({
        target: [inventoryTable.merchantId, inventoryTable.sku],
        set: {
          quantity,
          isInStock,
          sourceName,
          lastProbed: new Date(),
          probeLatencyMs: latencyMs,
          updatedAt: new Date(),
        },
      });
  } catch {
  }
}

async function handleFallback(merchantId: string, sku: string, cfg: ProbeConfig, error: string, latencyMs = 0): Promise<InventoryResult> {
  if (cfg.fallbackBehavior === "last_known") {
    const [last] = await db
      .select()
      .from(inventoryTable)
      .where(and(eq(inventoryTable.merchantId, merchantId), eq(inventoryTable.sku, sku)))
      .limit(1);

    if (last) {
      return { sku, quantity: last.quantity, isInStock: last.isInStock, source: "fallback_last_known", latencyMs, cached: true, lastProbed: last.lastProbed, error };
    }
  }

  if (cfg.fallbackBehavior === "assume_in_stock") {
    await persistInventoryResult(merchantId, sku, null, true, "fallback_assume_in_stock", latencyMs, cfg.lowStockThreshold);
    return { sku, quantity: null, isInStock: true, source: "fallback_assume_in_stock", latencyMs, cached: false, lastProbed: new Date(), error };
  }

  if (cfg.fallbackBehavior === "assume_out_of_stock") {
    await persistInventoryResult(merchantId, sku, 0, false, "fallback_assume_out_of_stock", latencyMs, cfg.lowStockThreshold);
    return { sku, quantity: 0, isInStock: false, source: "fallback_assume_out_of_stock", latencyMs, cached: false, lastProbed: new Date(), error };
  }

  return { sku, quantity: null, isInStock: null, source: "fallback_unknown", latencyMs, cached: false, lastProbed: null, error };
}

export async function probeBatchSkus(merchantId: string, skus: string[]): Promise<InventoryResult[]> {
  const results: InventoryResult[] = [];
  for (const sku of skus) {
    const result = await probeSingleSku(merchantId, sku);
    results.push(result);
  }
  return results;
}

export async function saveProbeConfig(merchantId: string, config: Partial<ProbeConfig>): Promise<typeof probeConfigsTable.$inferSelect> {
  const [existing] = await db
    .select({ id: probeConfigsTable.id })
    .from(probeConfigsTable)
    .where(eq(probeConfigsTable.merchantId, merchantId))
    .limit(1);

  if (existing) {
    const [updated] = await db
      .update(probeConfigsTable)
      .set({
        inventorySource: config.inventorySource ?? undefined,
        probeFrequency: config.probeFrequency ?? undefined,
        cacheTtlMinutes: config.cacheTtlMinutes ?? undefined,
        fallbackBehavior: config.fallbackBehavior ?? undefined,
        lowStockThreshold: config.lowStockThreshold ?? undefined,
      })
      .where(eq(probeConfigsTable.merchantId, merchantId))
      .returning();
    return updated;
  }

  const [inserted] = await db
    .insert(probeConfigsTable)
    .values({ merchantId, ...config })
    .returning();

  return inserted;
}

export async function getProbeResults(merchantId: string, skus?: string[]): Promise<typeof inventoryTable.$inferSelect[]> {
  if (skus && skus.length > 0) {
    return db
      .select()
      .from(inventoryTable)
      .where(and(eq(inventoryTable.merchantId, merchantId), inArray(inventoryTable.sku, skus)));
  }
  return db
    .select()
    .from(inventoryTable)
    .where(eq(inventoryTable.merchantId, merchantId))
    .limit(100);
}
