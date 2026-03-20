import { db } from "@workspace/db";
import {
  merchantsTable,
  syncJobsTable,
  systemAlertsTable,
  normalizedProductsTable,
} from "@workspace/db/schema";
import { eq, sql, and } from "drizzle-orm";
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

async function runReadinessRecompute() {
  try {
    const merchants = await db.select({ id: merchantsTable.id }).from(merchantsTable).where(eq(merchantsTable.isLive, true)).limit(50);
    for (const merchant of merchants) {
      const [result] = await db
        .select({ cnt: sql<number>`count(*)` })
        .from(normalizedProductsTable)
        .where(
          and(
            eq(normalizedProductsTable.merchantId, merchant.id),
            sql`normalization_status = 'pending'`,
          ),
        );
      if (Number(result?.cnt ?? 0) > 0) {
        logger.info({ merchantId: merchant.id, pending: result?.cnt }, "[readiness] Pending normalization detected");
      }
    }
  } catch (err) {
    logger.error({ err }, "[readiness] Recompute failed");
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
    runDailyInsights().catch((err) => logger.error({ err }, "[insights] Uncaught error"));
  }, TWENTY_FOUR_HOURS);

  logger.info("Background jobs started: health-check (5m), readiness (6h), delta-sync (6h), insights (24h)");
}
