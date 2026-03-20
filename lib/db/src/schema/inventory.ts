import { pgTable, uuid, varchar, integer, boolean, timestamp, index } from "drizzle-orm/pg-core";
import { merchantsTable } from "./merchants";

export const inventoryTable = pgTable(
  "inventory",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id").references(() => merchantsTable.id, { onDelete: "cascade" }),
    sku: varchar("sku", { length: 255 }).notNull(),
    quantity: integer("quantity"),
    isInStock: boolean("is_in_stock"),
    lowStockThreshold: integer("low_stock_threshold").default(5),
    sourceName: varchar("source_name", { length: 255 }),
    lastProbed: timestamp("last_probed"),
    probeLatencyMs: integer("probe_latency_ms"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (t) => [index("idx_inventory_merchant_sku").on(t.merchantId, t.sku)],
);

export const probeConfigsTable = pgTable("probe_configs", {
  id: uuid("id").primaryKey().defaultRandom(),
  merchantId: uuid("merchant_id").references(() => merchantsTable.id, { onDelete: "cascade" }),
  inventorySource: varchar("inventory_source", { length: 50 }).default("magento"),
  probeFrequency: varchar("probe_frequency", { length: 50 }).default("cached"),
  cacheTtlMinutes: integer("cache_ttl_minutes").default(5),
  fallbackBehavior: varchar("fallback_behavior", { length: 50 }).default("last_known"),
  lowStockThreshold: integer("low_stock_threshold").default(5),
  createdAt: timestamp("created_at").defaultNow(),
});

export type Inventory = typeof inventoryTable.$inferSelect;
export type ProbeConfig = typeof probeConfigsTable.$inferSelect;
