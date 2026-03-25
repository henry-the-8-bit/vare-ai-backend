import { pgTable, uuid, varchar, text, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { merchantsTable } from "./merchants";

export const feedsTable = pgTable(
  "feeds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .references(() => merchantsTable.id, { onDelete: "cascade" })
      .notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    type: varchar("type", { length: 20 }).notNull(), // "live" | "static"
    source: varchar("source", { length: 50 }).notNull(), // "Magento 2" | "Magento 1" | "Shopify" | "SFCC" | "CSV Upload" | "Feed URL" | "Generic"
    status: varchar("status", { length: 20 }).default("active").notNull(), // "active" | "syncing" | "warning" | "error" | "paused"
    sourceConnectionId: uuid("source_connection_id"), // generic pointer to magento_connections.id, csv_uploads.id, etc. (no FK)
    config: jsonb("config"), // platform-specific settings
    syncSchedule: varchar("sync_schedule", { length: 50 }), // cron expression or "manual"
    errorMessage: text("error_message"),
    lastSyncAt: timestamp("last_sync_at"),
    lastSyncJobId: uuid("last_sync_job_id"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (t) => [index("idx_feeds_merchant").on(t.merchantId)],
);

export type Feed = typeof feedsTable.$inferSelect;
export type InsertFeed = typeof feedsTable.$inferInsert;
