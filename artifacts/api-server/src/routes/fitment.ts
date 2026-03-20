import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { fitmentConfigsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { z } from "zod/v4";
import { requireAuth } from "../middlewares/auth.js";
import { successResponse, errorResponse } from "../lib/response.js";
import {
  assessFitment,
  extractFitmentFromDescriptions,
  applyFitmentData,
} from "../services/fitmentService.js";

const router: IRouter = Router();

router.get("/fitment/assess", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const assessment = await assessFitment(merchantId);
  successResponse(res, assessment);
});

const fitmentSourceSchema = z.object({
  source: z.enum(["description_text", "structured_fields", "mpn_cross"]),
  fields: z.array(z.string()).optional(),
  enabled: z.boolean().default(true),
});

router.post("/fitment/sources", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;

  const parsed = fitmentSourceSchema.safeParse(req.body);
  if (!parsed.success) {
    errorResponse(res, "Validation failed", "VALIDATION_ERROR", 400, parsed.error.flatten());
    return;
  }

  const [existing] = await db
    .select({ id: fitmentConfigsTable.id })
    .from(fitmentConfigsTable)
    .where(eq(fitmentConfigsTable.merchantId, merchantId))
    .limit(1);

  let config;
  if (existing) {
    const [updated] = await db
      .update(fitmentConfigsTable)
      .set({
        source: parsed.data.source,
        fields: parsed.data.fields ?? [],
        enabled: parsed.data.enabled,
        updatedAt: new Date(),
      })
      .where(eq(fitmentConfigsTable.merchantId, merchantId))
      .returning();
    config = updated;
  } else {
    const [inserted] = await db
      .insert(fitmentConfigsTable)
      .values({
        merchantId,
        source: parsed.data.source,
        fields: parsed.data.fields ?? [],
        enabled: parsed.data.enabled,
      })
      .returning();
    config = inserted;
  }

  successResponse(res, { ...config, message: "Fitment source configuration saved" });
});

router.get("/fitment/sources", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;

  const [config] = await db
    .select()
    .from(fitmentConfigsTable)
    .where(eq(fitmentConfigsTable.merchantId, merchantId))
    .limit(1);

  if (!config) {
    successResponse(res, { source: "description_text", fields: [], enabled: true, configured: false });
    return;
  }

  successResponse(res, { ...config, configured: true });
});

const previewFitmentSchema = z.object({
  skus: z.array(z.string()).optional(),
  limit: z.number().int().min(1).max(50).optional().default(10),
});

router.post("/fitment/preview", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;

  const parsed = previewFitmentSchema.safeParse(req.body);
  if (!parsed.success) {
    errorResponse(res, "Validation failed", "VALIDATION_ERROR", 400, parsed.error.flatten());
    return;
  }

  const skusToCheck = parsed.data.skus;
  const results = await extractFitmentFromDescriptions(merchantId, skusToCheck);
  const limited = results.slice(0, parsed.data.limit ?? 10);

  successResponse(res, {
    total: results.length,
    previewed: limited.length,
    withFitment: limited.filter((r) => r.fitmentData !== null).length,
    withoutFitment: limited.filter((r) => r.fitmentData === null).length,
    results: limited,
  });
});

const applyFitmentSchema = z.object({
  skus: z.array(z.string()).optional(),
  applyAll: z.boolean().optional().default(false),
});

router.post("/fitment/apply", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;

  const parsed = applyFitmentSchema.safeParse(req.body);
  if (!parsed.success) {
    errorResponse(res, "Validation failed", "VALIDATION_ERROR", 400, parsed.error.flatten());
    return;
  }

  const results = await extractFitmentFromDescriptions(merchantId, parsed.data.skus);
  const applied = await applyFitmentData(merchantId, results);

  successResponse(res, {
    extracted: results.length,
    withFitment: results.filter((r) => r.fitmentData !== null).length,
    applied: applied.updated,
    skipped: applied.skipped,
    message: `Fitment data applied to ${applied.updated} products`,
  });
});

const extractFitmentSchema = z.object({
  skus: z.array(z.string()).optional(),
  applyToNormalized: z.boolean().optional().default(false),
});

router.post("/fitment/extract", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;

  const parsed = extractFitmentSchema.safeParse(req.body);
  if (!parsed.success) {
    errorResponse(res, "Validation failed", "VALIDATION_ERROR", 400, parsed.error.flatten());
    return;
  }

  const results = await extractFitmentFromDescriptions(merchantId, parsed.data.skus);

  let applied: { updated: number; skipped: number } | null = null;
  if (parsed.data.applyToNormalized) {
    applied = await applyFitmentData(merchantId, results);
  }

  successResponse(res, {
    extracted: results.length,
    withFitment: results.filter((r) => r.fitmentData !== null).length,
    withoutFitment: results.filter((r) => r.fitmentData === null).length,
    results: results.slice(0, 20),
    applied,
  });
});

export default router;
