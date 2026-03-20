import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  syncJobsTable,
  normalizedProductsTable,
  inventoryTable,
  attributeMappingsTable,
  systemAlertsTable,
  magentoConnectionsTable,
} from "@workspace/db/schema";
import { eq, and, desc, sql, gte, lte } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth.js";
import { successResponse, paginatedResponse, errorResponse } from "../lib/response.js";
import { getDateBounds, type DateRange } from "../services/metricsService.js";

const router: IRouter = Router();

function parseRange(req: Request): DateRange {
  const r = req.query["range"];
  if (r === "today" || r === "7d" || r === "30d" || r === "90d" || r === "ytd") return r;
  return "30d";
}

router.get("/feeds/connections", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;

  const connections = await db
    .select()
    .from(magentoConnectionsTable)
    .where(eq(magentoConnectionsTable.merchantId, merchantId));

  successResponse(res, connections);
});

router.get("/feeds/sync-timeline", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const range = parseRange(req);
  const { from, to } = getDateBounds(range);

  const jobs = await db
    .select()
    .from(syncJobsTable)
    .where(
      and(
        eq(syncJobsTable.merchantId, merchantId),
        gte(syncJobsTable.createdAt, from),
        lte(syncJobsTable.createdAt, to),
      ),
    )
    .orderBy(desc(syncJobsTable.createdAt))
    .limit(100);

  successResponse(res, jobs);
});

router.get("/feeds/readiness-score", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;

  const [totalRow, normalizedRow, withFitmentRow, withPriceRow, withImageRow] = await Promise.all([
    db
      .select({ cnt: sql<number>`count(*)` })
      .from(normalizedProductsTable)
      .where(eq(normalizedProductsTable.merchantId, merchantId)),
    db
      .select({ cnt: sql<number>`count(*)`, avgScore: sql<number>`avg(agent_readiness_score)` })
      .from(normalizedProductsTable)
      .where(
        and(
          eq(normalizedProductsTable.merchantId, merchantId),
          sql`normalization_status IN ('normalized', 'reviewed')`,
        ),
      ),
    db
      .select({ cnt: sql<number>`count(*)` })
      .from(normalizedProductsTable)
      .where(
        and(
          eq(normalizedProductsTable.merchantId, merchantId),
          sql`fitment_data is not null and fitment_data != '{}'::jsonb`,
        ),
      ),
    db
      .select({ cnt: sql<number>`count(*)` })
      .from(normalizedProductsTable)
      .where(
        and(
          eq(normalizedProductsTable.merchantId, merchantId),
          sql`price is not null and price > 0`,
        ),
      ),
    db
      .select({ cnt: sql<number>`count(*)` })
      .from(normalizedProductsTable)
      .where(
        and(
          eq(normalizedProductsTable.merchantId, merchantId),
          sql`image_urls is not null and jsonb_array_length(image_urls) > 0`,
        ),
      ),
  ]);

  const total = Number(totalRow[0]?.cnt ?? 0);
  const normalized = Number(normalizedRow[0]?.cnt ?? 0);
  const avgScore = Math.round(Number(normalizedRow[0]?.avgScore ?? 0));
  const withFitment = Number(withFitmentRow[0]?.cnt ?? 0);
  const withPrice = Number(withPriceRow[0]?.cnt ?? 0);
  const withImage = Number(withImageRow[0]?.cnt ?? 0);

  const pct = (n: number) => (total > 0 ? Math.round((n / total) * 1000) / 10 : 0);

  successResponse(res, {
    totalProducts: total,
    normalizedCount: normalized,
    normalizationPct: pct(normalized),
    avgAgentReadinessScore: avgScore,
    withFitmentPct: pct(withFitment),
    withPricePct: pct(withPrice),
    withImagePct: pct(withImage),
    overallScore: Math.min(100, Math.round((pct(normalized) * 0.4 + (avgScore || 0) * 0.4 + pct(withFitment) * 0.2))),
  });
});

router.get("/feeds/sync-history", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const page = Math.max(1, parseInt(String(req.query["page"] ?? "1"), 10));
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query["limit"] ?? "20"), 10)));
  const offset = (page - 1) * limit;
  const format = req.query["format"];

  const [jobs, [{ cnt }]] = await Promise.all([
    db
      .select()
      .from(syncJobsTable)
      .where(eq(syncJobsTable.merchantId, merchantId))
      .orderBy(desc(syncJobsTable.createdAt))
      .limit(format === "csv" ? 1000 : limit)
      .offset(format === "csv" ? 0 : offset),
    db
      .select({ cnt: sql<number>`count(*)` })
      .from(syncJobsTable)
      .where(eq(syncJobsTable.merchantId, merchantId)),
  ]);

  if (format === "csv") {
    const csvLines = [
      "id,jobType,status,totalRecords,processedRecords,errorCount,startedAt,completedAt,durationSeconds,createdAt",
      ...jobs.map((j) =>
        [
          j.id,
          j.jobType,
          j.status,
          j.totalRecords,
          j.processedRecords,
          j.errorCount,
          j.startedAt?.toISOString() ?? "",
          j.completedAt?.toISOString() ?? "",
          j.durationSeconds ?? "",
          j.createdAt?.toISOString() ?? "",
        ].join(","),
      ),
    ].join("\n");
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=sync-history.csv");
    res.send(csvLines);
    return;
  }

  paginatedResponse(res, jobs, Number(cnt ?? 0), page, limit);
});

