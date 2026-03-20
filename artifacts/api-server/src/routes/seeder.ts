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
  syncJobsTable,
  inventoryTable,
  systemAlertsTable,
  insightsTable,
  attributeMappingsTable,
  magentoConnectionsTable,
} from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";
import { successResponse, errorResponse } from "../lib/response.js";
import { generateApiKey } from "../lib/crypto.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

const BRANDS = ["ACDelco", "Bosch", "Monroe", "Motorcraft", "Gates", "Dorman", "Fel-Pro", "Beck Arnley"];
const CATEGORIES = [
  "Brakes/Pads",
  "Brakes/Rotors",
  "Engine/Filters",
  "Engine/Gaskets",
  "Suspension/Shocks",
  "Suspension/Springs",
  "Electrical/Alternators",
  "Electrical/Starters",
  "Exhaust/Mufflers",
  "Cooling/Thermostats",
  "Lighting/Headlights",
  "Transmission/Filters",
];
const PLATFORMS = ["gpt-4o", "claude-3-opus", "gemini-1.5-pro", "perplexity", "custom-agent"];
const INTENT_CLUSTERS = [
  "fitment_search",
  "keyword_search",
  "brand_search",
  "category_browse",
  "price_inquiry",
  "inventory_probe",
];
const ORDER_STATUSES = ["placed", "placed", "placed", "placed", "simulated"];

function rnd(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function rndFloat(min: number, max: number) {
  return Math.round((Math.random() * (max - min) + min) * 100) / 100;
}

function daysAgo(days: number) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(rnd(0, 23), rnd(0, 59), rnd(0, 59), 0);
  return d;
}

function pickRandom<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

const DEMO_SLUG = "acme-auto";
const PRODUCT_BATCH = 500;
const TOTAL_PRODUCTS = 50000;
const QUERIES_PER_DAY = 1000;
const ORDERS_PER_DAY_MIN = 20;
const ORDERS_PER_DAY_MAX = 30;
const DAYS = 30;

