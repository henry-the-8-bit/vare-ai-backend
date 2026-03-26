import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  normalizedProductsTable,
  agentQueriesTable,
  transactionEventsTable,
  inventoryTable,
} from "@workspace/db/schema";
import { eq, and, ilike, or, gte, lte, desc, sql, inArray } from "drizzle-orm";
import { requireAgentAuth } from "../../middlewares/auth.js";
import { successResponse, paginatedResponse, errorResponse } from "../../lib/response.js";
import { probeSingleSku, applyFeedInventoryConfig, type FeedInventoryConfig } from "../../services/inventoryProbeService.js";
import { feedService } from "../../services/feedService.js";
import { z } from "zod/v4";

const router: IRouter = Router({ mergeParams: true });

async function getFeedInventoryConfig(merchantId: string): Promise<FeedInventoryConfig | null> {
  try {
    const feeds = await feedService.listFeeds(merchantId);
    for (const feed of feeds) {
      const cfg = (feed as any).config?.inventory;
      if (cfg && cfg.source) return cfg as FeedInventoryConfig;
    }
  } catch {
    // Feed lookup failed — fall through to default behavior
  }
  return null;
}

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
  year: z.coerce.number().int().min(1900).max(2100).optional(),
  make: z.string().optional(),
  model: z.string().optional(),
  engine: z.string().optional(),
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

  const { q, brand, category, sku, mpn, color, minPrice, maxPrice, normalizationStatus, inStockOnly, year, make, model, engine, page, limit } = parsed.data;

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

  if (year !== undefined) {
    conditions.push(sql`${normalizedProductsTable.fitmentData} @> ${JSON.stringify({ years: [year] })}::jsonb`);
  }
  if (make) {
    conditions.push(sql`lower(${normalizedProductsTable.fitmentData}->>'make') = lower(${make})`);
  }
  if (model) {
    conditions.push(sql`lower(${normalizedProductsTable.fitmentData}->>'model') = lower(${model})`);
  }
  if (engine) {
    conditions.push(sql`lower(${normalizedProductsTable.fitmentData}->>'engine') = lower(${engine})`);
  }

  const baseWhereClause = and(...conditions);
  const offset = (page - 1) * limit;

  if (inStockOnly) {
    const inStockSkus = await db
      .select({ sku: inventoryTable.sku })
      .from(inventoryTable)
      .where(and(eq(inventoryTable.merchantId, merchantId), eq(inventoryTable.isInStock, true)));
    const skuSet = inStockSkus.map((r) => r.sku);
    if (skuSet.length === 0) {
      paginatedResponse(res, [], 0, page, limit);
      return;
    }
    conditions.push(inArray(normalizedProductsTable.sku, skuSet));
  }

  const whereClause = and(...conditions);

  const [countResult, products, facetsCategories, facetsBrands, facetsPrices] = await Promise.all([
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
    db
      .select({ category: normalizedProductsTable.categoryPath, count: sql<number>`count(*)` })
      .from(normalizedProductsTable)
      .where(and(eq(normalizedProductsTable.merchantId, merchantId), or(eq(normalizedProductsTable.normalizationStatus, "normalized"), eq(normalizedProductsTable.normalizationStatus, "reviewed"))!))
      .groupBy(normalizedProductsTable.categoryPath)
      .orderBy(desc(sql<number>`count(*)`))
      .limit(20),
    db
      .select({ brand: normalizedProductsTable.brand, count: sql<number>`count(*)` })
      .from(normalizedProductsTable)
      .where(and(eq(normalizedProductsTable.merchantId, merchantId), or(eq(normalizedProductsTable.normalizationStatus, "normalized"), eq(normalizedProductsTable.normalizationStatus, "reviewed"))!))
      .groupBy(normalizedProductsTable.brand)
      .orderBy(desc(sql<number>`count(*)`))
      .limit(20),
    db
      .select({
        minPrice: sql<number>`min(price::numeric)`,
        maxPrice: sql<number>`max(price::numeric)`,
        avgPrice: sql<number>`avg(price::numeric)`,
      })
      .from(normalizedProductsTable)
      .where(and(eq(normalizedProductsTable.merchantId, merchantId), or(eq(normalizedProductsTable.normalizationStatus, "normalized"), eq(normalizedProductsTable.normalizationStatus, "reviewed"))!)),
  ]);

  const total = Number(countResult[0]?.count ?? 0);
  const responseTimeMs = Date.now() - startTime;
  const matchedSkus = products.map((p) => p.sku);

  await Promise.all([
    db.insert(agentQueriesTable).values({
      merchantId,
      agentPlatform,
      queryText: q ?? null,
      matchedSkus,
      resultCount: products.length,
      wasMatched: products.length > 0,
      intentCluster: year || make || model ? "fitment_search" : brand ? "brand_search" : category ? "category_browse" : q ? "keyword_search" : "browse",
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
      metadata: { query: q, filters: { brand, category, sku, mpn, color, minPrice, maxPrice, year, make, model, engine, inStockOnly }, resultCount: products.length },
    }),
  ]);

  const facets = {
    categories: facetsCategories.filter((c) => c.category).map((c) => ({ value: c.category, count: Number(c.count) })),
    brands: facetsBrands.filter((b) => b.brand).map((b) => ({ value: b.brand, count: Number(b.count) })),
    priceRange: facetsPrices[0]
      ? {
          min: facetsPrices[0].minPrice ? Number(facetsPrices[0].minPrice) : null,
          max: facetsPrices[0].maxPrice ? Number(facetsPrices[0].maxPrice) : null,
          avg: facetsPrices[0].avgPrice ? Math.round(Number(facetsPrices[0].avgPrice) * 100) / 100 : null,
        }
      : null,
  };

  res.status(200).json({
    data: products,
    total,
    page,
    limit,
    facets,
    generated_at: new Date().toISOString(),
  });
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

  const probeResult = await probeSingleSku(merchantId, sku);
  const feedInvConfig = await getFeedInventoryConfig(merchantId);

  let inventoryStatus;
  if (feedInvConfig) {
    const adjusted = applyFeedInventoryConfig(probeResult, feedInvConfig);
    if (adjusted.hidden) {
      errorResponse(res, "Product inventory unavailable (stale data)", "STALE_HIDDEN", 404);
      return;
    }
    inventoryStatus = {
      sku,
      in_stock: adjusted.isInStock,
      quantity: adjusted.quantity,
      low_stock: adjusted.lowStock,
      sources: [adjusted.source],
      last_checked: adjusted.lastProbed?.toISOString() ?? null,
      cached: adjusted.cached,
      stale: adjusted.stale,
    };
  } else {
    inventoryStatus = {
      sku,
      in_stock: probeResult.isInStock,
      quantity: probeResult.quantity,
      low_stock: probeResult.quantity !== null && probeResult.quantity <= 5,
      sources: [probeResult.source],
      last_checked: probeResult.lastProbed?.toISOString() ?? null,
      cached: probeResult.cached,
    };
  }

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
    inventory: inventoryStatus,
  });
});

