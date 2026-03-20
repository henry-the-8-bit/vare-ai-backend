import { db } from "@workspace/db";
import {
  merchantsTable,
  syncJobsTable,
  systemAlertsTable,
  normalizedProductsTable,
  agentConfigsTable,
  inventoryTable,
  probeConfigsTable,
} from "@workspace/db/schema";
import { eq, sql, and, lt } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import { getOrGenerateInsights } from "../services/insightsService.js";

const PROBE_FREQUENCY_HOURS: Record<string, number> = {
  realtime: 0.25,
  frequent: 1,
  hourly: 1,
  every_4h: 4,
  every_6h: 6,
  daily: 24,
  cached: 24,
};

let lastProbeRunByMerchant: Map<string, number> = new Map();

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
 * Recomputes agent_readiness_score for all normalized products where the score
 * may be stale. Runs a SQL UPDATE to compute a composite score from available
 * product fields. This effectively triggers a post-normalization readiness sweep.
 */
async function runReadinessRecompute() {
  try {
    const merchants = await db
      .select({ id: merchantsTable.id })
      .from(merchantsTable)
      .where(eq(merchantsTable.isLive, true))
      .limit(50);

    for (const merchant of merchants) {
      const result = await db.execute(sql`
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
      logger.info({ merchantId: merchant.id, rowCount: result.rowCount }, "[readiness] Score recomputed");
    }
  } catch (err) {
    logger.error({ err }, "[readiness] Recompute failed");
  }
}

/**
 * Inventory batch probe per config schedule.
 * Each merchant may have a probe_configs row with a probeFrequency (e.g. "hourly", "every_4h", "daily").
 * This job runs every 30 minutes and dispatches a probe job only for merchants whose configured
 * probe interval has elapsed since their last probe run.
 * Batch size is derived from the merchant's rateLimitPerMinute config.
 */
async function runInventoryBatchProbe() {
  try {
    const merchants = await db
      .select({ id: merchantsTable.id })
      .from(merchantsTable)
      .where(eq(merchantsTable.isLive, true))
      .limit(50);

    const now = Date.now();

    for (const merchant of merchants) {
      const [probeConfig] = await db
        .select({ probeFrequency: probeConfigsTable.probeFrequency })
        .from(probeConfigsTable)
        .where(eq(probeConfigsTable.merchantId, merchant.id))
        .limit(1);

      const freqKey = probeConfig?.probeFrequency ?? "every_4h";
      const intervalHours = PROBE_FREQUENCY_HOURS[freqKey] ?? 4;
      const intervalMs = intervalHours * 60 * 60 * 1000;

      const lastRun = lastProbeRunByMerchant.get(merchant.id) ?? 0;
      if (now - lastRun < intervalMs) {
        continue;
      }

      const [agentConfig] = await db
        .select({ rateLimitPerMinute: agentConfigsTable.rateLimitPerMinute })
        .from(agentConfigsTable)
        .where(eq(agentConfigsTable.merchantId, merchant.id))
        .limit(1);

      const batchSize = agentConfig?.rateLimitPerMinute
        ? Math.min(agentConfig.rateLimitPerMinute * 60, 5000)
        : 1000;

      const staleThreshold = new Date();
      staleThreshold.setHours(staleThreshold.getHours() - intervalHours);

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
        lastProbeRunByMerchant.set(merchant.id, now);
        logger.info({ merchantId: merchant.id, freqKey }, "[inventory-probe] No stale SKUs to probe");
        continue;
      }

      await db.insert(syncJobsTable).values({
        merchantId: merchant.id,
        jobType: "inventory_probe",
        status: "queued",
        totalRecords: staleSkus.length,
        processedRecords: 0,
        errorCount: 0,
        startedAt: new Date(),
      });

      lastProbeRunByMerchant.set(merchant.id, now);
      logger.info(
        { merchantId: merchant.id, skuCount: staleSkus.length, batchSize, freqKey, intervalHours },
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
  const THIRTY_MINUTES = 30 * 60 * 1000;
  const SIX_HOURS = 6 * 60 * 60 * 1000;
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
  }, THIRTY_MINUTES);

  setInterval(() => {
    runDailyInsights().catch((err) => logger.error({ err }, "[insights] Uncaught error"));
  }, TWENTY_FOUR_HOURS);

  logger.info("Background jobs started: health-check (5m), readiness (6h), delta-sync (6h), inventory-probe (30m dispatch per merchant config schedule), insights (24h)");
}
