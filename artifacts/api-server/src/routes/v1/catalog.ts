import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  normalizedProductsTable,
  agentQueriesTable,
  transactionEventsTable,
  inventoryTable,
} from "@workspace/db/schema";
import { eq, and, ilike, or, gte, lte, desc, sql } from "drizzle-orm";
import { requireAgentAuth } from "../../middlewares/auth.js";
import { successResponse, paginatedResponse, errorResponse } from "../../lib/response.js";
import { z } from "zod/v4";

const router: IRouter = Router({ mergeParams: true });

function getParam(req: Request, key: string): string | undefined {
  const val = req.params[key];
  return Array.isArray(val) ? val[0] : val;
}

const catalogSearchSchema = z.object({
  q: z.string().optional(),
  brand: z.string().optional(),
  category: z.string().optional(),
  sku: z.string().optional(),
  mpn: z.string().optional(),
  color: z.string().optional(),
  minPrice: z.coerce.number().optional(),
  maxPrice: z.coerce.number().optional(),
  normalizationStatus: z.enum(["pending", "normalized", "reviewed", "failed"]).optional(),
  inStockOnly: z.coerce.boolean().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

router.get("/catalog", requireAgentAuth, async (req: Request, res: Response) => {
  const startTime = Date.now();
  const merchantId = req.merchantId!;
  const agentPlatform = req.agentPlatform ?? "api";

  const parsed = catalogSearchSchema.safeParse(req.query);
  if (!parsed.success) {
    errorResponse(res, "Invalid query parameters", "VALIDATION_ERROR", 400, parsed.error.issues);
    return;
  }

  const { q, brand, category, sku, mpn, color, minPrice, maxPrice, normalizationStatus, inStockOnly, page, limit } = parsed.data;

  const conditions = [eq(normalizedProductsTable.merchantId, merchantId)];

  if (normalizationStatus) {
    conditions.push(eq(normalizedProductsTable.normalizationStatus, normalizationStatus));
  } else {
    conditions.push(
      or(
        eq(normalizedProductsTable.normalizationStatus, "normalized"),
        eq(normalizedProductsTable.normalizationStatus, "reviewed"),
      )!,
    );
  }

  if (q) {
    conditions.push(
      or(
        ilike(normalizedProductsTable.productTitle, `%${q}%`),
        ilike(normalizedProductsTable.description, `%${q}%`),
        ilike(normalizedProductsTable.brand, `%${q}%`),
        ilike(normalizedProductsTable.sku, `%${q}%`),
        ilike(normalizedProductsTable.mpn, `%${q}%`),
      )!,
    );
  }

  if (brand) conditions.push(ilike(normalizedProductsTable.brand, `%${brand}%`));
  if (category) conditions.push(ilike(normalizedProductsTable.categoryPath, `%${category}%`));
  if (sku) conditions.push(ilike(normalizedProductsTable.sku, `%${sku}%`));
  if (mpn) conditions.push(ilike(normalizedProductsTable.mpn, `%${mpn}%`));
  if (color) conditions.push(ilike(normalizedProductsTable.color, `%${color}%`));
  if (minPrice !== undefined) conditions.push(gte(normalizedProductsTable.price, String(minPrice)));
  if (maxPrice !== undefined) conditions.push(lte(normalizedProductsTable.price, String(maxPrice)));

  const whereClause = and(...conditions);

  const offset = (page - 1) * limit;

  const [countResult, products] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)` })
      .from(normalizedProductsTable)
      .where(whereClause),
    db
      .select({
        id: normalizedProductsTable.id,
        sku: normalizedProductsTable.sku,
        productTitle: normalizedProductsTable.productTitle,
        brand: normalizedProductsTable.brand,
        manufacturer: normalizedProductsTable.manufacturer,
        mpn: normalizedProductsTable.mpn,
        upc: normalizedProductsTable.upc,
        price: normalizedProductsTable.price,
        currency: normalizedProductsTable.currency,
        color: normalizedProductsTable.color,
        finish: normalizedProductsTable.finish,
        categoryPath: normalizedProductsTable.categoryPath,
        imageUrls: normalizedProductsTable.imageUrls,
        agentReadinessScore: normalizedProductsTable.agentReadinessScore,
        normalizationStatus: normalizedProductsTable.normalizationStatus,
        fitmentData: normalizedProductsTable.fitmentData,
      })
      .from(normalizedProductsTable)
      .where(whereClause)
      .orderBy(desc(normalizedProductsTable.agentReadinessScore))
      .limit(limit)
      .offset(offset),
  ]);

  const total = Number(countResult[0]?.count ?? 0);
  const responseTimeMs = Date.now() - startTime;

  const matchedSkus = products.map((p) => p.sku);
  const wasMatched = matchedSkus.length > 0;

  await Promise.all([
    db.insert(agentQueriesTable).values({
      merchantId,
      agentPlatform,
      queryText: q ?? null,
      matchedSkus,
      resultCount: products.length,
      wasMatched,
      intentCluster: brand ? "brand_search" : category ? "category_browse" : q ? "keyword_search" : "browse",
      sessionId: req.headers["x-session-id"] as string | undefined ?? null,
      responseTimeMs,
    }),
    db.insert(transactionEventsTable).values({
      merchantId,
      agentPlatform,
      sessionId: req.headers["x-session-id"] as string | undefined ?? null,
      eventType: "catalog_search",
      status: "success",
      durationMs: responseTimeMs,
      metadata: { query: q, filters: { brand, category, sku, mpn, color, minPrice, maxPrice }, resultCount: products.length },
    }),
  ]);

  paginatedResponse(res, products, total, page, limit);
});

router.get("/catalog/:sku", requireAgentAuth, async (req: Request, res: Response) => {
  const startTime = Date.now();
  const merchantId = req.merchantId!;
  const sku = getParam(req, "sku");
  const agentPlatform = req.agentPlatform ?? "api";

  if (!sku) {
    errorResponse(res, "SKU is required", "VALIDATION_ERROR", 400);
    return;
  }

  const [product] = await db
    .select()
    .from(normalizedProductsTable)
    .where(and(eq(normalizedProductsTable.merchantId, merchantId), eq(normalizedProductsTable.sku, sku)))
    .limit(1);

  if (!product) {
    errorResponse(res, "Product not found", "NOT_FOUND", 404);
    return;
  }

  const [inventoryRecord] = await db
    .select({
      quantity: inventoryTable.quantity,
      isInStock: inventoryTable.isInStock,
      sourceName: inventoryTable.sourceName,
      lastProbed: inventoryTable.lastProbed,
    })
    .from(inventoryTable)
    .where(and(eq(inventoryTable.merchantId, merchantId), eq(inventoryTable.sku, sku)))
    .limit(1);

  await Promise.all([
    db.insert(agentQueriesTable).values({
      merchantId,
      agentPlatform,
      queryText: `product:${sku}`,
      matchedSkus: [sku],
      resultCount: 1,
      wasMatched: true,
      intentCluster: "product_detail",
      sessionId: req.headers["x-session-id"] as string | undefined ?? null,
      responseTimeMs: Date.now() - startTime,
    }),
    db.insert(transactionEventsTable).values({
      merchantId,
      agentPlatform,
      sessionId: req.headers["x-session-id"] as string | undefined ?? null,
      sku,
      eventType: "product_view",
      status: "success",
      durationMs: Date.now() - startTime,
      metadata: { sku },
    }),
  ]);

  successResponse(res, {
    ...product,
    inventory: inventoryRecord ?? null,
  });
});

router.get("/catalog/:sku/inventory", requireAgentAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const sku = getParam(req, "sku");

  if (!sku) {
    errorResponse(res, "SKU is required", "VALIDATION_ERROR", 400);
    return;
  }

  const [record] = await db
    .select({
      quantity: inventoryTable.quantity,
      isInStock: inventoryTable.isInStock,
      sourceName: inventoryTable.sourceName,
      lastProbed: inventoryTable.lastProbed,
      lowStockThreshold: inventoryTable.lowStockThreshold,
    })
    .from(inventoryTable)
    .where(and(eq(inventoryTable.merchantId, merchantId), eq(inventoryTable.sku, sku)))
    .limit(1);

  successResponse(res, {
    sku,
    inventory: record ?? null,
    inStock: record ? record.isInStock : null,
    quantity: record?.quantity ?? null,
  });
});

export default router;
