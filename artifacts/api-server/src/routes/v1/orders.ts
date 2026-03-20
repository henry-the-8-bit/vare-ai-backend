import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { agentOrdersTable, agentCartsTable, agentConfigsTable } from "@workspace/db/schema";
import { eq, and, desc, sql } from "drizzle-orm";
import { requireAgentAuth } from "../../middlewares/auth.js";
import { successResponse, paginatedResponse, errorResponse } from "../../lib/response.js";
import { buildCart, injectOrder, cancelTestOrder } from "../../services/orderInjectionService.js";
import { z } from "zod/v4";

const router: IRouter = Router({ mergeParams: true });

function getParam(req: Request, key: string): string | undefined {
  const val = req.params[key];
  return Array.isArray(val) ? val[0] : val;
}

const cartItemSchema = z.object({
  sku: z.string().min(1),
  quantity: z.number().int().min(1).max(999),
  unitPrice: z.number().min(0).optional(),
  productTitle: z.string().optional(),
});

const createCartSchema = z.object({
  items: z.array(cartItemSchema).min(1).max(50),
  customerEmail: z.string().email().optional(),
  shippingMethod: z.string().optional(),
  paymentMethod: z.string().optional(),
  sessionId: z.string().optional(),
});

const checkoutSchema = z.object({
  customerEmail: z.string().email().optional(),
  shippingMethod: z.string().optional(),
  paymentMethod: z.string().optional(),
  shippingAddress: z.record(z.string(), z.unknown()).optional(),
  isTestOrder: z.boolean().optional(),
});

router.post("/cart", requireAgentAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const agentPlatform = req.agentPlatform ?? "api";

  const parsed = createCartSchema.safeParse(req.body);
  if (!parsed.success) {
    errorResponse(res, "Validation failed", "VALIDATION_ERROR", 400, parsed.error.issues);
    return;
  }

  const { items, customerEmail, shippingMethod, paymentMethod, sessionId } = parsed.data;

  const [agentCfg] = await db
    .select({ maxOrderValueCents: agentConfigsTable.maxOrderValueCents, testOrderEnabled: agentConfigsTable.testOrderEnabled })
    .from(agentConfigsTable)
    .where(eq(agentConfigsTable.merchantId, merchantId))
    .limit(1);

  const cart = await buildCart(merchantId, items, {
    agentPlatform,
    sessionId: sessionId ?? (req.headers["x-session-id"] as string | undefined),
    customerEmail,
    shippingMethod,
    paymentMethod,
  });

  if (agentCfg?.maxOrderValueCents && cart.total * 100 > agentCfg.maxOrderValueCents) {
    errorResponse(
      res,
      `Order total $${cart.total.toFixed(2)} exceeds merchant max order value of $${(agentCfg.maxOrderValueCents / 100).toFixed(2)}`,
      "MAX_ORDER_VALUE_EXCEEDED",
      422,
    );
    return;
  }

  successResponse(res, cart, 201);
});

router.post("/cart/:cart_id/checkout", requireAgentAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const agentPlatform = req.agentPlatform ?? "api";
  const cartId = getParam(req, "cart_id");

  if (!cartId) {
    errorResponse(res, "Cart ID is required", "VALIDATION_ERROR", 400);
    return;
  }

  const parsed = checkoutSchema.safeParse(req.body);
  if (!parsed.success) {
    errorResponse(res, "Validation failed", "VALIDATION_ERROR", 400, parsed.error.issues);
    return;
  }

  const { customerEmail, shippingMethod, paymentMethod, shippingAddress, isTestOrder } = parsed.data;

  const [agentCfg] = await db
    .select({ testOrderEnabled: agentConfigsTable.testOrderEnabled, requireCartConfirmation: agentConfigsTable.requireCartConfirmation })
    .from(agentConfigsTable)
    .where(eq(agentConfigsTable.merchantId, merchantId))
    .limit(1);

  const result = await injectOrder(merchantId, cartId, {
    agentPlatform,
    sessionId: req.headers["x-session-id"] as string | undefined,
    customerEmail,
    shippingMethod,
    paymentMethod,
    shippingAddress,
    isTestOrder: isTestOrder ?? agentCfg?.testOrderEnabled ?? true,
  });

  const statusCode = result.status === "failed" ? 500 : 201;
  successResponse(res, result, statusCode);
});

router.get("/orders", requireAgentAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10));
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? "20"), 10)));
  const offset = (page - 1) * limit;

  const orders = await db
    .select()
    .from(agentOrdersTable)
    .where(eq(agentOrdersTable.merchantId, merchantId))
    .orderBy(desc(agentOrdersTable.createdAt))
    .limit(limit)
    .offset(offset);

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(agentOrdersTable)
    .where(eq(agentOrdersTable.merchantId, merchantId));

  paginatedResponse(res, orders, Number(count), page, limit);
});

router.get("/orders/:order_id", requireAgentAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const orderId = getParam(req, "order_id");

  if (!orderId) {
    errorResponse(res, "Order ID is required", "VALIDATION_ERROR", 400);
    return;
  }

  const orders = await db
    .select()
    .from(agentOrdersTable)
    .where(and(eq(agentOrdersTable.merchantId, merchantId), eq(agentOrdersTable.magentoOrderId, orderId)));

  if (orders.length === 0) {
    errorResponse(res, "Order not found", "NOT_FOUND", 404);
    return;
  }

  successResponse(res, orders);
});

router.delete("/orders/:order_id", requireAgentAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const orderId = getParam(req, "order_id");

  if (!orderId) {
    errorResponse(res, "Order ID is required", "VALIDATION_ERROR", 400);
    return;
  }

  const result = await cancelTestOrder(merchantId, orderId);

  if (!result.cancelled) {
    errorResponse(res, result.message, "CANCEL_FAILED", 422);
    return;
  }

  successResponse(res, { message: result.message });
});

router.get("/carts/:cart_id", requireAgentAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const cartId = getParam(req, "cart_id");

  if (!cartId) {
    errorResponse(res, "Cart ID is required", "VALIDATION_ERROR", 400);
    return;
  }

  const [cart] = await db
    .select()
    .from(agentCartsTable)
    .where(and(eq(agentCartsTable.id, cartId), eq(agentCartsTable.merchantId, merchantId)))
    .limit(1);

  if (!cart) {
    errorResponse(res, "Cart not found", "NOT_FOUND", 404);
    return;
  }

  successResponse(res, cart);
});

export default router;
