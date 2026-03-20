import {
  pgTable,
  uuid,
  varchar,
  boolean,
  integer,
  timestamp,
  real,
  jsonb,
} from "drizzle-orm/pg-core";
import { merchantsTable } from "./merchants";

export const magentoConnectionsTable = pgTable("magento_connections", {
  id: uuid("id").primaryKey().defaultRandom(),
  merchantId: uuid("merchant_id").references(() => merchantsTable.id, { onDelete: "cascade" }),
  storeUrl: varchar("store_url", { length: 500 }).notNull(),
  consumerKey: varchar("consumer_key", { length: 500 }),
  consumerSecret: varchar("consumer_secret", { length: 500 }),
  accessToken: varchar("access_token", { length: 500 }),
  accessTokenSecret: varchar("access_token_secret", { length: 500 }),
  apiUser: varchar("api_user", { length: 255 }),
  apiKeyM1: varchar("api_key_m1", { length: 500 }),
  storeName: varchar("store_name", { length: 255 }),
  detectedVersion: varchar("detected_version", { length: 100 }),
  baseCurrency: varchar("base_currency", { length: 10 }),
  locale: varchar("locale", { length: 20 }),
  connectionStatus: varchar("connection_status", { length: 20 }).default("pending"),
  lastHealthCheck: timestamp("last_health_check"),
  apiHealthPct: real("api_health_pct").default(100.0),
  syncConfig: jsonb("sync_config"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const storeViewsTable = pgTable("store_views", {
  id: uuid("id").primaryKey().defaultRandom(),
  merchantId: uuid("merchant_id").references(() => merchantsTable.id, { onDelete: "cascade" }),
  magentoStoreViewId: integer("magento_store_view_id"),
  code: varchar("code", { length: 100 }),
  name: varchar("name", { length: 255 }),
  isSelected: boolean("is_selected").default(true),
  isDefault: boolean("is_default").default(false),
});

export type MagentoConnection = typeof magentoConnectionsTable.$inferSelect;
export type StoreView = typeof storeViewsTable.$inferSelect;
