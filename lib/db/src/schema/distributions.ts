import {
  pgTable,
  uuid,
  varchar,
  boolean,
  integer,
  text,
  jsonb,
  timestamp,
  index,
  unique,
} from "drizzle-orm/pg-core";
import { merchantsTable } from "./merchants";

/**
 * Merchant distribution preferences.
 *
 * Vare manages the integration with each AI platform centrally (hub model).
 * Merchants simply toggle which platforms they want their catalog distributed to
 * and optionally configure filters (min readiness score, category filters, etc.).
 * No per-merchant API keys or platform credentials are needed.
 */
export const merchantDistributionsTable = pgTable(
  "merchant_distributions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .references(() => merchantsTable.id, { onDelete: "cascade" })
      .notNull(),
    platform: varchar("platform", { length: 50 }).notNull(), // "chatgpt" | "gemini" | "perplexity"
    enabled: boolean("enabled").default(false).notNull(),
    config: jsonb("config"), // merchant-specific preferences: { minReadinessScore, categoryFilter, includeFitment, etc. }
    lastSyncAt: timestamp("last_sync_at"),
    lastSyncStatus: varchar("last_sync_status", { length: 20 }), // "success" | "partial" | "failed"
    lastSyncError: text("last_sync_error"),
    productsSynced: integer("products_synced").default(0),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (t) => [
    index("idx_merchant_distributions_merchant").on(t.merchantId),
    unique("uq_merchant_distributions_merchant_platform").on(t.merchantId, t.platform),
  ],
);

/**
 * Distribution sync jobs — tracks batch syncs to push platforms.
 * For pull platforms (ChatGPT, Gemini), syncs regenerate the cached product count.
 * For push platforms, syncs push product data to the platform on behalf of all enabled merchants.
 */
export const distributionJobsTable = pgTable(
  "distribution_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .references(() => merchantsTable.id, { onDelete: "cascade" }),
    platform: varchar("platform", { length: 50 }).notNull(),
    jobType: varchar("job_type", { length: 50 }).notNull(), // "full_sync" | "delta_sync" | "product_count_update"
    status: varchar("status", { length: 20 }).default("queued").notNull(),
    totalRecords: integer("total_records").default(0),
    processedRecords: integer("processed_records").default(0),
    errorCount: integer("error_count").default(0),
    errorLog: jsonb("error_log"),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    durationSeconds: integer("duration_seconds"),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (t) => [
    index("idx_distribution_jobs_merchant").on(t.merchantId),
    index("idx_distribution_jobs_platform").on(t.platform),
  ],
);

/**
 * Distribution event audit log.
 */
export const distributionEventsTable = pgTable(
  "distribution_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .references(() => merchantsTable.id, { onDelete: "cascade" }),
    platform: varchar("platform", { length: 50 }).notNull(),
    eventType: varchar("event_type", { length: 50 }).notNull(), // "enabled" | "disabled" | "sync_completed" | "spec_served" | "error"
    sku: varchar("sku", { length: 255 }),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (t) => [index("idx_distribution_events_merchant_date").on(t.merchantId, t.createdAt)],
);

export type MerchantDistribution = typeof merchantDistributionsTable.$inferSelect;
export type InsertMerchantDistribution = typeof merchantDistributionsTable.$inferInsert;
export type DistributionJob = typeof distributionJobsTable.$inferSelect;
export type InsertDistributionJob = typeof distributionJobsTable.$inferInsert;
export type DistributionEvent = typeof distributionEventsTable.$inferSelect;
