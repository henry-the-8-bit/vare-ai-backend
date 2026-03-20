import { Router, type IRouter, type Request, type Response } from "express";
import { requireAuth } from "../middlewares/auth.js";
import { successResponse } from "../lib/response.js";
import { runHealthScan } from "../services/healthScanService.js";

const router: IRouter = Router();

router.get("/health-scan", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const result = await runHealthScan(merchantId);
  successResponse(res, result);
});

export default router;
