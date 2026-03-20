import {
  pgTable,
  uuid,
  varchar,
  integer,
  text,
  jsonb,
  timestamp,
  decimal,
  index,
} from "drizzle-orm/pg-core";
import { merchantsTable } from "./merchants";

export const rawProductsTable = pgTable(
  "raw_products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id").references(() => merchantsTable.id, { onDelete: "cascade" }),
    magentoProductId: integer("magento_product_id"),
    sku: varchar("sku", { length: 255 }).notNull(),
    productType: varchar("product_type", { length: 50 }),
    status: varchar("status", { length: 20 }),
    visibility: varchar("visibility", { length: 50 }),
    rawData: jsonb("raw_data").notNull(),
    syncedAt: timestamp("synced_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (t) => [index("idx_raw_products_merchant_sku").on(t.merchantId, t.sku)],
);

export const normalizedProductsTable = pgTable(
  "normalized_products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id").references(() => merchantsTable.id, { onDelete: "cascade" }),
    rawProductId: uuid("raw_product_id").references(() => rawProductsTable.id),
    sku: varchar("sku", { length: 255 }).notNull(),
    productTitle: varchar("product_title", { length: 500 }),
    description: text("description"),
    shortDescription: text("short_description"),
    brand: varchar("brand", { length: 255 }),
    manufacturer: varchar("manufacturer", { length: 255 }),
    mpn: varchar("mpn", { length: 255 }),
    upc: varchar("upc", { length: 50 }),
    price: decimal("price", { precision: 10, scale: 2 }),
    currency: varchar("currency", { length: 10 }).default("USD"),
    color: varchar("color", { length: 100 }),
    finish: varchar("finish", { length: 100 }),
    weight: decimal("weight", { precision: 10, scale: 4 }),
    weightUnit: varchar("weight_unit", { length: 10 }),
    categoryPath: varchar("category_path", { length: 500 }),
    imageUrls: jsonb("image_urls"),
    customAttributes: jsonb("custom_attributes"),
    fitmentData: jsonb("fitment_data"),
    agentReadinessScore: integer("agent_readiness_score"),
    normalizationStatus: varchar("normalization_status", { length: 20 }).default("pending"),
    normalizedAt: timestamp("normalized_at"),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (t) => [
    index("idx_normalized_products_merchant").on(t.merchantId),
    index("idx_normalized_products_sku").on(t.merchantId, t.sku),
  ],
);

export type RawProduct = typeof rawProductsTable.$inferSelect;
export type NormalizedProduct = typeof normalizedProductsTable.$inferSelect;