router.get("/feeds/data-quality", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;

  const [totalRow, statusRows] = await Promise.all([
    db
      .select({ cnt: sql<number>`count(*)` })
      .from(normalizedProductsTable)
      .where(eq(normalizedProductsTable.merchantId, merchantId)),
    db
      .select({
        status: normalizedProductsTable.normalizationStatus,
        cnt: sql<number>`count(*)`,
      })
      .from(normalizedProductsTable)
      .where(eq(normalizedProductsTable.merchantId, merchantId))
      .groupBy(normalizedProductsTable.normalizationStatus),
  ]);

  const total = Number(totalRow[0]?.cnt ?? 0);
  const byStatus: Record<string, number> = {};
  for (const row of statusRows) {
    byStatus[row.status ?? "unknown"] = Number(row.cnt ?? 0);
  }

  successResponse(res, {
    totalProducts: total,
    byStatus,
    missingTitle: 0,
    missingPrice: total - (byStatus["normalized"] ?? 0) - (byStatus["reviewed"] ?? 0),
    missingFitment: 0,
  });
});

router.get("/feeds/normalization", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const page = Math.max(1, parseInt(String(req.query["page"] ?? "1"), 10));
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query["limit"] ?? "20"), 10)));
  const offset = (page - 1) * limit;

  const [mappings, [{ cnt }]] = await Promise.all([
    db
      .select()
      .from(attributeMappingsTable)
      .where(eq(attributeMappingsTable.merchantId, merchantId))
      .orderBy(desc(attributeMappingsTable.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ cnt: sql<number>`count(*)` })
      .from(attributeMappingsTable)
      .where(eq(attributeMappingsTable.merchantId, merchantId)),
  ]);

  paginatedResponse(res, mappings, Number(cnt ?? 0), page, limit);
});

router.get("/feeds/errors", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const format = req.query["format"];
  const limit = format === "csv" ? 1000 : 20;

  const jobs = await db
    .select()
    .from(syncJobsTable)
    .where(
      and(
        eq(syncJobsTable.merchantId, merchantId),
        sql`status = 'failed' or error_count > 0`,
      ),
    )
    .orderBy(desc(syncJobsTable.createdAt))
    .limit(limit);

  if (format === "csv") {
    const csvLines = [
      "id,jobType,status,errorCount,startedAt,completedAt,createdAt",
      ...jobs.map((j) =>
        [
          j.id,
          j.jobType,
          j.status,
          j.errorCount,
          j.startedAt?.toISOString() ?? "",
          j.completedAt?.toISOString() ?? "",
          j.createdAt?.toISOString() ?? "",
        ].join(","),
      ),
    ].join("\n");
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=errors.csv");
    res.send(csvLines);
    return;
  }

  successResponse(res, jobs);
});

router.get("/feeds/inventory-health", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;

  const [totalRow, inStockRow, outRow, lowStockRow, staleThrRow] = await Promise.all([
    db
      .select({ cnt: sql<number>`count(*)` })
      .from(inventoryTable)
      .where(eq(inventoryTable.merchantId, merchantId)),
    db
      .select({ cnt: sql<number>`count(*)` })
      .from(inventoryTable)
      .where(and(eq(inventoryTable.merchantId, merchantId), eq(inventoryTable.isInStock, true))),
    db
      .select({ cnt: sql<number>`count(*)` })
      .from(inventoryTable)
      .where(and(eq(inventoryTable.merchantId, merchantId), eq(inventoryTable.isInStock, false))),
    db
      .select({ cnt: sql<number>`count(*)` })
      .from(inventoryTable)
      .where(
        and(
          eq(inventoryTable.merchantId, merchantId),
          eq(inventoryTable.isInStock, true),
          sql`quantity is not null and quantity <= low_stock_threshold`,
        ),
      ),
    db
      .select({ cnt: sql<number>`count(*)` })
      .from(inventoryTable)
      .where(
        and(
          eq(inventoryTable.merchantId, merchantId),
          sql`last_probed < now() - interval '24 hours'`,
        ),
      ),
  ]);

  const total = Number(totalRow[0]?.cnt ?? 0);
  const inStock = Number(inStockRow[0]?.cnt ?? 0);
  const outOfStock = Number(outRow[0]?.cnt ?? 0);
  const lowStock = Number(lowStockRow[0]?.cnt ?? 0);
  const stale = Number(staleThrRow[0]?.cnt ?? 0);

  const pct = (n: number) => (total > 0 ? Math.round((n / total) * 1000) / 10 : 0);

  successResponse(res, {
    totalSkus: total,
    inStock,
    inStockPct: pct(inStock),
    outOfStock,
    outOfStockPct: pct(outOfStock),
    lowStock,
    lowStockPct: pct(lowStock),
    staleData: stale,
    stalePct: pct(stale),
    healthScore: Math.max(0, Math.min(100, Math.round(pct(inStock) - pct(stale) * 0.3))),
  });
});

router.get("/feeds/system-alerts", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const onlyUnread = req.query["unread"] === "true";

  const conditions = [eq(systemAlertsTable.merchantId, merchantId)];
  if (onlyUnread) conditions.push(sql`is_read = false`);

  const alerts = await db
    .select()
    .from(systemAlertsTable)
    .where(and(...conditions))
    .orderBy(desc(systemAlertsTable.createdAt))
    .limit(50);

  successResponse(res, alerts);
});

export default router;
