import { db } from "@workspace/db";
import {
  feedsTable,
  syncJobsTable,
  rawProductsTable,
  magentoConnectionsTable,
  type Feed,
} from "@workspace/db/schema";
import { eq, and, desc, sql, gte } from "drizzle-orm";
import { catalogSyncService, type SyncConfig } from "./catalogSync.js";
import { logger } from "../lib/logger.js";

export interface FeedResponse {
  id: string;
  name: string;
  type: string;
  source: string;
  status: string;
  lastSync: string | null;
  itemCount: number;
  updatedPerDay: number;
  errorCount: number;
  avgSyncDuration: string;
  syncActivity: ("ok" | "error" | "idle")[];
  syncCount24h: number;
  errorMessage: string | null;
}

interface CreateFeedInput {
  name: string;
  type: string;
  source: string;
  sourceConnectionId?: string;
  config?: Record<string, unknown>;
  syncSchedule?: string;
}

interface UpdateFeedInput {
  name?: string;
  type?: string;
  source?: string;
  config?: Record<string, unknown>;
  syncSchedule?: string;
}

interface TestResult {
  success: boolean;
  latencyMs: number;
  error?: string;
}

export class FeedService {
  async listFeeds(merchantId: string): Promise<FeedResponse[]> {
    const feeds = await db
      .select()
      .from(feedsTable)
      .where(eq(feedsTable.merchantId, merchantId))
      .orderBy(desc(feedsTable.createdAt));

    const enriched = await Promise.all(feeds.map((f: Feed) => this.enrichFeed(f, merchantId)));
    return enriched;
  }

  async getFeed(merchantId: string, feedId: string) {
    const [feed] = await db
      .select()
      .from(feedsTable)
      .where(and(eq(feedsTable.id, feedId), eq(feedsTable.merchantId, merchantId)))
      .limit(1);
    return feed ?? null;
  }

  async createFeed(merchantId: string, input: CreateFeedInput) {
    const [feed] = await db
      .insert(feedsTable)
      .values({
        merchantId,
        name: input.name,
        type: input.type,
        source: input.source,
        sourceConnectionId: input.sourceConnectionId ?? null,
        config: input.config ?? null,
        syncSchedule: input.syncSchedule ?? null,
      })
      .returning();

    return feed;
  }

  async updateFeed(merchantId: string, feedId: string, input: UpdateFeedInput) {
    const existing = await this.getFeed(merchantId, feedId);
    if (!existing) return null;

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (input.name !== undefined) updates.name = input.name;
    if (input.type !== undefined) updates.type = input.type;
    if (input.source !== undefined) updates.source = input.source;
    if (input.config !== undefined) updates.config = input.config;
    if (input.syncSchedule !== undefined) updates.syncSchedule = input.syncSchedule;

    const [updated] = await db
      .update(feedsTable)
      .set(updates)
      .where(and(eq(feedsTable.id, feedId), eq(feedsTable.merchantId, merchantId)))
      .returning();

    return updated;
  }

  async deleteFeed(merchantId: string, feedId: string): Promise<boolean> {
    const existing = await this.getFeed(merchantId, feedId);
    if (!existing) return false;

    await db
      .delete(feedsTable)
      .where(and(eq(feedsTable.id, feedId), eq(feedsTable.merchantId, merchantId)));

    return true;
  }

  async triggerSync(merchantId: string, feedId: string) {
    const feed = await this.getFeed(merchantId, feedId);
    if (!feed) return null;

    if (feed.status === "paused") {
      return { error: "Feed is paused. Resume before syncing." };
    }

    // Update feed status to syncing
    await db
      .update(feedsTable)
      .set({ status: "syncing", updatedAt: new Date() })
      .where(eq(feedsTable.id, feedId));

    const isMagento = feed.source === "Magento 2" || feed.source === "Magento 1";

    if (isMagento) {
      const config = (feed.config as SyncConfig) ?? {
        productTypes: ["simple", "configurable"],
        status: ["1"],
      };

      const job = await catalogSyncService.startFullSync(merchantId, config);

      // Update sync_job with feedId
      await db
        .update(syncJobsTable)
        .set({ feedId })
        .where(eq(syncJobsTable.id, job.id));

      // Update feed's last sync reference
      await db
        .update(feedsTable)
        .set({ lastSyncAt: new Date(), lastSyncJobId: job.id })
        .where(eq(feedsTable.id, feedId));

      return { jobId: job.id, status: job.status, feedId };
    }

    // For non-Magento sources, create a generic sync_job record
    const [job] = await db
      .insert(syncJobsTable)
      .values({
        merchantId,
        feedId,
        jobType: `${feed.source.toLowerCase().replace(/\s+/g, "_")}_sync`,
        status: "queued",
        config: feed.config,
      })
      .returning();

    await db
      .update(feedsTable)
      .set({ lastSyncAt: new Date(), lastSyncJobId: job.id })
      .where(eq(feedsTable.id, feedId));

    return { jobId: job.id, status: job.status, feedId };
  }

