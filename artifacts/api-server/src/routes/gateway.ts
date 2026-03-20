import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { merchantsTable, agentConfigsTable, agentOrdersTable } from "@workspace/db/schema";
import { eq, and, or } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth.js";
import { successResponse, errorResponse } from "../lib/response.js";
import { buildCart, injectOrder, cancelTestOrder } from "../services/orderInjectionService.js";
import { z } from "zod/v4";

const router: IRouter = Router();

const configureSchema = z.object({
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

router.post("/gateway/configure", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const parsed = configureSchema.safeParse(req.body);
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

const testOrderSchema = z.object({
  items: z.array(z.object({
    sku: z.string().min(1),
    quantity: z.number().int().min(1).max(10),
    unitPrice: z.number().min(0).optional().default(0),
    productTitle: z.string().optional(),
  })).min(1).max(5).optional().default([{ sku: "vare-test-sku-001", quantity: 1, unitPrice: 0 }]),
  customerEmail: z.string().email().optional().default("test@vare.ai"),
});

router.post("/gateway/test-order", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const parsed = testOrderSchema.safeParse(req.body);
  if (!parsed.success) {
    errorResponse(res, "Validation failed", "VALIDATION_ERROR", 400, parsed.error.issues);
    return;
  }

  const { items, customerEmail } = parsed.data;

  const cart = await buildCart(merchantId, items, {
    agentPlatform: "gateway-test",
    customerEmail,
    shippingMethod: "flatrate_flatrate",
    paymentMethod: "vare_ai",
    sessionId: `gateway-test-${Date.now()}`,
  });

  const result = await injectOrder(merchantId, cart.cartId, {
    agentPlatform: "gateway-test",
    customerEmail,
    isTestOrder: true,
  });

  successResponse(res, {
    test_order_id: result.orderId,
    cart_id: cart.cartId,
    status: result.status,
    confirmation: result.confirmation,
    items: result.items,
    total: result.total,
    is_test_order: true,
    _note: "This is a gateway test order. Use DELETE /gateway/test-order/:id to cancel.",
  });
});

router.delete("/gateway/test-order/:order_id", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const orderId = Array.isArray(req.params["order_id"]) ? req.params["order_id"][0] : req.params["order_id"];

  if (!orderId) {
    errorResponse(res, "Order ID is required", "VALIDATION_ERROR", 400);
    return;
  }

  const [targetOrder] = await db
    .select()
    .from(agentOrdersTable)
    .where(
      and(
        eq(agentOrdersTable.merchantId, merchantId),
        eq(agentOrdersTable.agentPlatform, "gateway-test"),
        or(
          eq(agentOrdersTable.agentOrderRef, orderId),
          eq(agentOrdersTable.magentoOrderId, orderId),
        ),
      ),
    )
    .limit(1);

  if (!targetOrder) {
    errorResponse(res, "Test order not found or cannot be cancelled", "NOT_FOUND", 404);
    return;
  }

  const refToCancel = targetOrder.agentOrderRef ?? targetOrder.magentoOrderId ?? orderId;
  const result = await cancelTestOrder(merchantId, refToCancel);

  successResponse(res, { message: result.message, cancelled: result.cancelled });
});

export default router;
