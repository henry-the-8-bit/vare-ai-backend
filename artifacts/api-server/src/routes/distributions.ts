import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod/v4";
import { requireAuth } from "../middlewares/auth.js";
import { successResponse, errorResponse } from "../lib/response.js";
import { distributionService } from "../services/distribution/distributionService.js";
import type { DistributionPlatform, MerchantDistributionConfig } from "../services/distribution/types.js";

const router: IRouter = Router();

const toggleSchema = z.object({
  platform: z.enum(["chatgpt", "gemini", "perplexity"]),
  enabled: z.boolean(),
  config: z.object({
    minReadinessScore: z.number().min(0).max(100).optional(),
    includeFitment: z.boolean().optional(),
    includeInventory: z.boolean().optional(),
    categoryFilter: z.array(z.string()).optional(),
  }).optional(),
});

const updateConfigSchema = z.object({
  platform: z.enum(["chatgpt", "gemini", "perplexity"]),
  config: z.object({
    minReadinessScore: z.number().min(0).max(100).optional(),
    includeFitment: z.boolean().optional(),
    includeInventory: z.boolean().optional(),
    categoryFilter: z.array(z.string()).optional(),
  }),
});

// GET /api/distributions/platforms — list available platforms with metadata
router.get("/distributions/platforms", requireAuth, async (_req: Request, res: Response) => {
  const platforms = distributionService.getPlatformMetadata();
  successResponse(res, platforms);
});

// GET /api/distributions — list merchant's distribution preferences for all platforms
router.get("/distributions", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const distributions = await distributionService.listDistributions(merchantId);
  successResponse(res, distributions);
});

// POST /api/distributions/toggle — enable/disable a platform for this merchant
router.post("/distributions/toggle", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const parsed = toggleSchema.safeParse(req.body);

  if (!parsed.success) {
    errorResponse(res, "Validation error", "VALIDATION_ERROR", 400, parsed.error.issues);
    return;
  }

  try {
    const result = await distributionService.togglePlatform(
      merchantId,
      parsed.data.platform as DistributionPlatform,
      parsed.data.enabled,
      parsed.data.config as MerchantDistributionConfig | undefined,
    );
    successResponse(res, result);
  } catch (err) {
    errorResponse(res, String(err), "TOGGLE_FAILED", 400);
  }
});

// PATCH /api/distributions/config — update platform-specific config
router.patch("/distributions/config", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const parsed = updateConfigSchema.safeParse(req.body);

  if (!parsed.success) {
    errorResponse(res, "Validation error", "VALIDATION_ERROR", 400, parsed.error.issues);
    return;
  }

  try {
    const result = await distributionService.updateConfig(
      merchantId,
      parsed.data.platform as DistributionPlatform,
      parsed.data.config as MerchantDistributionConfig,
    );
    successResponse(res, result);
  } catch (err) {
    errorResponse(res, String(err), "UPDATE_FAILED", 400);
  }
});

// GET /api/distributions/spec/:platform — get the Vare-wide platform spec (public info)
router.get("/distributions/spec/:platform", requireAuth, async (req: Request, res: Response) => {
  const platform = (Array.isArray(req.params["platform"]) ? req.params["platform"][0] : req.params["platform"]) as string;

  try {
    const spec = distributionService.getSpec(platform as DistributionPlatform);
    successResponse(res, spec);
  } catch (err) {
    errorResponse(res, String(err), "SPEC_NOT_FOUND", 404);
  }
});

export default router;
