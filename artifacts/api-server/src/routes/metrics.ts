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
  const data = await getTopProducts(merchantId, range, limit);
  successResponse(res, data);
});

router.get("/metrics/query-intents", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const range = parseRange(req);
  const data = await getQueryIntents(merchantId, range);
  successResponse(res, data);
});

router.get("/metrics/unmatched-queries", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const range = parseRange(req);
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query["limit"] ?? "20"), 10)));
  const data = await getUnmatchedQueries(merchantId, range, limit);
  successResponse(res, data);
});

router.get("/metrics/conversion-funnel", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const range = parseRange(req);
  const data = await getConversionFunnel(merchantId, range);
  successResponse(res, data);
});

router.get("/metrics/failed-transactions", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const range = parseRange(req);
  const page = Math.max(1, parseInt(String(req.query["page"] ?? "1"), 10));
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query["limit"] ?? "20"), 10)));
  const { rows, total } = await getFailedTransactions(merchantId, range, page, limit);
  paginatedResponse(res, rows, total, page, limit);
});

export default router;
