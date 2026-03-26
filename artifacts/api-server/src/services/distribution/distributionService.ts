import { db } from "@workspace/db";
import {
  merchantDistributionsTable,
  distributionJobsTable,
  distributionEventsTable,
  normalizedProductsTable,
  merchantsTable,
} from "@workspace/db/schema";
import { eq, and, desc, gte, or, sql } from "drizzle-orm";
import { logger } from "../../lib/logger.js";
import { getAdapter, listPlatformMetadata, hasAdapter } from "./adapters/index.js";
import type { DistributionPlatform, MerchantDistributionConfig, PlatformSpec } from "./types.js";

/**
 * Distribution service — Vare-managed hub model.
 *
 * Vare manages the integration with each AI platform centrally.
 * Merchants just toggle platforms on/off and optionally set filters.
 * No per-merchant API keys or platform credentials needed.
 */
export const distributionService = {
  /**
   * Get a merchant's distribution preferences for all platforms.
   * Returns existing rows + placeholder entries for platforms not yet configured.
   */
  async listDistributions(merchantId: string) {
    const existing = await db
      .select()
      .from(merchantDistributionsTable)
      .where(eq(merchantDistributionsTable.merchantId, merchantId))
      .orderBy(merchantDistributionsTable.platform);

    const allPlatforms = listPlatformMetadata();
    const existingMap = new Map(existing.map((d) => [d.platform, d]));

    return allPlatforms.map((pm) => {
      const dist = existingMap.get(pm.id);
      return {
        platform: pm.id,
        label: pm.label,
        description: pm.description,
        icon: pm.icon,
        type: pm.type,
        enabled: dist?.enabled ?? false,
        config: dist?.config ?? {},
        productsSynced: dist?.productsSynced ?? 0,
        lastSyncAt: dist?.lastSyncAt?.toISOString() ?? null,
        lastSyncStatus: dist?.lastSyncStatus ?? null,
        lastSyncError: dist?.lastSyncError ?? null,
      };
    });
  },

  /**
   * Toggle a platform on/off for a merchant, optionally updating config.
   */
  async togglePlatform(
    merchantId: string,
    platform: DistributionPlatform,
    enabled: boolean,
    config?: MerchantDistributionConfig,
  ) {
    if (!hasAdapter(platform)) {
      throw new Error(`Unsupported platform: ${platform}`);
    }

    const [existing] = await db
      .select()
      .from(merchantDistributionsTable)
      .where(
        and(
          eq(merchantDistributionsTable.merchantId, merchantId),
          eq(merchantDistributionsTable.platform, platform),
        ),
      )
      .limit(1);

    if (existing) {
      const updates: Record<string, unknown> = { enabled, updatedAt: new Date() };
      if (config !== undefined) updates.config = config;

      const [updated] = await db
        .update(merchantDistributionsTable)
        .set(updates)
        .where(eq(merchantDistributionsTable.id, existing.id))
        .returning();

      await db.insert(distributionEventsTable).values({
        merchantId,
        platform,
        eventType: enabled ? "enabled" : "disabled",
        metadata: { config },
      });

      // If enabling, update product count
      if (enabled) {
        await this.updateProductCount(merchantId, platform);
      }

      return updated;
    } else {
      const [created] = await db
        .insert(merchantDistributionsTable)
        .values({
          merchantId,
          platform,
          enabled,
          config: config ?? {},
        })
        .returning();

      await db.insert(distributionEventsTable).values({
        merchantId,
        platform,
        eventType: enabled ? "enabled" : "disabled",
        metadata: { config },
      });

      if (enabled) {
        await this.updateProductCount(merchantId, platform);
      }

      return created;
    }
  },

  /**
   * Update distribution config for a merchant+platform.
   */
  async updateConfig(merchantId: string, platform: DistributionPlatform, config: MerchantDistributionConfig) {
    const [existing] = await db
      .select()
      .from(merchantDistributionsTable)
      .where(
        and(
          eq(merchantDistributionsTable.merchantId, merchantId),
          eq(merchantDistributionsTable.platform, platform),
        ),
      )
      .limit(1);

    if (!existing) {
      throw new Error("Distribution not found. Toggle the platform first.");
    }

    const [updated] = await db
      .update(merchantDistributionsTable)
      .set({ config, updatedAt: new Date() })
      .where(eq(merchantDistributionsTable.id, existing.id))
      .returning();

    return updated;
  },

  /**
   * Count eligible products for a merchant+platform and update the stored count.
   */
  async updateProductCount(merchantId: string, platform: DistributionPlatform) {
    const [dist] = await db
      .select()
      .from(merchantDistributionsTable)
      .where(
        and(
          eq(merchantDistributionsTable.merchantId, merchantId),
          eq(merchantDistributionsTable.platform, platform),
        ),
      )
      .limit(1);

    const config = (dist?.config ?? {}) as MerchantDistributionConfig;
    const minScore = config.minReadinessScore ?? 50;

    const [result] = await db
      .select({ count: sql<number>`count(*)` })
      .from(normalizedProductsTable)
      .where(
        and(
          eq(normalizedProductsTable.merchantId, merchantId),
          or(
            eq(normalizedProductsTable.normalizationStatus, "normalized"),
            eq(normalizedProductsTable.normalizationStatus, "reviewed"),
          )!,
          gte(normalizedProductsTable.agentReadinessScore, minScore),
        ),
      );

    const count = Number(result?.count ?? 0);

    if (dist) {
      await db
        .update(merchantDistributionsTable)
        .set({
          productsSynced: count,
          lastSyncAt: new Date(),
          lastSyncStatus: "success",
          updatedAt: new Date(),
        })
        .where(eq(merchantDistributionsTable.id, dist.id));
    }

    return count;
  },

  /**
   * Batch update product counts for all enabled distributions.
   * Called by background jobs.
   */
  async updateAllProductCounts() {
    const enabledDists = await db
      .select()
      .from(merchantDistributionsTable)
      .where(eq(merchantDistributionsTable.enabled, true));

    for (const dist of enabledDists) {
      try {
        await this.updateProductCount(dist.merchantId, dist.platform as DistributionPlatform);
      } catch (err) {
        logger.warn({ merchantId: dist.merchantId, platform: dist.platform, err }, "[distribution] Failed to update product count");
      }
    }
  },

  /**
   * Get the Vare-wide platform spec (not per-merchant).
   * These are cached/regenerated periodically.
   */
  getSpec(platform: DistributionPlatform): PlatformSpec {
    const adapter = getAdapter(platform);
    const baseUrl = process.env["API_BASE_URL"] ?? "https://api.vare-ai.com";
    return adapter.generateSpec(baseUrl);
  },

  /**
   * List available platforms with metadata.
   */
  getPlatformMetadata() {
    return listPlatformMetadata();
  },

  /**
   * Get distribution jobs for a merchant.
   */
  async listJobs(merchantId: string, page = 1, limit = 20) {
    const offset = (page - 1) * limit;
    return db
      .select()
      .from(distributionJobsTable)
      .where(eq(distributionJobsTable.merchantId, merchantId))
      .orderBy(desc(distributionJobsTable.createdAt))
      .limit(limit)
      .offset(offset);
  },
};
