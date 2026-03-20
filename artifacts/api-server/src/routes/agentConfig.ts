import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { merchantsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth.js";
import { successResponse, errorResponse } from "../lib/response.js";
import { generateApiKey } from "../lib/crypto.js";

const router: IRouter = Router();

router.post("/agent-config/generate-key", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;

  const [merchant] = await db
    .select()
    .from(merchantsTable)
    .where(eq(merchantsTable.id, merchantId))
    .limit(1);

  if (!merchant) {
    errorResponse(res, "Merchant not found", "NOT_FOUND", 404);
    return;
  }

  const rawMode = req.body?.mode;
  if (rawMode !== undefined && rawMode !== "live" && rawMode !== "test") {
    errorResponse(res, "Invalid mode. Must be 'live' or 'test'.", "VALIDATION_ERROR", 400);
    return;
  }
  const mode = rawMode === "live" ? "live" : "test";
  const newKey = generateApiKey(mode === "live" ? "vare_live_sk" : "vare_test_sk");

  const [updated] = await db
    .update(merchantsTable)
    .set({ apiKey: newKey, updatedAt: new Date() })
    .where(eq(merchantsTable.id, merchantId))
    .returning({ apiKey: merchantsTable.apiKey });

  successResponse(res, {
    apiKey: updated.apiKey,
    mode,
    message: "New API key generated. Store it securely — it will not be shown again.",
  });
});

export default router;
