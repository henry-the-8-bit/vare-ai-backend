import { Router, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  normalizedProductsTable,
  inventoryTable,
  agentQueriesTable,
  agentOrdersTable,
  rawProductsTable,
} from "@workspace/db/schema";
import { eq, and, desc, asc, sql, ilike, or, gte, lte, isNull } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth.js";
import { successResponse, paginatedResponse, errorResponse } from "../lib/response.js";

const router = Router();

// ── GET /products/summary — aggregate stats ──
router.get("/products/summary", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;

  const [result] = await db
    .select({
      total: sql<number>`count(*)::int`,
      agentReady: sql<number>`count(*) filter (where ${normalizedProductsTable.agentReadinessScore} >= 70)::int`,
      needsAttention: sql<number>`count(*) filter (where ${normalizedProductsTable.agentReadinessScore} >= 40 and ${normalizedProductsTable.agentReadinessScore} < 70)::int`,
      notReady: sql<number>`count(*) filter (where ${normalizedProductsTable.agentReadinessScore} < 40 or ${normalizedProductsTable.agentReadinessScore} is null)::int`,
      avgScore: sql<number>`coalesce(avg(${normalizedProductsTable.agentReadinessScore}), 0)::int`,
    })
    .from(normalizedProductsTable)
    .where(eq(normalizedProductsTable.merchantId, merchantId));

  successResponse(res, result);
});

// ── GET /products/categories — category tree from distinct paths ──
router.get("/products/categories", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;

  const rows = await db
    .select({
      categoryPath: normalizedProductsTable.categoryPath,
      count: sql<number>`count(*)::int`,
      avgScore: sql<number>`coalesce(avg(${normalizedProductsTable.agentReadinessScore}), 0)::int`,
    })
    .from(normalizedProductsTable)
    .where(eq(normalizedProductsTable.merchantId, merchantId))
    .groupBy(normalizedProductsTable.categoryPath)
    .orderBy(desc(sql`count(*)`));

  // Build a tree from flat category paths like "Auto Parts > Electrical > Alternators"
  interface CatNode {
    name: string;
    count: number;
    readinessPct: number;
    children: CatNode[];
  }

  const root: CatNode[] = [];

  for (const row of rows) {
    const pathStr = row.categoryPath ?? "";
    const parts = pathStr.split(/\s*>\s*/).filter(Boolean);
    if (parts.length === 0) continue;

    let nodes = root;
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      let node = nodes.find(n => n.name === name);
      if (!node) {
        node = { name, count: 0, readinessPct: 0, children: [] };
        nodes.push(node);
      }
      node.count += row.count;
      // Weighted average
      node.readinessPct = Math.round(
        (node.readinessPct * (node.count - row.count) + row.avgScore * row.count) / node.count,
      );
      nodes = node.children;
    }
  }

  successResponse(res, root);
});

