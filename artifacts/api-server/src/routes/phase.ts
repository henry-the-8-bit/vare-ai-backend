import { Router, type IRouter, type Request, type Response } from "express";
import { requireAuth } from "../middlewares/auth.js";
import { successResponse, errorResponse } from "../lib/response.js";
import { computeOnboardingPhase, advanceOnboardingPhase } from "../services/phaseService.js";

const router: IRouter = Router();

router.get("/phase", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;

  try {
    const result = await computeOnboardingPhase(merchantId);

    await advanceOnboardingPhase(merchantId);

    successResponse(res, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    errorResponse(res, message, "PHASE_ERROR", 500);
  }
});

export default router;
