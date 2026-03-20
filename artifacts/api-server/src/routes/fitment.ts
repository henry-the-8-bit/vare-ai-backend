import { Router, type IRouter, type Request, type Response } from "express";
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
