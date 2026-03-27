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
import { z } from "zod/v4";
import { requireAuth } from "../middlewares/auth.js";
import { successResponse, paginatedResponse, errorResponse } from "../lib/response.js";
import { getDateBounds, type DateRange } from "../services/metricsService.js";
import { feedService } from "../services/feedService.js";

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

  const data = connections.map((c) => ({
    name: c.storeName ?? "Store",
    type: "magento",
    status: c.connectionStatus === "connected" ? "connected" : c.connectionStatus ?? "pending",
    lastSync: c.lastHealthCheck?.toISOString() ?? "",
    nextSync: "",
    metrics: { products: 0, categories: 0, avgLatency: "N/A" },
    apiHealth: c.apiHealthPct ?? 0,
    icon: "🔗",
  }));

  successResponse(res, data);
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

  // Group jobs by jobType into timeline segments
  const data = jobs.reduce<Array<{ label: string; segments: Array<{ start: number; end: number; type: string; tooltip: string }> }>>((acc, job) => {
    const label = job.jobType ?? "sync";
    let entry = acc.find((e) => e.label === label);
    if (!entry) {
      entry = { label, segments: [] };
      acc.push(entry);
    }
    const start = job.startedAt?.getTime() ?? job.createdAt?.getTime() ?? 0;
    const end = job.completedAt?.getTime() ?? start + (job.durationSeconds ?? 0) * 1000;
    entry.segments.push({
      start,
      end,
      type: job.status ?? "unknown",
      tooltip: `${job.status} — ${job.processedRecords ?? 0}/${job.totalRecords ?? 0} records`,
    });
    return acc;
  }, []);

  successResponse(res, data);
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

  const overallScore = Math.min(100, Math.round((pct(normalized) * 0.4 + (avgScore || 0) * 0.4 + pct(withFitment) * 0.2)));

  successResponse(res, {
    currentScore: overallScore,
    targetScore: 85,
    trend: [],
    breakdown: [
      { attribute: "Normalization", score: Math.round(pct(normalized)), weight: "40%" },
      { attribute: "Readiness Score", score: avgScore, weight: "40%" },
      { attribute: "Fitment Data", score: Math.round(pct(withFitment)), weight: "20%" },
      { attribute: "Pricing", score: Math.round(pct(withPrice)), weight: "bonus" },
      { attribute: "Images", score: Math.round(pct(withImage)), weight: "bonus" },
    ],
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

  const data = jobs.map((j) => ({
    date: j.createdAt?.toISOString() ?? "",
    source: "Magento",
    type: j.jobType ?? "sync",
    records: j.processedRecords ?? 0,
    duration: j.durationSeconds ? `${j.durationSeconds}s` : "N/A",
    status: j.status ?? "unknown",
    details: j.errorCount && j.errorCount > 0 ? `${j.errorCount} errors` : `${j.processedRecords ?? 0}/${j.totalRecords ?? 0} processed`,
  }));

  successResponse(res, data);
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

  const normalizedCount = (byStatus["normalized"] ?? 0) + (byStatus["reviewed"] ?? 0);
  const attributes = [
    { name: "Normalization Status", withData: normalizedCount, without: total - normalizedCount, coverage: total > 0 ? Math.round((normalizedCount / total) * 100) : 0, trend: 0, critical: true },
    { name: "Title", withData: total, without: 0, coverage: 100, trend: 0, critical: true },
    { name: "Price", withData: normalizedCount, without: total - normalizedCount, coverage: total > 0 ? Math.round((normalizedCount / total) * 100) : 0, trend: 0, critical: true },
  ];

  successResponse(res, {
    attributes,
    coverageOverTime: [],
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

  successResponse(res, {
    stats: {
      totalAttributes: Number(cnt ?? 0),
      totalMappings: Number(cnt ?? 0),
      autoNormalized: mappings.filter((m) => m.confidence && Number(m.confidence) > 0.8).length,
      pendingReview: mappings.filter((m) => !m.confidence || Number(m.confidence) <= 0.8).length,
    },
    recentActivity: mappings.slice(0, 10).map((m) => ({
      date: m.createdAt?.toISOString() ?? "",
      action: `Mapped ${m.sourceValue} → ${m.normalizedValue}`,
      affected: 1,
      status: m.confidence && Number(m.confidence) > 0.8 ? "auto" : "pending",
    })),
  });
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

  const totalErrors = jobs.reduce((s, j) => s + (j.errorCount ?? 0), 0);
  const categories: Record<string, { count: number; lastSeen: string }> = {};
  for (const j of jobs) {
    const cat = j.jobType ?? "unknown";
    if (!categories[cat]) {
      categories[cat] = { count: 0, lastSeen: j.createdAt?.toISOString() ?? "" };
    }
    categories[cat].count += j.errorCount ?? 0;
  }

  successResponse(res, {
    summary: {
      totalEvents: jobs.length,
      errors: totalErrors,
      warnings: 0,
      trend: totalErrors > 0 ? "up" : "stable",
    },
    categories: Object.entries(categories).map(([category, v]) => ({
      category,
      count: v.count,
      lastSeen: v.lastSeen,
      status: v.count > 0 ? "active" : "resolved",
      detail: `${v.count} errors in ${category} jobs`,
    })),
  });
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
    stats: { totalSKUs: total, inStock, lowStock, outOfStock },
    freshness: {
      lastProbe: new Date().toISOString(),
      avgAge: stale > 0 ? `${Math.round((stale / total) * 24)}h` : "< 1h",
      accuracy: `${Math.max(0, Math.min(100, Math.round(pct(inStock) - pct(stale) * 0.3)))}%`,
    },
    distribution: [
      { label: "In Stock", count: inStock, percentage: pct(inStock) },
      { label: "Low Stock", count: lowStock, percentage: pct(lowStock) },
      { label: "Out of Stock", count: outOfStock, percentage: pct(outOfStock) },
      { label: "Stale Data", count: stale, percentage: pct(stale) },
    ],
    topStockOuts: [],
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

  const data = alerts.map((a) => ({
    type: a.alertType ?? "warning",
    title: a.title ?? "",
    time: a.createdAt?.toISOString() ?? "",
    description: a.description ?? "",
    suggestion: a.suggestion ?? "",
    actions: ["Dismiss", "View Details"],
  }));

  successResponse(res, data);
});

// ---------------------------------------------------------------------------
// Feed CRUD & Actions
// ---------------------------------------------------------------------------

const inventoryConfigSchema = z.object({
  source: z.enum(["csv", "api", "scheduled_file"]),
  stalenessThresholdHours: z.number().min(1).max(720),
  lowStockThreshold: z.number().int().min(0).max(10000),
  safetyBufferPercent: z.number().min(0).max(100),
  staleBehavior: z.enum(["hide", "flag", "show"]),
});

const feedConfigSchema = z.record(z.string(), z.unknown())
  .optional()
  .refine(
    (val) => {
      if (!val?.inventory) return true;
      return inventoryConfigSchema.safeParse(val.inventory).success;
    },
    { message: "Invalid inventory configuration" },
  );

const createFeedSchema = z.object({
  name: z.string().min(1).max(255),
  type: z.enum(["live", "static"]),
  source: z.string().min(1).max(50),
  sourceConnectionId: z.string().uuid().optional(),
  config: feedConfigSchema,
  syncSchedule: z.string().optional(),
});

const updateFeedSchema = createFeedSchema.partial();

router.get("/feeds", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  try {
    const feeds = await feedService.listFeeds(merchantId);
    successResponse(res, feeds);
  } catch (err: any) {
    console.error("[feeds] listFeeds error:", err);
    errorResponse(res, err.message || "Failed to list feeds", "INTERNAL_ERROR", 500);
  }
});

router.post("/feeds", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;

  const parsed = createFeedSchema.safeParse(req.body);
  if (!parsed.success) {
    errorResponse(res, "Validation failed", "VALIDATION_ERROR", 400, parsed.error.flatten());
    return;
  }

  try {
    const feed = await feedService.createFeed(merchantId, parsed.data);
    successResponse(res, feed, 201);
  } catch (err: any) {
    console.error("[feeds] createFeed error:", err);
    errorResponse(res, err.message || "Failed to create feed", "INTERNAL_ERROR", 500);
  }
});

