import { Router, type IRouter, type Request, type Response } from "express";
import { requireAuth } from "../middlewares/auth.js";
import { successResponse } from "../lib/response.js";
import { getOrGenerateInsights } from "../services/insightsService.js";
import type { DateRange } from "../services/metricsService.js";

const router: IRouter = Router();

router.get("/insights", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const range = (req.query["range"] as DateRange) ?? "30d";
  const data = await getOrGenerateInsights(merchantId, range);
  successResponse(res, data);
});

export default router;