// ── GET /products — paginated product list ──
router.get("/products", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const page = Math.max(1, parseInt(String(req.query["page"] ?? "1"), 10));
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query["limit"] ?? "20"), 10)));
  const offset = (page - 1) * limit;

  const search = req.query["search"] as string | undefined;
  const normStatus = req.query["normalizationStatus"] as string | undefined;
  const category = req.query["category"] as string | undefined;
  const scoreMin = req.query["scoreMin"] ? parseInt(String(req.query["scoreMin"]), 10) : undefined;
  const scoreMax = req.query["scoreMax"] ? parseInt(String(req.query["scoreMax"]), 10) : undefined;
  const sortBy = (req.query["sortBy"] as string) ?? "updatedAt";
  const sortDir = (req.query["sortDir"] as string) === "asc" ? "asc" : "desc";

  // Build conditions
  const conditions = [eq(normalizedProductsTable.merchantId, merchantId)];

  if (search) {
    conditions.push(
      or(
        ilike(normalizedProductsTable.sku, `%${search}%`),
        ilike(normalizedProductsTable.productTitle, `%${search}%`),
        ilike(normalizedProductsTable.brand, `%${search}%`),
      )!,
    );
  }

  if (normStatus) conditions.push(eq(normalizedProductsTable.normalizationStatus, normStatus));
  if (category) conditions.push(ilike(normalizedProductsTable.categoryPath, `%${category}%`));
  if (scoreMin !== undefined) conditions.push(gte(normalizedProductsTable.agentReadinessScore, scoreMin));
  if (scoreMax !== undefined) conditions.push(lte(normalizedProductsTable.agentReadinessScore, scoreMax));

  // Sort mapping
  const sortColumns: Record<string, unknown> = {
    name: normalizedProductsTable.productTitle,
    sku: normalizedProductsTable.sku,
    brand: normalizedProductsTable.brand,
    price: normalizedProductsTable.price,
    score: normalizedProductsTable.agentReadinessScore,
    updatedAt: normalizedProductsTable.updatedAt,
  };
  const sortCol = sortColumns[sortBy] ?? normalizedProductsTable.updatedAt;
  const orderFn = sortDir === "asc" ? asc : desc;

  // Fetch products with inventory join
  const [products, [{ cnt }]] = await Promise.all([
    db
      .select({
        id: normalizedProductsTable.id,
        sku: normalizedProductsTable.sku,
        name: normalizedProductsTable.productTitle,
        brand: normalizedProductsTable.brand,
        price: normalizedProductsTable.price,
        score: normalizedProductsTable.agentReadinessScore,
        normStatus: normalizedProductsTable.normalizationStatus,
        categoryPath: normalizedProductsTable.categoryPath,
        imageUrls: normalizedProductsTable.imageUrls,
        description: normalizedProductsTable.description,
        hasFitment: sql<boolean>`${normalizedProductsTable.fitmentData} is not null and ${normalizedProductsTable.fitmentData}::text != 'null'`,
        updatedAt: normalizedProductsTable.updatedAt,
        // Inventory fields
        stock: inventoryTable.quantity,
        isInStock: inventoryTable.isInStock,
        lowStockThreshold: inventoryTable.lowStockThreshold,
      })
      .from(normalizedProductsTable)
      .leftJoin(
        inventoryTable,
        and(
          eq(inventoryTable.merchantId, normalizedProductsTable.merchantId),
          eq(inventoryTable.sku, normalizedProductsTable.sku),
        ),
      )
      .where(and(...conditions))
      .orderBy(orderFn(sortCol as ReturnType<typeof sql>))
      .limit(limit)
      .offset(offset),

    db
      .select({ cnt: sql<number>`count(*)::int` })
      .from(normalizedProductsTable)
      .where(and(...conditions)),
  ]);

  // Enrich with computed fields
  const enriched = products.map(p => {
    const qty = p.stock ?? 0;
    const threshold = p.lowStockThreshold ?? 5;
    let stockStatus: "in_stock" | "low_stock" | "out_of_stock" = "in_stock";
    if (qty <= 0) stockStatus = "out_of_stock";
    else if (qty <= threshold) stockStatus = "low_stock";

    const images = p.imageUrls as string[] | null;
    const hasImage = Array.isArray(images) && images.length > 0;
    const hasDescription = !!p.description && p.description.length > 0;

    // Parse category path
    const pathStr = p.categoryPath ?? "";
    const pathParts = pathStr.split(/\s*>\s*/).filter(Boolean);
    const category = pathParts[pathParts.length - 1] ?? "";

    return {
      id: p.id,
      sku: p.sku,
      name: p.name ?? "",
      brand: p.brand ?? "",
      price: p.price ? Number(p.price) : 0,
      stock: qty,
      stockStatus,
      score: p.score ?? 0,
      normStatus: p.normStatus ?? "pending",
      category,
      categoryPath: pathParts,
      hasImage,
      hasDescription,
      hasFitment: !!p.hasFitment,
      lastUpdated: p.updatedAt?.toISOString() ?? "",
      visibleToAgents: true, // default for now
    };
  });

  paginatedResponse(res, enriched, Number(cnt ?? 0), page, limit);
});

