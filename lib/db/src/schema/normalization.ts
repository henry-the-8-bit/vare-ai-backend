import { pgTable, uuid, varchar, real, integer, timestamp } from "drizzle-orm/pg-core";
import { merchantsTable } from "./merchants";

export const attributeMappingsTable = pgTable("attribute_mappings", {
  id: uuid("id").primaryKey().defaultRandom(),
  merchantId: uuid("merchant_id").references(() => merchantsTable.id, { onDelete: "cascade" }),
  sourceAttribute: varchar("source_attribute", { length: 255 }).notNull(),
  targetAttribute: varchar("target_attribute", { length: 255 }),
  mappingStatus: varchar("mapping_status", { length: 20 }).default("auto"),
  confidence: real("confidence"),
  dataType: varchar("data_type", { length: 50 }),
  normalizationUnit: varchar("normalization_unit", { length: 50 }),
  createdAt: timestamp("created_at").defaultNow(),
});

export const valueNormalizationsTable = pgTable("value_normalizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  merchantId: uuid("merchant_id").references(() => merchantsTable.id, { onDelete: "cascade" }),
  attributeMappingId: uuid("attribute_mapping_id").references(() => attributeMappingsTable.id),
  sourceValue: varchar("source_value", { length: 500 }).notNull(),
  normalizedValue: varchar("normalized_value", { length: 500 }).notNull(),
  clusterName: varchar("cluster_name", { length: 255 }),
  status: varchar("status", { length: 20 }).default("suggested"),
  productCount: integer("product_count").default(0),
  createdAt: timestamp("created_at").defaultNow(),
});

export type AttributeMapping = typeof attributeMappingsTable.$inferSelect;
export type ValueNormalization = typeof valueNormalizationsTable.$inferSelect;
