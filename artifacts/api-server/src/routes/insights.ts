import { Router, type IRouter, type Request, type Response } from "express";
import { requireAuth } from "../middlewares/auth.js";
import { successResponse } from "../lib/response.js";
import { getOrGenerateInsights } from "../services/insightsService.js";
import { parseRange } from "../services/metricsService.js";

const router: IRouter = Router();

router.get("/insights", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const range = parseRange(req.query["range"]);
  const rows = await getOrGenerateInsights(merchantId, range);
  const typeToIcon: Record<string, string> = {
    revenue: "trending",
    growth_opportunity: "trending",
    conversion: "trophy",
    platform_mix: "trending",
    query_gap: "warning",
  };
  const data = rows.map((r) => ({
    type: typeToIcon[r.insightType ?? ""] ?? "warning",
    badge: r.badge ?? "",
    date: r.createdAt ? new Date(r.createdAt).toLocaleDateString() : "",
    text: r.text ?? "",
    action: r.actionLabel ?? "View Details",
  }));
  successResponse(res, data);
});

export default router;
