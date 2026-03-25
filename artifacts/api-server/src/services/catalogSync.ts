import { db } from "@workspace/db";
import {
  syncJobsTable,
  rawProductsTable,
  magentoConnectionsTable,
  merchantsTable,
  feedsTable,
} from "@workspace/db/schema";
import { eq, and, desc } from "drizzle-orm";
import { MagentoConnector, type SyncFilters } from "./magentoConnector.js";
import { decrypt } from "../lib/crypto.js";
import { logger } from "../lib/logger.js";

export type SyncJobStatus = "queued" | "running" | "paused" | "completed" | "failed" | "cancelled";

interface SyncJobRecord {
  id: string;
  status: string | null;
  totalRecords: number | null;
  processedRecords: number | null;
  errorCount: number | null;
  errorLog: unknown;
  config: unknown;
}

const activeJobs = new Map<string, { paused: boolean; cancelled: boolean }>();

async function getConnector(merchantId: string): Promise<MagentoConnector> {
  const [conn] = await db
    .select()
    .from(magentoConnectionsTable)
    .where(eq(magentoConnectionsTable.merchantId, merchantId))
    .limit(1);

  if (!conn) {
    throw new Error("No Magento connection found for merchant");
  }

  const credentials = {
    storeUrl: conn.storeUrl,
    consumerKey: conn.consumerKey ? decrypt(conn.consumerKey) : null,
    consumerSecret: conn.consumerSecret ? decrypt(conn.consumerSecret) : null,
    accessToken: conn.accessToken ? decrypt(conn.accessToken) : null,
    accessTokenSecret: conn.accessTokenSecret ? decrypt(conn.accessTokenSecret) : null,
  };

  return new MagentoConnector(credentials);
}

async function updateJobProgress(
  jobId: string,
  updates: {
    status?: string;
    processedRecords?: number;
    totalRecords?: number;
    errorCount?: number;
    startedAt?: Date;
    completedAt?: Date;
    durationSeconds?: number;
    errorLog?: unknown[];
  },
): Promise<void> {
  await db
    .update(syncJobsTable)
    .set({ ...updates })
    .where(eq(syncJobsTable.id, jobId));
}

async function updateFeedSyncStatus(feedId: string | undefined, status: string, errorMessage?: string): Promise<void> {
  if (!feedId) return;
  await db
    .update(feedsTable)
    .set({
      status,
      errorMessage: errorMessage ?? null,
      lastSyncAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(feedsTable.id, feedId));
}

async function runSyncBatches(
  jobId: string,
  merchantId: string,
  connector: MagentoConnector,
  filters: SyncFilters,
  feedId?: string,
  pageSize = 100,
): Promise<void> {
  const ctrl = activeJobs.get(jobId) ?? { paused: false, cancelled: false };

  let page = 1;
  let totalProcessed = 0;
  let totalErrors = 0;
  const errorLog: Array<{ sku?: string; error: string; timestamp: string }> = [];

  const startedAt = new Date();
  await updateJobProgress(jobId, { status: "running", startedAt });

  try {
    let totalCount: number | null = null;

    while (true) {
      const state = activeJobs.get(jobId);

      if (state?.cancelled) {
        await updateJobProgress(jobId, {
          status: "cancelled",
          processedRecords: totalProcessed,
          errorCount: totalErrors,
          errorLog,
        });
        await updateFeedSyncStatus(feedId, "active");
        return;
      }

      if (state?.paused) {
        await updateJobProgress(jobId, {
          status: "paused",
          processedRecords: totalProcessed,
          errorCount: totalErrors,
          errorLog,
        });
        await new Promise((resolve) => setTimeout(resolve, 2000));
        continue;
      }

      let result;
      try {
        result = await connector.fetchProducts(filters, page, pageSize);
      } catch (err) {
        logger.error({ jobId, page, err }, "Failed to fetch product batch");
        errorLog.push({ error: `Page ${page}: ${String(err)}`, timestamp: new Date().toISOString() });
        totalErrors++;
        await updateJobProgress(jobId, {
          status: "failed",
          errorCount: totalErrors,
          errorLog,
          completedAt: new Date(),
          durationSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000),
        });
        await updateFeedSyncStatus(feedId, "error", `Page ${page}: ${String(err)}`);
        return;
      }

      if (totalCount === null) {
        totalCount = result.totalCount;
        await updateJobProgress(jobId, { totalRecords: totalCount });
      }

      for (const product of result.products) {
        const p = product as Record<string, unknown>;
        const sku = String(p["sku"] ?? "");

        let attempt = 0;
        let saved = false;

        while (attempt < 3 && !saved) {
          try {
            await db
              .insert(rawProductsTable)
              .values({
                merchantId,
                magentoProductId: typeof p["id"] === "number" ? p["id"] : null,
                sku,
                productType: typeof p["type_id"] === "string" ? p["type_id"] : null,
                status: String(p["status"] ?? ""),
                visibility: String(p["visibility"] ?? ""),
                rawData: p,
                syncedAt: new Date(),
                updatedAt: new Date(),
              })
              .onConflictDoUpdate({
                target: [rawProductsTable.merchantId, rawProductsTable.sku],
                set: {
                  rawData: p,
                  status: String(p["status"] ?? ""),
                  visibility: String(p["visibility"] ?? ""),
                  updatedAt: new Date(),
                },
              });
            saved = true;
          } catch (err) {
            attempt++;
            if (attempt >= 3) {
              errorLog.push({
                sku,
                error: String(err),
                timestamp: new Date().toISOString(),
              });
              totalErrors++;
            } else {
              await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
            }
          }
        }

        if (saved) totalProcessed++;
      }

      await updateJobProgress(jobId, {
        processedRecords: totalProcessed,
        errorCount: totalErrors,
        errorLog: errorLog.length > 0 ? errorLog : undefined,
      });

      if (result.products.length < pageSize) break;
      page++;
    }

    const completedAt = new Date();
    const durationSeconds = Math.round((completedAt.getTime() - startedAt.getTime()) / 1000);

    await updateJobProgress(jobId, {
      status: "completed",
      processedRecords: totalProcessed,
      errorCount: totalErrors,
      errorLog: errorLog.length > 0 ? errorLog : undefined,
      completedAt,
      durationSeconds,
    });
    await updateFeedSyncStatus(feedId, totalErrors > 0 ? "warning" : "active");
  } finally {
    activeJobs.delete(jobId);
  }
}

