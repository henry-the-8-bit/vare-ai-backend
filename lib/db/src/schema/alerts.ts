import { pgTable, uuid, varchar, boolean, text, timestamp } from "drizzle-orm/pg-core";
import { merchantsTable } from "./merchants";

export const systemAlertsTable = pgTable("system_alerts", {
  id: uuid("id").primaryKey().defaultRandom(),
  merchantId: uuid("merchant_id").references(() => merchantsTable.id, { onDelete: "cascade" }),
  alertType: varchar("alert_type", { length: 20 }),
  title: varchar("title", { length: 255 }),
  description: text("description"),
  suggestion: text("suggestion"),
  isRead: boolean("is_read").default(false),
  createdAt: timestamp("created_at").defaultNow(),
});

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
