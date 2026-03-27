import { Router, type IRouter, type Request, type Response } from "express";
import { requireAuth } from "../middlewares/auth.js";
import { successResponse, paginatedResponse, errorResponse } from "../lib/response.js";
import {
  getKpis,
  getTimeseries,
  getPlatformBreakdown,
  getTopProducts,
  getQueryIntents,
  getUnmatchedQueries,
  getConversionFunnel,
  getFailedTransactions,
  type DateRange,
} from "../services/metricsService.js";
import { z } from "zod/v4";

const router: IRouter = Router();

const rangeSchema = z.enum(["today", "7d", "30d", "90d", "ytd"]).default("30d");

function parseRange(req: Request): DateRange {
  const r = rangeSchema.safeParse(req.query["range"]);
  return r.success ? r.data : "30d";
}

router.get("/metrics/kpi", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const range = parseRange(req);
  const data = await getKpis(merchantId, range);
  successResponse(res, data);
});

router.get("/metrics/timeseries", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const range = parseRange(req);
  const data = await getTimeseries(merchantId, range);
  successResponse(res, data);
});

router.get("/metrics/platform-breakdown", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const range = parseRange(req);
  const data = await getPlatformBreakdown(merchantId, range);
  successResponse(res, data);
});

router.get("/metrics/top-products", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const range = parseRange(req);
  const limit = Math.min(50, Math.max(1, parseInt(String(req.query["limit"] ?? "10"), 10)));
  const raw = await getTopProducts(merchantId, range, limit);
  const data = raw.map((r, i) => ({
    rank: i + 1,
    product: r.productTitle ?? r.sku ?? "Unknown",
    sku: r.sku ?? "",
    revenue: r.revenue ?? 0,
    orders: r.orders ?? 0,
    queries: 0,
    convRate: 0,
    trend: 0,
  }));
  successResponse(res, data);
});

router.get("/metrics/query-intents", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const range = parseRange(req);
  const raw = await getQueryIntents(merchantId, range);
  const data = raw.map((r) => ({
    intent: r.cluster ?? "unknown",
    count: r.count ?? 0,
    matchRate: `${r.matchRate ?? 0}%`,
    convRate: "0%",
    example: "",
  }));
  successResponse(res, data);
});

router.get("/metrics/unmatched-queries", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const range = parseRange(req);
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query["limit"] ?? "20"), 10)));
  const raw = await getUnmatchedQueries(merchantId, range, limit);
  const data = raw.map((r) => ({
    query: r.queryText ?? "",
    count: r.count ?? 0,
    reason: "No matching product found",
  }));
  successResponse(res, data);
});

router.get("/metrics/conversion-funnel", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const range = parseRange(req);
  const raw = await getConversionFunnel(merchantId, range);
  const stageLabels: Record<string, string> = {
    queries: "Agent Queries",
    add_to_cart: "Add to Cart",
    checkout_initiated: "Checkout Initiated",
    orders_placed: "Orders Placed",
  };
  const steps = raw.map((r, i) => ({
    label: stageLabels[r.stage] ?? r.stage,
    value: r.count,
    percentage: r.pct,
    dropRate: i > 0 && raw[i - 1].count > 0
      ? `${Math.round((1 - r.count / raw[i - 1].count) * 100)}% drop`
      : null,
  }));
  const dropOffInsights = [];
  for (let i = 1; i < raw.length; i++) {
    const prev = raw[i - 1];
    const cur = raw[i];
    if (prev.count > 0) {
      const dropPct = Math.round((1 - cur.count / prev.count) * 100);
      if (dropPct > 50) {
        dropOffInsights.push({
          icon: "⚠️",
          title: `${stageLabels[prev.stage] ?? prev.stage} → ${stageLabels[cur.stage] ?? cur.stage}`,
          detail: `${dropPct}% drop-off between stages (${prev.count} → ${cur.count})`,
        });
      }
    }
  }
  successResponse(res, { steps, dropOffInsights });
});

router.get("/metrics/failed-transactions", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const range = parseRange(req);
  const page = Math.max(1, parseInt(String(req.query["page"] ?? "1"), 10));
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query["limit"] ?? "20"), 10)));
  const { rows, total } = await getFailedTransactions(merchantId, range, page, limit);

  const transactions = rows.map((r) => ({
    date: r.createdAt ? new Date(r.createdAt).toLocaleDateString() : "",
    agent: r.agentPlatform ?? "unknown",
    product: r.sku ?? "N/A",
    error: r.eventType ?? "error",
    resolution: r.status === "error" ? "Pending" : "Resolved",
  }));

  const errorCounts: Record<string, number> = {};
  for (const r of rows) {
    const key = r.eventType ?? "unknown";
    errorCounts[key] = (errorCounts[key] ?? 0) + 1;
  }
  const breakdown = Object.entries(errorCounts)
    .map(([category, count]) => ({
      category,
      count,
      percentage: total > 0 ? Math.round((count / total) * 100) : 0,
    }))
    .sort((a, b) => b.count - a.count);

  const topError = breakdown[0]?.category ?? "None";

  successResponse(res, {
    transactions,
    summary: {
      total,
      successRate: "N/A",
      topError,
    },
    breakdown,
  });
});

export default router;