  async togglePause(merchantId: string, feedId: string) {
    const feed = await this.getFeed(merchantId, feedId);
    if (!feed) return null;

    const newStatus = feed.status === "paused" ? "active" : "paused";

    // If pausing, also pause any active sync jobs for this feed
    if (newStatus === "paused") {
      const activeJobs = await db
        .select({ id: syncJobsTable.id })
        .from(syncJobsTable)
        .where(
          and(
            eq(syncJobsTable.feedId, feedId),
            sql`status IN ('queued', 'running')`,
          ),
        );

      for (const job of activeJobs) {
        catalogSyncService.pauseJob(job.id);
      }
    }

    const [updated] = await db
      .update(feedsTable)
      .set({ status: newStatus, updatedAt: new Date() })
      .where(and(eq(feedsTable.id, feedId), eq(feedsTable.merchantId, merchantId)))
      .returning();

    return updated;
  }

  async testConnection(merchantId: string, feedId: string): Promise<TestResult> {
    const feed = await this.getFeed(merchantId, feedId);
    if (!feed) return { success: false, latencyMs: 0, error: "Feed not found" };

    const start = Date.now();

    try {
      const isMagento = feed.source === "Magento 2" || feed.source === "Magento 1";

      if (isMagento) {
        // Find associated Magento connection
        const connectionId = feed.sourceConnectionId;
        if (!connectionId) {
          return { success: false, latencyMs: 0, error: "No Magento connection linked to this feed" };
        }

        const [conn] = await db
          .select()
          .from(magentoConnectionsTable)
          .where(
            and(
              eq(magentoConnectionsTable.id, connectionId),
              eq(magentoConnectionsTable.merchantId, merchantId),
            ),
          )
          .limit(1);

        if (!conn) {
          return { success: false, latencyMs: Date.now() - start, error: "Magento connection not found" };
        }

        return {
          success: conn.connectionStatus === "connected",
          latencyMs: Date.now() - start,
          error: conn.connectionStatus !== "connected" ? `Connection status: ${conn.connectionStatus}` : undefined,
        };
      }

      if (feed.source === "Feed URL") {
        const config = feed.config as { url?: string } | null;
        if (!config?.url) {
          return { success: false, latencyMs: Date.now() - start, error: "No URL configured" };
        }

        const response = await fetch(config.url, { method: "HEAD", signal: AbortSignal.timeout(10000) });
        return {
          success: response.ok,
          latencyMs: Date.now() - start,
          error: response.ok ? undefined : `HTTP ${response.status}`,
        };
      }

      // CSV Upload and other static sources are always "connected"
      if (feed.source === "CSV Upload" || feed.type === "static") {
        return { success: true, latencyMs: Date.now() - start };
      }

      // Shopify, SFCC, Generic — placeholder
      return { success: true, latencyMs: Date.now() - start };
    } catch (err) {
      logger.error({ feedId, err }, "Feed connection test failed");
      return { success: false, latencyMs: Date.now() - start, error: String(err) };
    }
  }