router.post("/seed-mock-data", async (req: Request, res: Response) => {
  if (process.env["NODE_ENV"] === "production") {
    res.status(403).json({ success: false, error: "Seeder is disabled in production" });
    return;
  }

  const force = req.body?.force === true;

  try {
    const existingRows = await db
      .select({ id: merchantsTable.id, slug: merchantsTable.slug, apiKey: merchantsTable.apiKey })
      .from(merchantsTable)
      .where(sql`slug = ${DEMO_SLUG}`)
      .limit(1);

    let merchantId: string;
    let apiKey: string;

    if (existingRows.length > 0) {
      merchantId = existingRows[0]!.id;
      apiKey = existingRows[0]!.apiKey!;

      const [[pRow], [qRow], [oRow]] = await Promise.all([
        db.select({ cnt: sql<number>`count(*)` }).from(normalizedProductsTable).where(eq(normalizedProductsTable.merchantId, merchantId)),
        db.select({ cnt: sql<number>`count(*)` }).from(agentQueriesTable).where(eq(agentQueriesTable.merchantId, merchantId)),
        db.select({ cnt: sql<number>`count(*)` }).from(agentOrdersTable).where(eq(agentOrdersTable.merchantId, merchantId)),
      ]);

      const existingProducts = Number(pRow?.cnt ?? 0);
      const existingQueries = Number(qRow?.cnt ?? 0);
      const existingOrders = Number(oRow?.cnt ?? 0);
      const isFullySeeded =
        existingProducts >= TOTAL_PRODUCTS &&
        existingQueries >= QUERIES_PER_DAY * DAYS &&
        existingOrders >= ORDERS_PER_DAY_MIN * DAYS;

      if (isFullySeeded && !force) {
        successResponse(res, {
          message: "Mock data already seeded. Pass force=true to re-seed.",
          merchantId,
          apiKey,
          stats: { existingProducts, existingQueries, existingOrders },
        });
        return;
      }

      if (force || !isFullySeeded) {
        await Promise.all([
          db.delete(normalizedProductsTable).where(eq(normalizedProductsTable.merchantId, merchantId)),
          db.delete(agentQueriesTable).where(eq(agentQueriesTable.merchantId, merchantId)),
          db.delete(agentOrdersTable).where(eq(agentOrdersTable.merchantId, merchantId)),
          db.delete(agentCartsTable).where(eq(agentCartsTable.merchantId, merchantId)),
          db.delete(transactionEventsTable).where(eq(transactionEventsTable.merchantId, merchantId)),
          db.delete(syncJobsTable).where(eq(syncJobsTable.merchantId, merchantId)),
          db.delete(inventoryTable).where(eq(inventoryTable.merchantId, merchantId)),
          db.delete(systemAlertsTable).where(eq(systemAlertsTable.merchantId, merchantId)),
          db.delete(insightsTable).where(eq(insightsTable.merchantId, merchantId)),
          db.delete(attributeMappingsTable).where(eq(attributeMappingsTable.merchantId, merchantId)),
          db.delete(magentoConnectionsTable).where(eq(magentoConnectionsTable.merchantId, merchantId)),
          db.delete(agentConfigsTable).where(eq(agentConfigsTable.merchantId, merchantId)),
        ]);
      }
    } else {
      apiKey = await generateApiKey();
      const [merchant] = await db
        .insert(merchantsTable)
        .values({
          slug: DEMO_SLUG,
          companyName: "Acme Auto Parts",
          contactFirstName: "Jane",
          contactLastName: "Smith",
          contactEmail: "jane@acmeauto.example.com",
          contactPhone: "555-867-5309",
          estimatedSkuCount: "50000",
          primaryVertical: "automotive",
          magentoVersion: "2.4.6",
          hostingEnvironment: "adobe-commerce-cloud",
          complexityScore: 72,
          onboardingPhase: 10,
          onboardingStatus: "complete",
          apiKey,
          sandboxMode: false,
          isLive: true,
        })
        .returning({ id: merchantsTable.id });
      merchantId = merchant!.id;
    }

    logger.info({ merchantId }, "Seeding mock data...");

    await db
      .insert(agentConfigsTable)
      .values({
        merchantId,
        rateLimitPerMinute: 90,
        requireCartConfirmation: false,
        maxOrderValueCents: null,
        defaultShippingMethod: "flatrate_flatrate",
        defaultPaymentMethod: "vare_ai",
        testOrderEnabled: true,
        enabledCapabilities: ["search", "cart", "checkout"],
      })
      .onConflictDoNothing();

    await db
      .insert(magentoConnectionsTable)
      .values({
        merchantId,
        storeUrl: "https://demo-store.acmeauto.example.com",
        storeName: "Acme Auto Parts Store",
        detectedVersion: "2.4.6",
        baseCurrency: "USD",
        locale: "en_US",
        connectionStatus: "healthy",
        lastHealthCheck: new Date(),
        apiHealthPct: 99.2,
        syncConfig: { syncInventory: true, syncPrices: true, deltaEnabled: true },
      })
      .onConflictDoNothing();

    let insertedProducts = 0;
    const skuList: string[] = [];

    for (let batch = 0; batch < TOTAL_PRODUCTS / PRODUCT_BATCH; batch++) {
      const products = Array.from({ length: PRODUCT_BATCH }, (_, i) => {
        const idx = batch * PRODUCT_BATCH + i + 1;
        const brand = pickRandom(BRANDS);
        const category = pickRandom(CATEGORIES);
        const catShort = category.split("/")[1] ?? "Part";
        const sku = `ACME-${String(idx).padStart(6, "0")}`;
        const normStatus = (["normalized", "normalized", "normalized", "reviewed", "pending"] as const)[rnd(0, 4)]!;
        skuList.push(sku);
        return {
          merchantId,
          sku,
          productTitle: `${brand} ${catShort} #${idx}`,
          brand,
          manufacturer: brand,
          mpn: `MPN-${sku}`,
          price: String(rndFloat(4.99, 299.99)),
          currency: "USD",
          categoryPath: category,
          agentReadinessScore: rnd(40, 100),
          normalizationStatus: normStatus,
          normalizedAt: normStatus !== "pending" ? daysAgo(rnd(0, 30)) : null,
        };
      });

      await db.insert(normalizedProductsTable).values(products).onConflictDoNothing();
      insertedProducts += products.length;

      if (batch % 10 === 0) {
        logger.info({ batch: batch + 1, total: TOTAL_PRODUCTS / PRODUCT_BATCH, insertedProducts }, "Product batch inserted");
      }
    }

    const invBatch = skuList.map((sku) => {
      const qty = rnd(0, 200);
      return {
        merchantId,
        sku,
        quantity: qty,
        isInStock: qty > 0,
        lastProbed: daysAgo(rnd(0, 2)),
      };
    });

    for (let i = 0; i < invBatch.length; i += 500) {
      await db.insert(inventoryTable).values(invBatch.slice(i, i + 500)).onConflictDoNothing();
    }

    const syncJobTypes = ["full_sync", "delta_sync", "inventory_probe", "normalization"];
    const syncStatuses = ["completed", "completed", "completed", "failed", "in_progress"];
    const syncJobs = Array.from({ length: 90 }, (_, i) => {
      const dayOffset = Math.floor(i / 3);
      const jobType = pickRandom(syncJobTypes);
      const status = i === 0 ? "in_progress" : pickRandom(syncStatuses);
      const total = rnd(5000, 50000);
      const processed = status === "in_progress" ? rnd(0, total) : status === "completed" ? total : rnd(0, total);
      const errCount = status === "failed" ? rnd(5, 50) : 0;
      const started = daysAgo(dayOffset);
      const completed = status !== "in_progress" ? new Date(started.getTime() + rnd(60, 1800) * 1000) : null;
      return {
        merchantId,
        jobType,
        status,
        totalRecords: total,
        processedRecords: processed,
        errorCount: errCount,
        startedAt: started,
        completedAt: completed,
        durationSeconds: completed ? Math.round((completed.getTime() - started.getTime()) / 1000) : null,
        createdAt: started,
      };
    });
    await db.insert(syncJobsTable).values(syncJobs);

    const attrSources = ["manufacturer", "fitment_year", "fitment_make", "fitment_model", "upc", "weight", "color"];
    const attrTargets = ["brand", "year", "make", "model", "upc", "weight_kg", "color_normalized"];
    await db.insert(attributeMappingsTable).values(
      attrSources.map((src, i) => ({
        merchantId,
        sourceAttribute: src,
        targetAttribute: attrTargets[i]!,
        mappingStatus: i < 5 ? "auto" : "manual",
        confidence: rndFloat(0.7, 1.0),
        dataType: "string",
      })),
    );

    const queryTexts = [
      "brake pads for 2019 Toyota Camry",
      "oil filter synthetic 5W30",
      "rear shocks Honda Accord",
      "alternator replacement Ford F150",
      "2021 Chevy Silverado headlight bulb",
      "performance exhaust Mustang GT",
      "engine air filter BMW 3 series",
      "transmission fluid synthetic",
      "ceramic brake rotors front",
      "spark plugs iridium 4 cylinder",
      "wiper blades 24 inch",
      "serpentine belt Toyota Tacoma",
      "coolant temperature sensor Dodge",
      "mass air flow sensor cleaning",
      "tire pressure monitor reset",
    ];

    let totalQueries = 0;
    let totalOrders = 0;
    let totalTransactions = 0;

    for (let day = DAYS - 1; day >= 0; day--) {
      const allQueries: Array<typeof agentQueriesTable.$inferInsert> = [];
      const allTransactions: Array<typeof transactionEventsTable.$inferInsert> = [];
      const allOrders: Array<typeof agentOrdersTable.$inferInsert> = [];

      for (let q = 0; q < QUERIES_PER_DAY; q++) {
        const platform = pickRandom(PLATFORMS);
        const intent = pickRandom(INTENT_CLUSTERS);
        const queryText = Math.random() > 0.3 ? pickRandom(queryTexts) : null;
        const wasMatched = Math.random() > 0.25;
        const matchedSkus = wasMatched ? [skuList[rnd(0, skuList.length - 1)]!] : [];
        const responseTimeMs = rnd(50, 800);
        const sessionId = `sess-${day}-${q}`;
        const ts = daysAgo(day);

        allQueries.push({
          merchantId,
          agentPlatform: platform,
          queryText,
          matchedSkus,
          resultCount: wasMatched ? rnd(1, 20) : 0,
          wasMatched,
          intentCluster: intent,
          sessionId,
          responseTimeMs,
          createdAt: ts,
        });

        allTransactions.push({
          merchantId,
          agentPlatform: platform,
          eventType: "catalog_search",
          status: "success",
          sku: matchedSkus[0] ?? null,
          durationMs: responseTimeMs,
          sessionId,
          createdAt: ts,
        });
      }

      const ordersPerDay = rnd(ORDERS_PER_DAY_MIN, ORDERS_PER_DAY_MAX);
      for (let o = 0; o < ordersPerDay; o++) {
        const platform = pickRandom(PLATFORMS);
        const sku = skuList[rnd(0, skuList.length - 1)]!;
        const sessionId = `ord-sess-${day}-${o}`;
        const ts = daysAgo(day);
        const cartTs = new Date(ts.getTime() + rnd(5000, 60000));
        const orderTs = new Date(cartTs.getTime() + rnd(3000, 30000));
        const qty = rnd(1, 4);
        const price = rndFloat(9.99, 249.99);
        const orderStatus = pickRandom(ORDER_STATUSES);
        const ref = `vare-seed-${day}-${o}`;

        allTransactions.push({
          merchantId,
          agentPlatform: platform,
          eventType: "cart_create",
          status: "success",
          sku,
          durationMs: rnd(100, 500),
          sessionId,
          createdAt: cartTs,
        });

        allOrders.push({
          merchantId,
          agentOrderRef: ref,
          agentPlatform: platform,
          sku,
          productTitle: `Seed Product ${sku}`,
          quantity: qty,
          unitPrice: String(price),
          totalPrice: String(Math.round(price * qty * 100) / 100),
          orderStatus,
          paymentMethod: "vare_ai",
          shippingMethod: "flatrate_flatrate",
          createdAt: orderTs,
          updatedAt: orderTs,
        });

        allTransactions.push({
          merchantId,
          agentPlatform: platform,
          eventType: "checkout",
          status: orderStatus === "failed" ? "error" : "success",
          sku,
          durationMs: rnd(200, 2000),
          sessionId,
          createdAt: orderTs,
        });
      }

      for (let i = 0; i < allQueries.length; i += 500) {
        await db.insert(agentQueriesTable).values(allQueries.slice(i, i + 500));
      }
      for (let i = 0; i < allTransactions.length; i += 500) {
        await db.insert(transactionEventsTable).values(allTransactions.slice(i, i + 500));
      }
      for (let i = 0; i < allOrders.length; i += 200) {
        await db.insert(agentOrdersTable).values(allOrders.slice(i, i + 200));
      }

      totalQueries += allQueries.length;
      totalOrders += allOrders.length;
      totalTransactions += allTransactions.length;
    }

    await db.insert(systemAlertsTable).values([
      {
        merchantId,
        alertType: "warning",
        title: "High Unmatched Query Rate",
        description: "26% of agent queries returned no results in the last 24h",
        suggestion: "Add missing SKUs or improve catalog normalization",
        isRead: false,
        createdAt: daysAgo(0),
      },
      {
        merchantId,
        alertType: "info",
        title: "Delta Sync Completed",
        description: "1,247 products updated in the latest delta sync",
        suggestion: "Review normalization queue for new products",
        isRead: true,
        createdAt: daysAgo(1),
      },
      {
        merchantId,
        alertType: "error",
        title: "Magento API Timeout",
        description: "3 consecutive Magento API timeouts detected",
        suggestion: "Check Magento server load and network connectivity",
        isRead: false,
        createdAt: daysAgo(0),
      },
      {
        merchantId,
        alertType: "success",
        title: "Inventory Probe Completed",
        description: `${insertedProducts.toLocaleString()} SKUs probed successfully`,
        suggestion: null,
        isRead: true,
        createdAt: daysAgo(2),
      },
    ]);

    await db.insert(insightsTable).values([
      {
        merchantId,
        insightType: "revenue",
        badge: "Revenue Growing",
        text: "Agent-driven revenue is up 18% week-over-week, with Bosch brake pads being the top performer at $12,400 in orders.",
        actionLabel: "View Top Products",
        dateRange: "30d",
      },
      {
        merchantId,
        insightType: "query_gap",
        badge: "Query Gap Detected",
        text: "482 queries for '2021 Silverado headlight' returned no results. Adding these SKUs could capture an estimated $8,200/month.",
        actionLabel: "Optimize Catalog",
        dateRange: "30d",
      },
      {
        merchantId,
        insightType: "platform_mix",
        badge: "Platform Diversification",
        text: "GPT-4o drives 44% of orders, but Claude-3 Opus has a 31% higher conversion rate. Consider expanding Claude integration.",
        actionLabel: "View Platforms",
        dateRange: "30d",
      },
      {
        merchantId,
        insightType: "conversion",
        badge: "Conversion Opportunity",
        text: "Fitment-filtered searches convert at 3.2% vs 1.8% for keyword searches. Enriching fitment data could lift revenue by 24%.",
        actionLabel: "Improve Fitment",
        dateRange: "30d",
      },
    ]);

    successResponse(res, {
      message: "Mock data seeded successfully",
      merchantId,
      apiKey,
      stats: {
        products: insertedProducts,
        inventorySkus: invBatch.length,
        syncJobs: syncJobs.length,
        queries: totalQueries,
        orders: totalOrders,
        transactionEvents: totalTransactions,
        systemAlerts: 4,
        insights: 4,
      },
    });
  } catch (err) {
    logger.error({ err }, "Seed failed");
    errorResponse(res, String(err), "SEED_ERROR", 500);
  }
});

export default router;
