import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { merchantsTable, agentConfigsTable } from "@workspace/db/schema";
import { eq, and } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth.js";
import { successResponse, errorResponse } from "../lib/response.js";
import { generateApiKey } from "../lib/crypto.js";
import { z } from "zod/v4";

const router: IRouter = Router();

router.get("/agent-config", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;

  const [merchant] = await db
    .select({ id: merchantsTable.id, slug: merchantsTable.slug, apiKey: merchantsTable.apiKey, isLive: merchantsTable.isLive, sandboxMode: merchantsTable.sandboxMode })
    .from(merchantsTable)
    .where(eq(merchantsTable.id, merchantId))
    .limit(1);

  if (!merchant) {
    errorResponse(res, "Merchant not found", "NOT_FOUND", 404);
    return;
  }

  const [agentCfg] = await db
    .select()
    .from(agentConfigsTable)
    .where(eq(agentConfigsTable.merchantId, merchantId))
    .limit(1);

  successResponse(res, {
    slug: merchant.slug,
    apiKeyHint: merchant.apiKey ? `${merchant.apiKey.slice(0, 16)}…` : null,
    isLive: merchant.isLive,
    sandboxMode: merchant.sandboxMode,
    agentConfig: agentCfg ?? null,
  });
});

const agentConfigPatchSchema = z.object({
  allowedPlatforms: z.array(z.string()).optional(),
  rateLimitPerMinute: z.number().int().min(1).max(600).optional(),
  requireCartConfirmation: z.boolean().optional(),
  maxOrderValueCents: z.number().int().min(0).optional().nullable(),
  defaultShippingMethod: z.string().optional(),
  defaultPaymentMethod: z.string().optional(),
  testOrderEnabled: z.boolean().optional(),
  webhookUrl: z.string().url().optional().nullable(),
  enabledCapabilities: z.array(z.string()).optional(),
});

router.patch("/agent-config", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const parsed = agentConfigPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    errorResponse(res, "Validation failed", "VALIDATION_ERROR", 400, parsed.error.issues);
    return;
  }

  const data = parsed.data;

  const [existing] = await db
    .select({ id: agentConfigsTable.id })
    .from(agentConfigsTable)
    .where(eq(agentConfigsTable.merchantId, merchantId))
    .limit(1);

  let config;
  if (existing) {
    [config] = await db
      .update(agentConfigsTable)
      .set({
        ...(data.allowedPlatforms !== undefined && { allowedPlatforms: data.allowedPlatforms }),
        ...(data.rateLimitPerMinute !== undefined && { rateLimitPerMinute: data.rateLimitPerMinute }),
        ...(data.requireCartConfirmation !== undefined && { requireCartConfirmation: data.requireCartConfirmation }),
        ...(data.maxOrderValueCents !== undefined && { maxOrderValueCents: data.maxOrderValueCents }),
        ...(data.defaultShippingMethod !== undefined && { defaultShippingMethod: data.defaultShippingMethod }),
        ...(data.defaultPaymentMethod !== undefined && { defaultPaymentMethod: data.defaultPaymentMethod }),
        ...(data.testOrderEnabled !== undefined && { testOrderEnabled: data.testOrderEnabled }),
        ...(data.webhookUrl !== undefined && { webhookUrl: data.webhookUrl }),
        ...(data.enabledCapabilities !== undefined && { enabledCapabilities: data.enabledCapabilities }),
        updatedAt: new Date(),
      })
      .where(eq(agentConfigsTable.merchantId, merchantId))
      .returning();
  } else {
    [config] = await db
      .insert(agentConfigsTable)
      .values({
        merchantId,
        allowedPlatforms: data.allowedPlatforms ?? null,
        rateLimitPerMinute: data.rateLimitPerMinute ?? 60,
        requireCartConfirmation: data.requireCartConfirmation ?? false,
        maxOrderValueCents: data.maxOrderValueCents ?? null,
        defaultShippingMethod: data.defaultShippingMethod ?? "flatrate_flatrate",
        defaultPaymentMethod: data.defaultPaymentMethod ?? "vare_ai",
        testOrderEnabled: data.testOrderEnabled ?? true,
        webhookUrl: data.webhookUrl ?? null,
        enabledCapabilities: data.enabledCapabilities ?? null,
      })
      .returning();
  }

  successResponse(res, config);
});