// ── GET /products/:id — single product detail ──
router.get("/products/:id", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const productId = req.params["id"]!;

  const [product] = await db
    .select()
    .from(normalizedProductsTable)
    .where(and(eq(normalizedProductsTable.id, productId), eq(normalizedProductsTable.merchantId, merchantId)));

  if (!product) {
    errorResponse(res, "Product not found", "NOT_FOUND", 404);
    return;
  }

  // Parallel fetches for related data
  const [inventory, rawProduct, queryCount, orderData] = await Promise.all([
    db
      .select()
      .from(inventoryTable)
      .where(and(eq(inventoryTable.merchantId, merchantId), eq(inventoryTable.sku, product.sku)))
      .limit(1)
      .then(rows => rows[0] ?? null),

    product.rawProductId
      ? db.select().from(rawProductsTable).where(eq(rawProductsTable.id, product.rawProductId)).limit(1).then(rows => rows[0] ?? null)
      : null,

    db
      .select({
        count: sql<number>`count(*)::int`,
        platforms: sql<string[]>`array_agg(distinct ${agentQueriesTable.agentPlatform})`,
      })
      .from(agentQueriesTable)
      .where(
        and(
          eq(agentQueriesTable.merchantId, merchantId),
          sql`${agentQueriesTable.matchedSkus}::text like ${'%' + product.sku + '%'}`,
        ),
      )
      .then(rows => rows[0]),

    db
      .select({
        totalRevenue: sql<number>`coalesce(sum(${agentOrdersTable.totalPrice}), 0)::numeric`,
        orderCount: sql<number>`count(*)::int`,
      })
      .from(agentOrdersTable)
      .where(and(eq(agentOrdersTable.merchantId, merchantId), eq(agentOrdersTable.sku, product.sku)))
      .then(rows => rows[0]),
  ]);

  const qty = inventory?.quantity ?? 0;
  const threshold = inventory?.lowStockThreshold ?? 5;
  let stockStatus: "in_stock" | "low_stock" | "out_of_stock" = "in_stock";
  if (qty <= 0) stockStatus = "out_of_stock";
  else if (qty <= threshold) stockStatus = "low_stock";

  const images = product.imageUrls as string[] | null;
  const pathParts = (product.categoryPath ?? "").split(/\s*>\s*/).filter(Boolean);

  successResponse(res, {
    id: product.id,
    sku: product.sku,
    name: product.productTitle ?? "",
    brand: product.brand ?? "",
    manufacturer: product.manufacturer ?? "",
    mpn: product.mpn ?? "",
    upc: product.upc ?? "",
    price: product.price ? Number(product.price) : 0,
    currency: product.currency ?? "USD",
    color: product.color ?? "",
    finish: product.finish ?? "",
    weight: product.weight ? Number(product.weight) : null,
    weightUnit: product.weightUnit ?? "",
    description: product.description ?? "",
    shortDescription: product.shortDescription ?? "",
    category: pathParts[pathParts.length - 1] ?? "",
    categoryPath: pathParts,
    imageUrls: Array.isArray(images) ? images : [],
    customAttributes: product.customAttributes ?? {},
    fitmentData: product.fitmentData ?? null,
    score: product.agentReadinessScore ?? 0,
    normStatus: product.normalizationStatus ?? "pending",
    normalizedAt: product.normalizedAt?.toISOString() ?? null,
    lastUpdated: product.updatedAt?.toISOString() ?? "",
    visibleToAgents: true,
    // Stock
    stock: qty,
    stockStatus,
    lastProbed: inventory?.lastProbed?.toISOString() ?? null,
    probeLatencyMs: inventory?.probeLatencyMs ?? null,
    // Agent activity
    agentQueries: queryCount?.count ?? 0,
    agentPlatforms: (queryCount?.platforms ?? []).filter(Boolean),
    agentRevenue: Number(orderData?.totalRevenue ?? 0),
    agentOrders: orderData?.orderCount ?? 0,
    // Raw data (for attributes tab)
    rawData: rawProduct?.rawData ?? null,
    hasImage: Array.isArray(images) && images.length > 0,
    hasDescription: !!product.description,
    hasFitment: !!product.fitmentData,
    feedSource: rawProduct ? "Magento 2" : "CSV Upload",
  });
});

// ── PATCH /products/:id/visibility — toggle agent visibility ──
router.patch("/products/:id/visibility", requireAuth, async (req: Request, res: Response) => {
  // For now, return success — visibility column can be added later
  successResponse(res, { success: true });
});

// ── POST /products/:id/renormalize — re-queue for normalization ──
router.post("/products/:id/renormalize", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const productId = req.params["id"]!;

  await db
    .update(normalizedProductsTable)
    .set({ normalizationStatus: "pending", normalizedAt: null })
    .where(and(eq(normalizedProductsTable.id, productId), eq(normalizedProductsTable.merchantId, merchantId)));

  successResponse(res, { success: true, message: "Product queued for re-normalization" });
});

// ── POST /products/bulk — bulk actions ──
router.post("/products/bulk", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const { action, productIds } = req.body as { action: string; productIds: string[] };

  if (!action || !Array.isArray(productIds) || productIds.length === 0) {
    errorResponse(res, "action and productIds required", "INVALID_REQUEST");
    return;
  }

  let affected = 0;

  if (action === "renormalize") {
    const result = await db
      .update(normalizedProductsTable)
      .set({ normalizationStatus: "pending", normalizedAt: null })
      .where(
        and(
          eq(normalizedProductsTable.merchantId, merchantId),
          sql`${normalizedProductsTable.id} = ANY(${productIds}::uuid[])`,
        ),
      );
    affected = productIds.length;
  }

  successResponse(res, { success: true, action, affected });
});

export default router;
