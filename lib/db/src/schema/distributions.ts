import {
  pgTable,
  uuid,
  varchar,
  integer,
  text,
  jsonb,
  timestamp,
  real,
  index,
  unique,
} from "drizzle-orm/pg-core";
import { merchantsTable } from "./merchants";

export const platformConnectionsTable = pgTable(
  "platform_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .references(() => merchantsTable.id, { onDelete: "cascade" })
      .notNull(),
    platform: varchar("platform", { length: 50 }).notNull(), // "chatgpt" | "gemini" | "perplexity" | "claude" | "custom"
    displayName: varchar("display_name", { length: 255 }).notNull(),
    connectionStatus: varchar("connection_status", { length: 20 }).default("pending").notNull(), // "pending" | "connected" | "syncing" | "error" | "disabled"
    credentials: varchar("credentials", { length: 2000 }), // AES-256-GCM encrypted
    config: jsonb("config"), // platform-specific settings
    syncSchedule: varchar("sync_schedule", { length: 50 }), // cron expression or "manual"
    lastSyncAt: timestamp("last_sync_at"),
    lastSyncStatus: varchar("last_sync_status", { length: 20 }), // "success" | "partial" | "failed"
    lastSyncError: text("last_sync_error"),
    productsSynced: integer("products_synced").default(0),
    apiHealthPct: real("api_health_pct").default(100.0),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (t) => [
    index("idx_platform_connections_merchant").on(t.merchantId),
    index("idx_platform_connections_merchant_platform").on(t.merchantId, t.platform),
  ],
);

export const distributionJobsTable = pgTable(
  "distribution_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .references(() => merchantsTable.id, { onDelete: "cascade" })
      .notNull(),
    platformConnectionId: uuid("platform_connection_id")
      .references(() => platformConnectionsTable.id, { onDelete: "cascade" })
      .notNull(),
    jobType: varchar("job_type", { length: 50 }).notNull(), // "full_sync" | "delta_sync" | "openapi_regen" | "health_check"
    status: varchar("status", { length: 20 }).default("queued").notNull(), // "queued" | "running" | "completed" | "failed" | "cancelled"
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
    index("idx_distribution_jobs_connection").on(t.platformConnectionId),
    index("idx_distribution_jobs_merchant").on(t.merchantId),
  ],
);

export const distributionEventsTable = pgTable(
  "distribution_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .references(() => merchantsTable.id, { onDelete: "cascade" })
      .notNull(),
    platformConnectionId: uuid("platform_connection_id").references(() => platformConnectionsTable.id, { onDelete: "set null" }),
    eventType: varchar("event_type", { length: 50 }).notNull(), // "product_pushed" | "product_removed" | "spec_generated" | "health_check" | "error"
    sku: varchar("sku", { length: 255 }),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (t) => [index("idx_distribution_events_merchant_date").on(t.merchantId, t.createdAt)],
);

export type PlatformConnection = typeof platformConnectionsTable.$inferSelect;
export type InsertPlatformConnection = typeof platformConnectionsTable.$inferInsert;
export type DistributionJob = typeof distributionJobsTable.$inferSelect;
export type InsertDistributionJob = typeof distributionJobsTable.$inferInsert;
export type DistributionEvent = typeof distributionEventsTable.$inferSelect;