const slugSchema = z.object({
  slug: z.string().min(3).max(100).regex(/^[a-z0-9-]+$/, "Slug must be lowercase letters, numbers, and hyphens only"),
});

router.post("/agent-config/set-slug", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const parsed = slugSchema.safeParse(req.body);
  if (!parsed.success) {
    errorResponse(res, "Validation failed", "VALIDATION_ERROR", 400, parsed.error.issues);
    return;
  }

  const { slug } = parsed.data;

  const [existing] = await db
    .select({ id: merchantsTable.id })
    .from(merchantsTable)
    .where(eq(merchantsTable.slug, slug))
    .limit(1);

  if (existing && existing.id !== merchantId) {
    errorResponse(res, "Slug already taken by another merchant", "CONFLICT", 409);
    return;
  }

  const [updated] = await db
    .update(merchantsTable)
    .set({ slug, updatedAt: new Date() })
    .where(eq(merchantsTable.id, merchantId))
    .returning({ slug: merchantsTable.slug });

  successResponse(res, { slug: updated.slug });
});

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

router.post("/agent-config/activate", requireAuth, async (req: Request, res: Response) => {
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

  if (!merchant.apiKey) {
    errorResponse(res, "Generate an API key before activating", "PRECONDITION_FAILED", 400);
    return;
  }

  if (!merchant.slug) {
    errorResponse(res, "Set a merchant slug before activating", "PRECONDITION_FAILED", 400);
    return;
  }

  const [updated] = await db
    .update(merchantsTable)
    .set({ isLive: true, sandboxMode: false, onboardingStatus: "complete", updatedAt: new Date() })
    .where(eq(merchantsTable.id, merchantId))
    .returning({
      isLive: merchantsTable.isLive,
      sandboxMode: merchantsTable.sandboxMode,
      onboardingStatus: merchantsTable.onboardingStatus,
      slug: merchantsTable.slug,
    });

  successResponse(res, {
    activated: true,
    isLive: updated.isLive,
    sandboxMode: updated.sandboxMode,
    slug: updated.slug,
    message: `Merchant is now live. Agents can reach your catalog at /api/v1/merchants/${updated.slug}/catalog`,
  });
});

router.post("/agent-config/review", requireAuth, async (req: Request, res: Response) => {
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

  const [agentCfg] = await db
    .select()
    .from(agentConfigsTable)
    .where(eq(agentConfigsTable.merchantId, merchantId))
    .limit(1);

  const checks = {
    hasApiKey: !!merchant.apiKey,
    hasSlug: !!merchant.slug,
    isLive: merchant.isLive,
    sandboxMode: merchant.sandboxMode,
    agentConfigured: !!agentCfg,
    orderCapability: agentCfg?.enabledCapabilities
      ? (agentCfg.enabledCapabilities as string[]).includes("order")
      : false,
    rateLimitPerMinute: agentCfg?.rateLimitPerMinute ?? 60,
    requireCartConfirmation: agentCfg?.requireCartConfirmation ?? false,
    maxOrderValueCents: agentCfg?.maxOrderValueCents ?? null,
  };

  const readyToActivate = checks.hasApiKey && checks.hasSlug && checks.agentConfigured;

  successResponse(res, {
    checks,
    readyToActivate,
    catalogEndpoint: merchant.slug ? `/api/v1/merchants/${merchant.slug}/catalog` : null,
    message: readyToActivate
      ? "All checks passed. Call POST /agent-config/activate to go live."
      : "Some configuration is missing. Review the checks above.",
  });
});

export default router;