router.get("/inventory/:sku", requireAgentAuth, async (req: Request, res: Response) => {
  const startTime = Date.now();
  const merchantId = req.merchantId!;
  const agentPlatform = req.agentPlatform ?? "api";
  const sku = getParam(req, "sku");

  if (!sku) {
    errorResponse(res, "SKU is required", "VALIDATION_ERROR", 400);
    return;
  }

  const probeResult = await probeSingleSku(merchantId, sku);
  const responseTimeMs = Date.now() - startTime;

  await Promise.all([
    db.insert(agentQueriesTable).values({
      merchantId,
      agentPlatform,
      queryText: sku,
      matchedSkus: probeResult.isInStock !== null ? [sku] : [],
      resultCount: probeResult.isInStock !== null ? 1 : 0,
      wasMatched: probeResult.isInStock !== null,
      intentCluster: "inventory_probe",
      sessionId: req.headers["x-session-id"] as string | undefined ?? null,
      responseTimeMs,
    }),
    db.insert(transactionEventsTable).values({
      merchantId,
      agentPlatform,
      sessionId: req.headers["x-session-id"] as string | undefined ?? null,
      sku,
      eventType: "inventory_probe",
      status: probeResult.error ? "error" : "success",
      durationMs: responseTimeMs,
      metadata: { sku, source: probeResult.source, cached: probeResult.cached, isInStock: probeResult.isInStock, quantity: probeResult.quantity },
    }),
  ]).catch(() => {});

  const feedInvConfig = await getFeedInventoryConfig(merchantId);

  if (feedInvConfig) {
    const adjusted = applyFeedInventoryConfig(probeResult, feedInvConfig);
    if (adjusted.hidden) {
      errorResponse(res, "Product inventory unavailable (stale data)", "STALE_HIDDEN", 404);
      return;
    }
    successResponse(res, {
      sku,
      in_stock: adjusted.isInStock,
      quantity: adjusted.quantity,
      low_stock: adjusted.lowStock,
      sources: [adjusted.source],
      last_checked: adjusted.lastProbed?.toISOString() ?? null,
      cached: adjusted.cached,
      latency_ms: adjusted.latencyMs,
      stale: adjusted.stale,
      error: adjusted.error ?? null,
    });
  } else {
    successResponse(res, {
      sku,
      in_stock: probeResult.isInStock,
      quantity: probeResult.quantity,
      low_stock: probeResult.quantity !== null && probeResult.quantity <= 5,
      sources: [probeResult.source],
      last_checked: probeResult.lastProbed?.toISOString() ?? null,
      cached: probeResult.cached,
      latency_ms: probeResult.latencyMs,
      error: probeResult.error ?? null,
    });
  }
});

export default router;