  private async enrichFeed(
    feed: Feed,
    merchantId: string,
  ): Promise<FeedResponse> {
    const now24hAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // Run computed field queries in parallel
    const [itemCountRows, updatedPerDayRows, syncStatsRows, recentJobsRows] = await Promise.all([
      // Item count - products for this merchant (feed-scoped when feedId is populated on products)
      db
        .select({ cnt: sql<number>`count(*)` })
        .from(rawProductsTable)
        .where(eq(rawProductsTable.merchantId, merchantId)),

      // Updated per day - products updated in last 24h
      db
        .select({ cnt: sql<number>`count(*)` })
        .from(rawProductsTable)
        .where(
          and(
            eq(rawProductsTable.merchantId, merchantId),
            gte(rawProductsTable.updatedAt, now24hAgo),
          ),
        ),

      // Sync stats from sync_jobs linked to this feed (or merchant-scoped fallback)
      db
        .select({
          errorSum: sql<number>`coalesce(sum(error_count), 0)`,
          avgDuration: sql<number>`coalesce(avg(duration_seconds), 0)`,
          totalJobs: sql<number>`count(*)`,
        })
        .from(syncJobsTable)
        .where(
          and(
            eq(syncJobsTable.merchantId, merchantId),
            feed.id ? eq(syncJobsTable.feedId, feed.id) : sql`true`,
            gte(syncJobsTable.createdAt, now24hAgo),
          ),
        ),

      // Recent jobs for sync activity (last 24 hourly buckets)
      db
        .select({
          hour: sql<string>`date_trunc('hour', created_at)::text`,
          hasError: sql<boolean>`bool_or(status = 'failed' or error_count > 0)`,
          hasCompleted: sql<boolean>`bool_or(status = 'completed')`,
        })
        .from(syncJobsTable)
        .where(
          and(
            eq(syncJobsTable.merchantId, merchantId),
            feed.id ? eq(syncJobsTable.feedId, feed.id) : sql`true`,
            gte(syncJobsTable.createdAt, now24hAgo),
          ),
        )
        .groupBy(sql`date_trunc('hour', created_at)`),
    ]);

    const itemCount = Number(itemCountRows[0]?.cnt ?? 0);
    const updatedPerDay = Number(updatedPerDayRows[0]?.cnt ?? 0);
    const errorCount = Number(syncStatsRows[0]?.errorSum ?? 0);
    const avgDurationSec = Number(syncStatsRows[0]?.avgDuration ?? 0);
    const syncCount24h = Number(syncStatsRows[0]?.totalJobs ?? 0);

    // Format average duration
    const avgSyncDuration =
      avgDurationSec > 60
        ? `${Math.round(avgDurationSec / 60)}m ${Math.round(avgDurationSec % 60)}s`
        : `${Math.round(avgDurationSec)}s`;

    // Build 24-hour sync activity array
    const hourMap = new Map<string, { hasError: boolean; hasCompleted: boolean }>();
    for (const row of recentJobsRows) {
      hourMap.set(row.hour, { hasError: Boolean(row.hasError), hasCompleted: Boolean(row.hasCompleted) });
    }

    const syncActivity: ("ok" | "error" | "idle")[] = [];
    for (let i = 23; i >= 0; i--) {
      const hourDate = new Date(Date.now() - i * 60 * 60 * 1000);
      hourDate.setMinutes(0, 0, 0);
      const hourKey = hourDate.toISOString().replace(/\.\d{3}Z$/, "+00");
      const bucket = hourMap.get(hourKey);
      if (bucket?.hasError) {
        syncActivity.push("error");
      } else if (bucket?.hasCompleted) {
        syncActivity.push("ok");
      } else {
        syncActivity.push("idle");
      }
    }

    // Format lastSync as relative time
    let lastSync: string | null = null;
    if (feed.lastSyncAt) {
      const diffMs = Date.now() - feed.lastSyncAt.getTime();
      const diffMin = Math.round(diffMs / 60000);
      if (diffMin < 1) lastSync = "just now";
      else if (diffMin < 60) lastSync = `${diffMin} minute${diffMin === 1 ? "" : "s"} ago`;
      else if (diffMin < 1440) {
        const hours = Math.round(diffMin / 60);
        lastSync = `${hours} hour${hours === 1 ? "" : "s"} ago`;
      } else {
        const days = Math.round(diffMin / 1440);
        lastSync = `${days} day${days === 1 ? "" : "s"} ago`;
      }
    }

    return {
      id: feed.id,
      name: feed.name,
      type: feed.type,
      source: feed.source,
      status: feed.status,
      lastSync,
      itemCount,
      updatedPerDay,
      errorCount,
      avgSyncDuration,
      syncActivity,
      syncCount24h,
      errorMessage: feed.errorMessage,
    };
  }
}

export const feedService = new FeedService();
