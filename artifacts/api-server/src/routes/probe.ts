import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod/v4";
import { requireAuth } from "../middlewares/auth.js";
import { successResponse, errorResponse } from "../lib/response.js";
import {
  probeSingleSku,
  probeBatchSkus,
  saveProbeConfig,
  getProbeResults,
} from "../services/inventoryProbeService.js";

const router: IRouter = Router();

function getParam(req: Request, key: string): string | undefined {
  const val = req.params[key];
  return Array.isArray(val) ? val[0] : val;
}

const probeConfigSchema = z.object({
  inventorySource: z.enum(["magento", "csv", "api"]).optional(),
  probeFrequency: z.enum(["realtime", "cached", "scheduled"]).optional(),
  cacheTtlMinutes: z.number().int().min(1).max(1440).optional(),
  fallbackBehavior: z.enum(["last_known", "assume_in_stock", "assume_out_of_stock"]).optional(),
  lowStockThreshold: z.number().int().min(0).optional(),
});

router.post("/probe/configure", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;

  const parsed = probeConfigSchema.safeParse(req.body);
  if (!parsed.success) {
    errorResponse(res, "Validation failed", "VALIDATION_ERROR", 400, parsed.error.flatten());
    return;
  }

  const config = await saveProbeConfig(merchantId, parsed.data);
  successResponse(res, config);
});

router.post("/probe/config", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;

  const parsed = probeConfigSchema.safeParse(req.body);
  if (!parsed.success) {
    errorResponse(res, "Validation failed", "VALIDATION_ERROR", 400, parsed.error.flatten());
    return;
  }

  const config = await saveProbeConfig(merchantId, parsed.data);
  successResponse(res, config);
});

const testProbeSchema = z.object({
  skus: z.array(z.string()).min(1).max(5).default(["TEST-SKU-001"]),
});

router.post("/probe/test", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;

  const parsed = testProbeSchema.safeParse(req.body);
  if (!parsed.success) {
    errorResponse(res, "Validation failed", "VALIDATION_ERROR", 400, parsed.error.flatten());
    return;
  }

  const start = Date.now();
  const results = await probeBatchSkus(merchantId, parsed.data.skus);
  const totalLatencyMs = Date.now() - start;

  const hasErrors = results.some((r) => r.error);
  const allFromFallback = results.every((r) => r.source.startsWith("fallback"));

  successResponse(res, {
    connectionOk: !allFromFallback,
    totalLatencyMs,
    results,
    warnings: allFromFallback ? ["No Magento connection found; all results from fallback"] : [],
    errors: hasErrors ? results.filter((r) => r.error).map((r) => ({ sku: r.sku, error: r.error })) : [],
  });
});

const batchProbeSchema = z.object({
  skus: z.array(z.string()).min(1).max(100),
});

router.post("/probe/batch", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;

  const parsed = batchProbeSchema.safeParse(req.body);
  if (!parsed.success) {
    errorResponse(res, "Validation failed", "VALIDATION_ERROR", 400, parsed.error.flatten());
    return;
  }

  const results = await probeBatchSkus(merchantId, parsed.data.skus);
  const inStock = results.filter((r) => r.isInStock === true).length;
  const outOfStock = results.filter((r) => r.isInStock === false).length;
  const unknown = results.filter((r) => r.isInStock === null).length;

  successResponse(res, { total: results.length, inStock, outOfStock, unknown, results });
});

router.get("/probe/results", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const skus = req.query["skus"] ? String(req.query["skus"]).split(",") : undefined;
  const results = await getProbeResults(merchantId, skus);
  successResponse(res, { count: results.length, results });
});

router.get("/probe/:sku", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const sku = getParam(req, "sku");

  if (!sku) {
    errorResponse(res, "sku is required", "VALIDATION_ERROR", 400);
    return;
  }

  const result = await probeSingleSku(merchantId, sku);
  successResponse(res, result);
});

export default router;
