import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { merchantsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { z } from "zod/v4";
import { requireAuth } from "../middlewares/auth.js";
import { successResponse, errorResponse } from "../lib/response.js";
import { generateApiKey } from "../lib/crypto.js";

const router: IRouter = Router();

const createMerchantSchema = z.object({
  companyName: z.string().min(1),
  contactFirstName: z.string().optional(),
  contactLastName: z.string().optional(),
  contactEmail: z.string().email(),
  contactPhone: z.string().optional(),
  estimatedSkuCount: z.string().optional(),
  primaryVertical: z.string().optional(),
  magentoVersion: z.string().optional(),
  hostingEnvironment: z.string().optional(),
  erpSystem: z.string().optional(),
  pimSystem: z.string().optional(),
  sandboxMode: z.boolean().optional().default(true),
});

const updateMerchantSchema = createMerchantSchema.partial();

function computeComplexityScore(merchant: {
  magentoVersion?: string | null;
  erpSystem?: string | null;
  pimSystem?: string | null;
  estimatedSkuCount?: string | null;
}): number {
  let score = 0;

  if (
    merchant.magentoVersion &&
    (merchant.magentoVersion.toLowerCase().includes("enterprise") ||
      merchant.magentoVersion.toLowerCase().includes("commerce"))
  ) {
    score += 1;
  }

  if (merchant.erpSystem && merchant.erpSystem.toLowerCase() !== "none") {
    score += 1;
  }

  if (merchant.pimSystem && merchant.pimSystem.toLowerCase() !== "none") {
    score += 1;
  }

  const skuCount = merchant.estimatedSkuCount ?? "";
  if (skuCount.includes("100,000") || skuCount.includes("500,000") || skuCount.includes("1M+")) {
    score += 1;
  }

  return Math.min(score, 4);
}

function getParam(req: Request, key: string): string {
  const val = req.params[key];
  return Array.isArray(val) ? val[0] : (val ?? "");
}

router.post("/merchant", async (req: Request, res: Response) => {
  const parsed = createMerchantSchema.safeParse(req.body);
  if (!parsed.success) {
    errorResponse(res, "Validation failed", "VALIDATION_ERROR", 400, parsed.error.flatten());
    return;
  }

  const data = parsed.data;
  const complexityScore = computeComplexityScore(data);
  const apiKey = generateApiKey(data.sandboxMode ? "vare_test_sk" : "vare_live_sk");

  const [merchant] = await db
    .insert(merchantsTable)
    .values({
      companyName: data.companyName,
      contactFirstName: data.contactFirstName,
      contactLastName: data.contactLastName,
      contactEmail: data.contactEmail,
      contactPhone: data.contactPhone,
      estimatedSkuCount: data.estimatedSkuCount,
      primaryVertical: data.primaryVertical,
      magentoVersion: data.magentoVersion,
      hostingEnvironment: data.hostingEnvironment,
      erpSystem: data.erpSystem,
      pimSystem: data.pimSystem,
      complexityScore,
      sandboxMode: data.sandboxMode,
      apiKey,
    })
    .returning();

  successResponse(res, merchant, 201);
});

router.get("/merchant/:id", requireAuth, async (req: Request, res: Response) => {
  const id = getParam(req, "id");

  const [merchant] = await db
    .select()
    .from(merchantsTable)
    .where(eq(merchantsTable.id, id))
    .limit(1);

  if (!merchant) {
    errorResponse(res, "Merchant not found", "NOT_FOUND", 404);
    return;
  }

  if (merchant.id !== req.merchantId) {
    errorResponse(res, "Forbidden", "FORBIDDEN", 403);
    return;
  }

  successResponse(res, merchant);
});

router.patch("/merchant/:id", requireAuth, async (req: Request, res: Response) => {
  const id = getParam(req, "id");

  if (id !== req.merchantId) {
    errorResponse(res, "Forbidden", "FORBIDDEN", 403);
    return;
  }

  const parsed = updateMerchantSchema.safeParse(req.body);
  if (!parsed.success) {
    errorResponse(res, "Validation failed", "VALIDATION_ERROR", 400, parsed.error.flatten());
    return;
  }

  const data = parsed.data;

  const [existing] = await db
    .select()
    .from(merchantsTable)
    .where(eq(merchantsTable.id, id))
    .limit(1);

  if (!existing) {
    errorResponse(res, "Merchant not found", "NOT_FOUND", 404);
    return;
  }

  const merged = { ...existing, ...data };
  const complexityScore = computeComplexityScore(merged);

  const [updated] = await db
    .update(merchantsTable)
    .set({
      ...data,
      complexityScore,
      updatedAt: new Date(),
    })
    .where(eq(merchantsTable.id, id))
    .returning();

  successResponse(res, updated);
});

router.get("/merchant/:id/complexity", requireAuth, async (req: Request, res: Response) => {
  const id = getParam(req, "id");

  if (id !== req.merchantId) {
    errorResponse(res, "Forbidden", "FORBIDDEN", 403);
    return;
  }

  const [merchant] = await db
    .select()
    .from(merchantsTable)
    .where(eq(merchantsTable.id, id))
    .limit(1);

  if (!merchant) {
    errorResponse(res, "Merchant not found", "NOT_FOUND", 404);
    return;
  }

  const score = computeComplexityScore(merchant);

  let label: string;
  if (score === 0) label = "Simple";
  else if (score === 1) label = "Standard";
  else if (score === 2) label = "Moderate";
  else if (score === 3) label = "Complex";
  else label = "Enterprise";

  successResponse(res, {
    merchantId: id,
    complexityScore: score,
    label,
    factors: {
      hasEnterpriseEdition:
        merchant.magentoVersion?.toLowerCase().includes("enterprise") ||
        merchant.magentoVersion?.toLowerCase().includes("commerce"),
      hasErp: Boolean(merchant.erpSystem && merchant.erpSystem.toLowerCase() !== "none"),
      hasPim: Boolean(merchant.pimSystem && merchant.pimSystem.toLowerCase() !== "none"),
      largeSkuCount:
        (merchant.estimatedSkuCount ?? "").includes("100,000") ||
        (merchant.estimatedSkuCount ?? "").includes("500,000") ||
        (merchant.estimatedSkuCount ?? "").includes("1M+"),
    },
  });
});

export default router;