export class CatalogSyncService {
  async startFullSync(merchantId: string, config: SyncConfig, feedId?: string): Promise<SyncJobRecord> {
    const [job] = await db
      .insert(syncJobsTable)
      .values({
        merchantId,
        feedId: feedId ?? null,
        jobType: "catalog_full",
        status: "queued",
        config,
      })
      .returning();

    const filters: SyncFilters = {
      productTypes: config.productTypes,
      status: config.status,
      visibility: config.visibility,
      categoryIds: config.categoryIds,
      attributes: config.attributes,
    };

    activeJobs.set(job.id, { paused: false, cancelled: false });

    setImmediate(async () => {
      try {
        const connector = await getConnector(merchantId);
        await runSyncBatches(job.id, merchantId, connector, filters, feedId);
      } catch (err) {
        logger.error({ jobId: job.id, err }, "Sync job failed to start");
        await updateJobProgress(job.id, {
          status: "failed",
          errorLog: [{ error: String(err), timestamp: new Date().toISOString() }],
        });
        await updateFeedSyncStatus(feedId, "error", String(err));
        activeJobs.delete(job.id);
      }
    });

    return job;
  }

  async startDeltaSync(merchantId: string, feedId?: string): Promise<SyncJobRecord> {
    const [lastCompleted] = await db
      .select({ completedAt: syncJobsTable.completedAt })
      .from(syncJobsTable)
      .where(
        and(
          eq(syncJobsTable.merchantId, merchantId),
          eq(syncJobsTable.status, "completed"),
        ),
      )
      .orderBy(desc(syncJobsTable.completedAt))
      .limit(1);

    const updatedSince = lastCompleted?.completedAt?.toISOString() ?? new Date(Date.now() - 86400_000).toISOString();

    const [job] = await db
      .insert(syncJobsTable)
      .values({
        merchantId,
        feedId: feedId ?? null,
        jobType: "catalog_delta",
        status: "queued",
        config: { updatedSince },
      })
      .returning();

    const filters: SyncFilters = { updatedSince };

    activeJobs.set(job.id, { paused: false, cancelled: false });

    setImmediate(async () => {
      try {
        const connector = await getConnector(merchantId);
        await runSyncBatches(job.id, merchantId, connector, filters, feedId);
      } catch (err) {
        logger.error({ jobId: job.id, err }, "Delta sync job failed to start");
        await updateJobProgress(job.id, {
          status: "failed",
          errorLog: [{ error: String(err), timestamp: new Date().toISOString() }],
        });
        await updateFeedSyncStatus(feedId, "error", String(err));
        activeJobs.delete(job.id);
      }
    });

    return job;
  }

  pauseJob(jobId: string): boolean {
    const ctrl = activeJobs.get(jobId);
    if (!ctrl || ctrl.cancelled) return false;
    ctrl.paused = true;
    return true;
  }

  resumeJob(jobId: string): boolean {
    const ctrl = activeJobs.get(jobId);
    if (!ctrl) return false;
    ctrl.paused = false;
    return true;
  }

  cancelJob(jobId: string): boolean {
    const ctrl = activeJobs.get(jobId);
    if (!ctrl) return false;
    ctrl.cancelled = true;
    return true;
  }

  async getJob(jobId: string, merchantId: string): Promise<SyncJobRecord | null> {
    const [job] = await db
      .select()
      .from(syncJobsTable)
      .where(and(eq(syncJobsTable.id, jobId), eq(syncJobsTable.merchantId, merchantId)))
      .limit(1);
    return job ?? null;
  }

  async getLatestJob(merchantId: string): Promise<SyncJobRecord | null> {
    const [job] = await db
      .select()
      .from(syncJobsTable)
      .where(eq(syncJobsTable.merchantId, merchantId))
      .orderBy(desc(syncJobsTable.createdAt))
      .limit(1);
    return job ?? null;
  }
}

export interface SyncConfig {
  productTypes?: string[];
  status?: string[];
  visibility?: string[];
  categoryIds?: number[];
  attributes?: string[];
}

export const catalogSyncService = new CatalogSyncService();
