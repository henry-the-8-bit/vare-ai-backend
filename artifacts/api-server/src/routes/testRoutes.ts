import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  merchantsTable,
  normalizedProductsTable,
  agentQueriesTable,
  agentOrdersTable,
  agentConfigsTable,
  agentCartsTable,
  transactionEventsTable,
} from "@workspace/db/schema";
import { eq, and, ilike, or, desc, sql } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth.js";
import { successResponse, errorResponse } from "../lib/response.js";
import { buildCart, injectOrder } from "../services/orderInjectionService.js";
import { z } from "zod/v4";

const router: IRouter = Router();

router.post("/health", requireAuth, async (req: Request, res: Response) => {
  const checks: Record<string, unknown> = {};

  try {
    const result = await db.execute(sql`SELECT 1 AS db_ok`);
    checks["database"] = { status: "ok", result: result.rows[0] };
  } catch (err) {
    checks["database"] = { status: "error", error: String(err) };
    errorResponse(res, "Database health check failed", "DB_ERROR", 503, checks);
    return;
  }

  try {
    const count = await db
      .select({ count: sql<number>`count(*)` })
      .from(merchantsTable);
    checks["merchants_table"] = { status: "ok", count: count[0]?.count };
  } catch (err) {
    checks["merchants_table"] = { status: "error", error: String(err) };
  }

  checks["auth"] = { status: "ok", merchantId: req.merchantId };

  checks["env"] = {
    vare_api_secret: Boolean(process.env["VARE_API_SECRET"]),
    encryption_key: Boolean(process.env["ENCRYPTION_KEY"]),
    database_url: Boolean(process.env["DATABASE_URL"]),
  };

  successResponse(res, {
    status: "ok",
    checks,
    timestamp: new Date().toISOString(),
  });
});

const simulateQuerySchema = z.object({
  q: z.string().min(1),
  brand: z.string().optional(),
  category: z.string().optional(),
  limit: z.number().int().min(1).max(50).default(10),
  agentPlatform: z.string().default("test-simulator"),
  sessionId: z.string().optional(),
});

router.post("/simulate-agent-query", requireAuth, async (req: Request, res: Response) => {
  const startTime = Date.now();
  const merchantId = req.merchantId!;

  const parsed = simulateQuerySchema.safeParse(req.body);
  if (!parsed.success) {
    errorResponse(res, "Validation failed", "VALIDATION_ERROR", 400, parsed.error.issues);
    return;
  }

  const { q, brand, category, limit, agentPlatform, sessionId } = parsed.data;

  const conditions = [
    eq(normalizedProductsTable.merchantId, merchantId),
    or(
      eq(normalizedProductsTable.normalizationStatus, "normalized"),
      eq(normalizedProductsTable.normalizationStatus, "reviewed"),
    )!,
    or(
      ilike(normalizedProductsTable.productTitle, `%${q}%`),
      ilike(normalizedProductsTable.description, `%${q}%`),
      ilike(normalizedProductsTable.brand, `%${q}%`),
      ilike(normalizedProductsTable.sku, `%${q}%`),
    )!,
  ];

  if (brand) conditions.push(ilike(normalizedProductsTable.brand, `%${brand}%`));
  if (category) conditions.push(ilike(normalizedProductsTable.categoryPath, `%${category}%`));

  const products = await db
    .select({
      sku: normalizedProductsTable.sku,
      productTitle: normalizedProductsTable.productTitle,
      brand: normalizedProductsTable.brand,
      price: normalizedProductsTable.price,
      currency: normalizedProductsTable.currency,
      agentReadinessScore: normalizedProductsTable.agentReadinessScore,
      imageUrls: normalizedProductsTable.imageUrls,
    })
    .from(normalizedProductsTable)
    .where(and(...conditions))
    .orderBy(desc(normalizedProductsTable.agentReadinessScore))
    .limit(limit);

  const responseTimeMs = Date.now() - startTime;
  const matchedSkus = products.map((p) => p.sku);

  await Promise.all([
    db.insert(agentQueriesTable).values({
      merchantId,
      agentPlatform,
      queryText: q,
      matchedSkus,
      resultCount: products.length,
      wasMatched: products.length > 0,
      intentCluster: brand ? "brand_search" : category ? "category_browse" : "keyword_search",
      sessionId: sessionId ?? null,
      responseTimeMs,
    }),
    db.insert(transactionEventsTable).values({
      merchantId,
      agentPlatform,
      sessionId: sessionId ?? null,
      eventType: "catalog_search",
      status: "success",
      durationMs: responseTimeMs,
      metadata: { query: q, brand, category, resultCount: products.length, simulated: true },
    }),
  ]);

  successResponse(res, {
    query: q,
    filters: { brand, category },
    results: products,
    resultCount: products.length,
    responseTimeMs,
    agentPlatform,
    sessionId: sessionId ?? null,
    _note: "This is a simulated agent query for testing. Use /api/v1/merchants/:slug/catalog in production.",
  });
});

const simulateOrderSchema = z.object({
  items: z.array(z.object({
    sku: z.string().min(1),
    quantity: z.number().int().min(1).max(999),
  })).min(1).max(20),
  customerEmail: z.string().email().optional().default("test@vare.ai"),
  agentPlatform: z.string().default("test-simulator"),
  sessionId: z.string().optional(),
  dryRun: z.boolean().default(true),
});

router.post("/simulate-order", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;

  const parsed = simulateOrderSchema.safeParse(req.body);
  if (!parsed.success) {
    errorResponse(res, "Validation failed", "VALIDATION_ERROR", 400, parsed.error.issues);
    return;
  }

  const { items, customerEmail, agentPlatform, sessionId, dryRun } = parsed.data;

  const cart = await buildCart(merchantId, items, {
    agentPlatform,
    sessionId,
    customerEmail,
    shippingMethod: "flatrate_flatrate",
    paymentMethod: "vare_ai",
  });

  if (dryRun) {
    successResponse(res, {
      dryRun: true,
      cart,
      _note: "Dry run — no order placed. Set dryRun: false to place a test order.",
    });
    return;
  }

  const result = await injectOrder(merchantId, cart.cartId, {
    agentPlatform,
    sessionId,
    customerEmail,
    isTestOrder: true,
  });

  successResponse(res, {
    dryRun: false,
    cart,
    order: result,
    _note: "Test order injected with isTestOrder=true. Check agent_orders table for record.",
  });
});

router.get("/agent-orders", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const limit = Math.min(50, Math.max(1, parseInt(String(req.query.limit ?? "10"), 10)));

  const orders = await db
    .select()
    .from(agentOrdersTable)
    .where(eq(agentOrdersTable.merchantId, merchantId))
    .orderBy(desc(agentOrdersTable.createdAt))
    .limit(limit);

  successResponse(res, orders);
});

router.get("/agent-queries", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const limit = Math.min(50, Math.max(1, parseInt(String(req.query.limit ?? "10"), 10)));

  const queries = await db
    .select()
    .from(agentQueriesTable)
    .where(eq(agentQueriesTable.merchantId, merchantId))
    .orderBy(desc(agentQueriesTable.createdAt))
    .limit(limit);

  successResponse(res, queries);
});

export default router;
