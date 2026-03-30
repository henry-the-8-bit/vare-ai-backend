import { pgTable, uuid, varchar, boolean, text, timestamp, index } from "drizzle-orm/pg-core";
import { merchantsTable } from "./merchants";

export const systemAlertsTable = pgTable(
  "system_alerts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id").references(() => merchantsTable.id, { onDelete: "cascade" }),
    alertType: varchar("alert_type", { length: 20 }), // "error" | "warning" | "info" | "success"
    severity: varchar("severity", { length: 20 }).default("info"), // "critical" | "error" | "warning" | "info"
    category: varchar("category", { length: 50 }), // "sync" | "connection" | "inventory" | "normalization" | "fitment" | "gateway" | "distribution" | "system"
    source: varchar("source", { length: 100 }), // service/job that created the alert
    title: varchar("title", { length: 255 }),
    description: text("description"),
    suggestion: text("suggestion"),
    relatedEntityId: uuid("related_entity_id"), // optional FK to feed, job, order, etc.
    relatedEntityType: varchar("related_entity_type", { length: 50 }), // "feed" | "job" | "order" | "product" | "connection"
    isRead: boolean("is_read").default(false),
    dismissedAt: timestamp("dismissed_at"),
    expiresAt: timestamp("expires_at"),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (t) => [
    index("idx_alerts_merchant_unread").on(t.merchantId, t.isRead, t.createdAt),
    index("idx_alerts_merchant_category").on(t.merchantId, t.category),
  ],
);

export const insightsTable = pgTable("insights", {
  id: uuid("id").primaryKey().defaultRandom(),
  merchantId: uuid("merchant_id").references(() => merchantsTable.id, { onDelete: "cascade" }),
  insightType: varchar("insight_type", { length: 50 }),
  badge: varchar("badge", { length: 100 }),
  text: text("text"),
  actionLabel: varchar("action_label", { length: 100 }),
  dateRange: varchar("date_range", { length: 20 }),
  createdAt: timestamp("created_at").defaultNow(),
});

export type SystemAlert = typeof systemAlertsTable.$inferSelect;
export type Insight = typeof insightsTable.$inferSelect;
