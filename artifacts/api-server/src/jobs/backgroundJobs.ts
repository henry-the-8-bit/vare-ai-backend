import { db } from "@workspace/db";
import {
  merchantsTable,
  syncJobsTable,
  systemAlertsTable,
  normalizedProductsTable,
  agentConfigsTable,
  inventoryTable,
} from "@workspace/db/schema";
import { eq, sql, and, lt } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import { getOrGenerateInsights } from "../services/insightsService.js";

async function runHealthCheck() {
  try {
    await db.execute(sql`SELECT 1`);
  } catch (err) {
    logger.error({ err }, "[health-check] DB unreachable");

    const merchants = await db.select({ id: merchantsTable.id }).from(merchantsTable).limit(50);
    for (const merchant of merchants) {
      await db.insert(systemAlertsTable).values({
        merchantId: merchant.id,
        alertType: "error",
        title: "Database Health Check Failed",
        description: "The background health check could not reach the database.",
        suggestion: "Check DATABASE_URL and PostgreSQL service status.",
        isRead: false,
      }).catch(() => {});
    }
  }
}

/**
 * Recomputes agent readiness scores for merchants that have pending normalization.
 * Updates normalized_products rows by recalculating a composite readiness score
 * based on available fields (title, price, category, images, fitment data).
 * Triggered on a 6h cadence as a post-normalization sweep.
 */
async function runReadinessRecompute() {
  try {
    const merchants = await db
      .select({ id: merchantsTable.id })
      .from(merchantsTable)
      .where(eq(merchantsTable.isLive, true))
      .limit(50);

    for (const merchant of merchants) {
      const updated = await db.execute(sql`
        UPDATE normalized_products
        SET agent_readiness_score = LEAST(100, (
          CASE WHEN product_title IS NOT NULL AND length(product_title) > 3 THEN 25 ELSE 0 END +
          CASE WHEN price IS NOT NULL AND price::numeric > 0 THEN 25 ELSE 0 END +
          CASE WHEN category_path IS NOT NULL THEN 15 ELSE 0 END +
          CASE WHEN brand IS NOT NULL THEN 10 ELSE 0 END +
          CASE WHEN mpn IS NOT NULL THEN 10 ELSE 0 END +
          CASE WHEN image_urls IS NOT NULL AND jsonb_array_length(image_urls) > 0 THEN 10 ELSE 0 END +
          CASE WHEN fitment_data IS NOT NULL AND fitment_data != '{}'::jsonb THEN 5 ELSE 0 END
        ))
        WHERE merchant_id = ${merchant.id}
          AND normalization_status IN ('normalized', 'reviewed')
      `);
      logger.info({ merchantId: merchant.id, rowCount: updated.rowCount }, "[readiness] Score recomputed");
    }
  } catch (err) {
    logger.error({ err }, "[readiness] Recompute failed");
  }
}

/**
 * Queues inventory batch probe jobs for each live merchant based on their
 * configured rate limit per minute (higher rate limit → more SKUs probed per run).
 * Probes SKUs whose lastProbed timestamp is older than 24h.
 */
async function runInventoryBatchProbe() {
  try {
    const merchants = await db
      .select({ id: merchantsTable.id })
      .from(merchantsTable)
      .where(eq(merchantsTable.isLive, true))
      .limit(50);

    for (const merchant of merchants) {
      const [config] = await db
        .select({ rateLimitPerMinute: agentConfigsTable.rateLimitPerMinute })
        .from(agentConfigsTable)
        .where(eq(agentConfigsTable.merchantId, merchant.id))
        .limit(1);

      const batchSize = config?.rateLimitPerMinute
        ? Math.min(config.rateLimitPerMinute * 60, 5000)
        : 1000;

      const staleThreshold = new Date();
      staleThreshold.setHours(staleThreshold.getHours() - 24);

      const staleSkus = await db
        .select({ sku: inventoryTable.sku })
        .from(inventoryTable)
        .where(
          and(
            eq(inventoryTable.merchantId, merchant.id),
            lt(inventoryTable.lastProbed, staleThreshold),
          ),
        )
        .limit(batchSize);

      if (staleSkus.length === 0) {
        logger.info({ merchantId: merchant.id }, "[inventory-probe] No stale SKUs to probe");
        continue;
      }

      const [jobRecord] = await db
        .insert(syncJobsTable)
        .values({
          merchantId: merchant.id,
          jobType: "inventory_probe",
          status: "queued",
          totalRecords: staleSkus.length,
          processedRecords: 0,
          errorCount: 0,
          startedAt: new Date(),
        })
        .returning({ id: syncJobsTable.id });

      logger.info(
        { merchantId: merchant.id, skuCount: staleSkus.length, jobId: jobRecord?.id, batchSize },
        "[inventory-probe] Queued inventory probe job",
      );
    }
  } catch (err) {
    logger.error({ err }, "[inventory-probe] Job failed");
  }
}

async function runDailyInsights() {
  try {
    const merchants = await db
      .select({ id: merchantsTable.id })
      .from(merchantsTable)
      .where(eq(merchantsTable.isLive, true))
      .limit(50);

    for (const merchant of merchants) {
      try {
        await getOrGenerateInsights(merchant.id, "30d");
        logger.info({ merchantId: merchant.id }, "[insights] Daily insights refreshed");
      } catch (err) {
        logger.warn({ merchantId: merchant.id, err }, "[insights] Failed to refresh");
      }
    }
  } catch (err) {
    logger.error({ err }, "[insights] Daily job failed");
  }
}

async function triggerDeltaSync() {
  try {
    const merchants = await db
      .select({ id: merchantsTable.id })
      .from(merchantsTable)
      .where(eq(merchantsTable.isLive, true))
      .limit(50);

    for (const merchant of merchants) {
      await db.insert(syncJobsTable).values({
        merchantId: merchant.id,
        jobType: "delta_sync",
        status: "queued",
        totalRecords: 0,
        processedRecords: 0,
        errorCount: 0,
      }).catch(() => {});
      logger.info({ merchantId: merchant.id }, "[delta-sync] Queued delta sync job");
    }
  } catch (err) {
    logger.error({ err }, "[delta-sync] Failed to queue delta sync");
  }
}

export function startBackgroundJobs() {
  const FIVE_MINUTES = 5 * 60 * 1000;
  const SIX_HOURS = 6 * 60 * 60 * 1000;
  const FOUR_HOURS = 4 * 60 * 60 * 1000;
  const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

  setInterval(() => {
    runHealthCheck().catch((err) => logger.error({ err }, "[health-check] Uncaught error"));
  }, FIVE_MINUTES);

  setInterval(() => {
    runReadinessRecompute().catch((err) => logger.error({ err }, "[readiness] Uncaught error"));
  }, SIX_HOURS);

  setInterval(() => {
    triggerDeltaSync().catch((err) => logger.error({ err }, "[delta-sync] Uncaught error"));
  }, SIX_HOURS);

  setInterval(() => {
    runInventoryBatchProbe().catch((err) => logger.error({ err }, "[inventory-probe] Uncaught error"));
  }, FOUR_HOURS);

  setInterval(() => {
    runDailyInsights().catch((err) => logger.error({ err }, "[insights] Uncaught error"));
  }, TWENTY_FOUR_HOURS);

  logger.info("Background jobs started: health-check (5m), readiness (6h), delta-sync (6h), inventory-probe (4h per config batch size), insights (24h)");
}
