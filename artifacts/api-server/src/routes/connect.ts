import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  magentoConnectionsTable,
  storeViewsTable,
  merchantsTable,
} from "@workspace/db/schema";
import { eq, and } from "drizzle-orm";
import { z } from "zod/v4";
import { requireAuth } from "../middlewares/auth.js";
import { successResponse, errorResponse } from "../lib/response.js";
import { encrypt, decrypt } from "../lib/crypto.js";
import { MagentoConnector } from "../services/magentoConnector.js";
import { advanceOnboardingPhase } from "../services/phaseService.js";

const router: IRouter = Router();

const connectSchema = z.object({
  storeUrl: z.url(),
  consumerKey: z.string().optional(),
  consumerSecret: z.string().optional(),
  accessToken: z.string().optional(),
  accessTokenSecret: z.string().optional(),
  apiUser: z.string().optional(),
  apiKeyM1: z.string().optional(),
});

function getParam(req: Request, key: string): string {
  const val = req.params[key];
  return Array.isArray(val) ? val[0] : (val ?? "");
}

function buildConnector(conn: {
  storeUrl: string;
  accessToken?: string | null;
  consumerKey?: string | null;
  consumerSecret?: string | null;
  accessTokenSecret?: string | null;
}): MagentoConnector {
  return new MagentoConnector({
    storeUrl: conn.storeUrl,
    accessToken: conn.accessToken ? safeDecrypt(conn.accessToken) : null,
    consumerKey: conn.consumerKey ? safeDecrypt(conn.consumerKey) : null,
    consumerSecret: conn.consumerSecret ? safeDecrypt(conn.consumerSecret) : null,
    accessTokenSecret: conn.accessTokenSecret ? safeDecrypt(conn.accessTokenSecret) : null,
  });
}

function safeDecrypt(val: string): string {
  try {
    return decrypt(val);
  } catch {
    // Fallback for the edge case where a value was stored without encryption
    // (e.g. during development/migration). Returns plaintext; this will
    // cause a Magento 401 at runtime, making the credential state observable.
    return val;
  }
}

router.post("/connect", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;

  const parsed = connectSchema.safeParse(req.body);
  if (!parsed.success) {
    errorResponse(res, "Validation failed", "VALIDATION_ERROR", 400, parsed.error.flatten());
    return;
  }

  const data = parsed.data;

  const values = {
    merchantId,
    storeUrl: data.storeUrl,
    consumerKey: data.consumerKey ? encrypt(data.consumerKey) : null,
    consumerSecret: data.consumerSecret ? encrypt(data.consumerSecret) : null,
    accessToken: data.accessToken ? encrypt(data.accessToken) : null,
    accessTokenSecret: data.accessTokenSecret ? encrypt(data.accessTokenSecret) : null,
    apiUser: data.apiUser ?? null,
    apiKeyM1: data.apiKeyM1 ? encrypt(data.apiKeyM1) : null,
    connectionStatus: "pending" as const,
  };

  const existing = await db
    .select({ id: magentoConnectionsTable.id })
    .from(magentoConnectionsTable)
    .where(eq(magentoConnectionsTable.merchantId, merchantId))
    .limit(1);

  let connection;

  if (existing.length > 0) {
    const [updated] = await db
      .update(magentoConnectionsTable)
      .set(values)
      .where(eq(magentoConnectionsTable.merchantId, merchantId))
      .returning();
    connection = updated;
  } else {
    const [inserted] = await db
      .insert(magentoConnectionsTable)
      .values(values)
      .returning();
    connection = inserted;
  }

  const sanitized = { ...connection, accessToken: "[encrypted]", consumerKey: "[encrypted]", consumerSecret: "[encrypted]", accessTokenSecret: "[encrypted]" };
  successResponse(res, sanitized, 201);
  void advanceOnboardingPhase(merchantId);
});

router.post("/connect/test", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;

  const [conn] = await db
    .select()
    .from(magentoConnectionsTable)
    .where(eq(magentoConnectionsTable.merchantId, merchantId))
    .limit(1);

  if (!conn) {
    errorResponse(res, "No Magento connection configured. Submit credentials first.", "NO_CONNECTION", 400);
    return;
  }

  const connector = buildConnector(conn);
  const result = await connector.testConnection();

  const status = result.success ? "connected" : "failed";

  await db
    .update(magentoConnectionsTable)
    .set({
      connectionStatus: status,
      storeName: result.storeName ?? null,
      detectedVersion: result.version ?? null,
      baseCurrency: result.currency ?? null,
      locale: result.locale ?? null,
      lastHealthCheck: new Date(),
    })
    .where(eq(magentoConnectionsTable.merchantId, merchantId));

  if (result.success && result.storeViews) {
    await db
      .delete(storeViewsTable)
      .where(eq(storeViewsTable.merchantId, merchantId));

    const svRows = result.storeViews.map((sv) => ({
      merchantId,
      magentoStoreViewId: sv.id,
      code: sv.code,
      name: sv.name,
      isSelected: true,
      isDefault: sv.isDefault ?? false,
    }));

    if (svRows.length > 0) {
      await db.insert(storeViewsTable).values(svRows);
    }
  }

  successResponse(res, {
    success: result.success,
    storeName: result.storeName,
    version: result.version,
    currency: result.currency,
    locale: result.locale,
    storeViews: result.storeViews,
    latencyMs: result.latencyMs,
    error: result.error,
    errorCode: result.errorCode,
  });
  if (result.success) void advanceOnboardingPhase(merchantId);
});

router.get("/connect/health", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;

  const [conn] = await db
    .select()
    .from(magentoConnectionsTable)
    .where(eq(magentoConnectionsTable.merchantId, merchantId))
    .limit(1);

  if (!conn) {
    errorResponse(res, "No Magento connection configured.", "NO_CONNECTION", 400);
    return;
  }

  const connector = buildConnector(conn);
  const health = await connector.healthCheck();

  await db
    .update(magentoConnectionsTable)
    .set({
      lastHealthCheck: new Date(),
      apiHealthPct: health.apiHealthPct ?? 0,
      connectionStatus: health.success ? "connected" : "degraded",
    })
    .where(eq(magentoConnectionsTable.merchantId, merchantId));

  successResponse(res, health);
});

router.get("/connect/store-views", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;

  const views = await db
    .select()
    .from(storeViewsTable)
    .where(eq(storeViewsTable.merchantId, merchantId));

  successResponse(res, views);
});

router.patch("/connect/store-views", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;

  const schema = z.object({
    selected: z.array(z.string()),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    errorResponse(res, "Validation failed", "VALIDATION_ERROR", 400, parsed.error.flatten());
    return;
  }

  const { selected } = parsed.data;

  const allViews = await db
    .select()
    .from(storeViewsTable)
    .where(eq(storeViewsTable.merchantId, merchantId));

  for (const view of allViews) {
    const isSelected = selected.includes(view.id);
    await db
      .update(storeViewsTable)
      .set({ isSelected })
      .where(eq(storeViewsTable.id, view.id));
  }

  const updated = await db
    .select()
    .from(storeViewsTable)
    .where(eq(storeViewsTable.merchantId, merchantId));

  successResponse(res, updated);
});

export default router;