router.put("/feeds/:id", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const feedId = req.params["id"] as string;

  const parsed = updateFeedSchema.safeParse(req.body);
  if (!parsed.success) {
    errorResponse(res, "Validation failed", "VALIDATION_ERROR", 400, parsed.error.flatten());
    return;
  }

  try {
    const feed = await feedService.updateFeed(merchantId, feedId, parsed.data);
    if (!feed) {
      errorResponse(res, "Feed not found", "NOT_FOUND", 404);
      return;
    }
    successResponse(res, feed);
  } catch (err: any) {
    console.error("[feeds] updateFeed error:", err);
    errorResponse(res, err.message || "Failed to update feed", "INTERNAL_ERROR", 500);
  }
});

router.delete("/feeds/:id", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const feedId = req.params["id"] as string;

  try {
    const deleted = await feedService.deleteFeed(merchantId, feedId);
    if (!deleted) {
      errorResponse(res, "Feed not found", "NOT_FOUND", 404);
      return;
    }
    successResponse(res, { deleted: true });
  } catch (err: any) {
    console.error("[feeds] deleteFeed error:", err);
    errorResponse(res, err.message || "Failed to delete feed", "INTERNAL_ERROR", 500);
  }
});

router.post("/feeds/:id/sync", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const feedId = req.params["id"] as string;

  try {
    const result = await feedService.triggerSync(merchantId, feedId);
    if (!result) {
      errorResponse(res, "Feed not found", "NOT_FOUND", 404);
      return;
    }
    if ("error" in result) {
      errorResponse(res, result.error as string, "FEED_PAUSED", 400);
      return;
    }
    successResponse(res, result, 202);
  } catch (err: any) {
    console.error("[feeds] triggerSync error:", err);
    errorResponse(res, err.message || "Failed to trigger sync", "INTERNAL_ERROR", 500);
  }
});

router.post("/feeds/:id/pause", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const feedId = req.params["id"] as string;

  try {
    const feed = await feedService.togglePause(merchantId, feedId);
    if (!feed) {
      errorResponse(res, "Feed not found", "NOT_FOUND", 404);
      return;
    }
    successResponse(res, feed);
  } catch (err: any) {
    console.error("[feeds] togglePause error:", err);
    errorResponse(res, err.message || "Failed to toggle pause", "INTERNAL_ERROR", 500);
  }
});

router.post("/feeds/:id/test", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const feedId = req.params["id"] as string;

  try {
    const result = await feedService.testConnection(merchantId, feedId);
    successResponse(res, result);
  } catch (err: any) {
    console.error("[feeds] testConnection error:", err);
    errorResponse(res, err.message || "Failed to test connection", "INTERNAL_ERROR", 500);
  }
});

export default router;
