import { db } from "@workspace/db";
import {
  platformConnectionsTable,
  distributionJobsTable,
  distributionEventsTable,
  normalizedProductsTable,
  merchantsTable,
} from "@workspace/db/schema";
import { eq, and, desc, gte, or } from "drizzle-orm";
import { encrypt, decrypt } from "../../lib/crypto.js";
import { logger } from "../../lib/logger.js";
import { getAdapter, listPlatformMetadata, hasAdapter } from "./adapters/index.js";
import type { DistributionPlatform, SyncType, PlatformSpec } from "./types.js";

interface CreateConnectionInput {
  platform: DistributionPlatform;
  displayName: string;
  credentials?: Record<string, string>;
  config?: Record<string, unknown>;
  syncSchedule?: string;
}

interface UpdateConnectionInput {
  displayName?: string;
  credentials?: Record<string, string>;
  config?: Record<string, unknown>;
  syncSchedule?: string;
  connectionStatus?: string;
}

async function getMerchantSlug(merchantId: string): Promise<string | null> {
  const [merchant] = await db
    .select({ slug: merchantsTable.slug })
    .from(merchantsTable)
    .where(eq(merchantsTable.id, merchantId))
    .limit(1);
  return merchant?.slug ?? null;
}

export const distributionService = {
  async createConnection(merchantId: string, input: CreateConnectionInput) {
    if (!hasAdapter(input.platform)) {
      throw new Error(`Unsupported platform: ${input.platform}`);
    }

    const adapter = getAdapter(input.platform);

    if (input.credentials) {
      const validation = await adapter.validateCredentials(input.credentials);
      if (!validation.valid) {
        throw new Error(`Invalid credentials: ${validation.error}`);
      }
    }

    const encryptedCredentials = input.credentials
      ? encrypt(JSON.stringify(input.credentials))
      : null;

    const [connection] = await db
      .insert(platformConnectionsTable)
      .values({
        merchantId,
        platform: input.platform,
        displayName: input.displayName,
        connectionStatus: "pending",
        credentials: encryptedCredentials,
        config: input.config ?? {},
        syncSchedule: input.syncSchedule ?? "manual",
      })
      .returning();

    await db.insert(distributionEventsTable).values({
      merchantId,
      platformConnectionId: connection.id,
      eventType: "connection_created",
      metadata: { platform: input.platform, displayName: input.displayName },
    });

    return connection;
  },

  async updateConnection(connectionId: string, merchantId: string, input: UpdateConnectionInput) {
    const [existing] = await db
      .select()
      .from(platformConnectionsTable)
      .where(and(eq(platformConnectionsTable.id, connectionId), eq(platformConnectionsTable.merchantId, merchantId)))
      .limit(1);

    if (!existing) {
      throw new Error("Connection not found");
    }

    const updates: Record<string, unknown> = { updatedAt: new Date() };

    if (input.displayName !== undefined) updates.displayName = input.displayName;
    if (input.syncSchedule !== undefined) updates.syncSchedule = input.syncSchedule;
    if (input.connectionStatus !== undefined) updates.connectionStatus = input.connectionStatus;
    if (input.config !== undefined) updates.config = input.config;

    if (input.credentials) {
      const adapter = getAdapter(existing.platform as DistributionPlatform);
      const validation = await adapter.validateCredentials(input.credentials);
      if (!validation.valid) {
        throw new Error(`Invalid credentials: ${validation.error}`);
      }
      updates.credentials = encrypt(JSON.stringify(input.credentials));
    }

    const [updated] = await db
      .update(platformConnectionsTable)
      .set(updates)
      .where(eq(platformConnectionsTable.id, connectionId))
      .returning();

    return updated;
  },

  async deleteConnection(connectionId: string, merchantId: string) {
    const [existing] = await db
      .select({ id: platformConnectionsTable.id })
      .from(platformConnectionsTable)
      .where(and(eq(platformConnectionsTable.id, connectionId), eq(platformConnectionsTable.merchantId, merchantId)))
      .limit(1);

    if (!existing) {
      throw new Error("Connection not found");
    }

    await db
      .delete(platformConnectionsTable)
      .where(eq(platformConnectionsTable.id, connectionId));
  },

  async listConnections(merchantId: string) {
    return db
      .select()
      .from(platformConnectionsTable)
      .where(eq(platformConnectionsTable.merchantId, merchantId))
      .orderBy(desc(platformConnectionsTable.createdAt));
  },

  async getConnection(connectionId: string, merchantId: string) {
    const [conn] = await db
      .select()
      .from(platformConnectionsTable)
      .where(and(eq(platformConnectionsTable.id, connectionId), eq(platformConnectionsTable.merchantId, merchantId)))
      .limit(1);
    return conn ?? null;
  },

  async testConnection(connectionId: string, merchantId: string) {
    const [conn] = await db
      .select()
      .from(platformConnectionsTable)
      .where(and(eq(platformConnectionsTable.id, connectionId), eq(platformConnectionsTable.merchantId, merchantId)))
      .limit(1);

    if (!conn) {
      throw new Error("Connection not found");
    }

    const adapter = getAdapter(conn.platform as DistributionPlatform);
    const result = await adapter.testConnection(connectionId);

    const newStatus = result.healthy ? "connected" : "error";
    await db
      .update(platformConnectionsTable)
      .set({
        connectionStatus: newStatus,
        apiHealthPct: result.healthy ? 100.0 : 0.0,
        lastSyncError: result.error ?? null,
        updatedAt: new Date(),
      })
      .where(eq(platformConnectionsTable.id, connectionId));

    await db.insert(distributionEventsTable).values({
      merchantId,
      platformConnectionId: connectionId,
      eventType: "health_check",
      metadata: { healthy: result.healthy, latencyMs: result.latencyMs, error: result.error },
    });

    return result;
  },

  async triggerSync(connectionId: string, merchantId: string, syncType: SyncType) {
    const [conn] = await db
      .select()
      .from(platformConnectionsTable)
      .where(and(eq(platformConnectionsTable.id, connectionId), eq(platformConnectionsTable.merchantId, merchantId)))
      .limit(1);

    if (!conn) {
      throw new Error("Connection not found");
    }

    const adapter = getAdapter(conn.platform as DistributionPlatform);
    const config = (conn.config ?? {}) as Record<string, unknown>;
    const minScore = Number(config.minReadinessScore ?? 50);

    // Create job record
    const [job] = await db
      .insert(distributionJobsTable)
      .values({
        merchantId,
        platformConnectionId: connectionId,
        jobType: syncType,
        status: "queued",
      })
      .returning();

    // Update connection status
    await db
      .update(platformConnectionsTable)
      .set({ connectionStatus: "syncing", updatedAt: new Date() })
      .where(eq(platformConnectionsTable.id, connectionId));

    // Run sync asynchronously
    setImmediate(async () => {
      const startedAt = new Date();
      try {
        await db
          .update(distributionJobsTable)
          .set({ status: "running", startedAt })
          .where(eq(distributionJobsTable.id, job.id));

        // Fetch products to sync
        const conditions = [
          eq(normalizedProductsTable.merchantId, merchantId),
          or(
            eq(normalizedProductsTable.normalizationStatus, "normalized"),
            eq(normalizedProductsTable.normalizationStatus, "reviewed"),
          )!,
          gte(normalizedProductsTable.agentReadinessScore, minScore),
        ];

        if (syncType === "delta_sync" && conn.lastSyncAt) {
          conditions.push(gte(normalizedProductsTable.updatedAt, conn.lastSyncAt));
        }

        const products = await db
          .select()
          .from(normalizedProductsTable)
          .where(and(...conditions));

        let pushed = products.length;
        let failed = 0;
        const errors: Array<{ sku?: string; error: string }> = [];

        // For push platforms, actually push data
        if (adapter.pushProducts) {
          const batchSize = 100;
          for (let i = 0; i < products.length; i += batchSize) {
            const batch = products.slice(i, i + batchSize);
            try {
              const result = await adapter.pushProducts(connectionId, batch);
              pushed = result.pushed;
              failed += result.failed;
              errors.push(...result.errors);
            } catch (err) {
              failed += batch.length;
              errors.push({ error: `Batch ${Math.floor(i / batchSize)}: ${String(err)}` });
            }

            await db
              .update(distributionJobsTable)
              .set({ processedRecords: Math.min(i + batchSize, products.length) })
              .where(eq(distributionJobsTable.id, job.id));
          }
        }

        // For pull platforms, regenerate the spec
        if (adapter.generateSpec) {
          const slug = await getMerchantSlug(merchantId);
          if (slug) {
            const baseUrl = process.env["API_BASE_URL"] ?? "https://api.vare-ai.com";
            await adapter.generateSpec(slug, connectionId, baseUrl);

            await db.insert(distributionEventsTable).values({
              merchantId,
              platformConnectionId: connectionId,
              eventType: "spec_generated",
              metadata: { productCount: products.length },
            });
          }
        }

        const completedAt = new Date();
        const durationSeconds = Math.round((completedAt.getTime() - startedAt.getTime()) / 1000);

        await db
          .update(distributionJobsTable)
          .set({
            status: failed > 0 ? "completed" : "completed",
            totalRecords: products.length,
            processedRecords: products.length,
            errorCount: failed,
            errorLog: errors.length > 0 ? errors : null,
            completedAt,
            durationSeconds,
          })
          .where(eq(distributionJobsTable.id, job.id));

        await db
          .update(platformConnectionsTable)
          .set({
            connectionStatus: "connected",
            lastSyncAt: completedAt,
            lastSyncStatus: failed > 0 ? "partial" : "success",
            lastSyncError: null,
            productsSynced: products.length - failed,
            updatedAt: completedAt,
          })
          .where(eq(platformConnectionsTable.id, connectionId));
      } catch (err) {
        logger.error({ jobId: job.id, err }, "Distribution sync failed");

        const completedAt = new Date();
        await db
          .update(distributionJobsTable)
          .set({
            status: "failed",
            errorLog: [{ error: String(err), timestamp: completedAt.toISOString() }],
            completedAt,
            durationSeconds: Math.round((completedAt.getTime() - startedAt.getTime()) / 1000),
          })
          .where(eq(distributionJobsTable.id, job.id));

        await db
          .update(platformConnectionsTable)
          .set({
            connectionStatus: "error",
            lastSyncStatus: "failed",
            lastSyncError: String(err),
            updatedAt: completedAt,
          })
          .where(eq(platformConnectionsTable.id, connectionId));
      }
    });

    return job;
  },

  async getSpec(connectionId: string, merchantId: string): Promise<PlatformSpec | null> {
    const [conn] = await db
      .select()
      .from(platformConnectionsTable)
      .where(and(eq(platformConnectionsTable.id, connectionId), eq(platformConnectionsTable.merchantId, merchantId)))
      .limit(1);

    if (!conn) return null;

    const adapter = getAdapter(conn.platform as DistributionPlatform);
    if (!adapter.generateSpec) return null;

    const slug = await getMerchantSlug(merchantId);
    if (!slug) return null;

    const baseUrl = process.env["API_BASE_URL"] ?? "https://api.vare-ai.com";
    return adapter.generateSpec(slug, connectionId, baseUrl);
  },

  async getSpecBySlugAndPlatform(merchantSlug: string, platform: DistributionPlatform): Promise<PlatformSpec | null> {
    const [merchant] = await db
      .select({ id: merchantsTable.id })
      .from(merchantsTable)
      .where(eq(merchantsTable.slug, merchantSlug))
      .limit(1);

    if (!merchant) return null;

    const [conn] = await db
      .select()
      .from(platformConnectionsTable)
      .where(
        and(
          eq(platformConnectionsTable.merchantId, merchant.id),
          eq(platformConnectionsTable.platform, platform),
          eq(platformConnectionsTable.connectionStatus, "connected"),
        ),
      )
      .limit(1);

    if (!conn) return null;

    const adapter = getAdapter(platform);
    if (!adapter.generateSpec) return null;

    const baseUrl = process.env["API_BASE_URL"] ?? "https://api.vare-ai.com";
    return adapter.generateSpec(merchantSlug, conn.id, baseUrl);
  },

  async listJobs(connectionId: string, merchantId: string, page = 1, limit = 20) {
    const offset = (page - 1) * limit;
    const jobs = await db
      .select()
      .from(distributionJobsTable)
      .where(
        and(
          eq(distributionJobsTable.platformConnectionId, connectionId),
          eq(distributionJobsTable.merchantId, merchantId),
        ),
      )
      .orderBy(desc(distributionJobsTable.createdAt))
      .limit(limit)
      .offset(offset);

    return jobs;
  },

  getPlatformMetadata() {
    return listPlatformMetadata();
  },
};
