import {
  pgTable,
  uuid,
  varchar,
  integer,
  text,
  boolean,
  jsonb,
  timestamp,
  decimal,
  index,
} from "drizzle-orm/pg-core";
import { merchantsTable } from "./merchants";

export const agentOrdersTable = pgTable("agent_orders", {
  id: uuid("id").primaryKey().defaultRandom(),
  merchantId: uuid("merchant_id").references(() => merchantsTable.id, { onDelete: "cascade" }),
  magentoOrderId: varchar("magento_order_id", { length: 100 }),
  agentPlatform: varchar("agent_platform", { length: 50 }),
  agentSessionId: varchar("agent_session_id", { length: 255 }),
  sku: varchar("sku", { length: 255 }),
  productTitle: varchar("product_title", { length: 500 }),
  quantity: integer("quantity"),
  unitPrice: decimal("unit_price", { precision: 10, scale: 2 }),
  totalPrice: decimal("total_price", { precision: 10, scale: 2 }),
  orderStatus: varchar("order_status", { length: 50 }),
  paymentMethod: varchar("payment_method", { length: 100 }),
  shippingMethod: varchar("shipping_method", { length: 100 }),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const agentQueriesTable = pgTable(
  "agent_queries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id").references(() => merchantsTable.id, { onDelete: "cascade" }),
    agentPlatform: varchar("agent_platform", { length: 50 }),
    queryText: text("query_text"),
    matchedSkus: jsonb("matched_skus"),
    resultCount: integer("result_count").default(0),
    wasMatched: boolean("was_matched").default(false),
    intentCluster: varchar("intent_cluster", { length: 255 }),
    sessionId: varchar("session_id", { length: 255 }),
    responseTimeMs: integer("response_time_ms"),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (t) => [index("idx_agent_queries_merchant_date").on(t.merchantId, t.createdAt)],
);

export const transactionEventsTable = pgTable(
  "transaction_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id").references(() => merchantsTable.id, { onDelete: "cascade" }),
    sessionId: varchar("session_id", { length: 255 }),
    agentPlatform: varchar("agent_platform", { length: 50 }),
    sku: varchar("sku", { length: 255 }),
    eventType: varchar("event_type", { length: 50 }),
    status: varchar("status", { length: 20 }).default("success"),
    durationMs: integer("duration_ms"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (t) => [index("idx_transaction_events_merchant_date").on(t.merchantId, t.createdAt)],
);

export type AgentOrder = typeof agentOrdersTable.$inferSelect;
export type AgentQuery = typeof agentQueriesTable.$inferSelect;
export type TransactionEvent = typeof transactionEventsTable.$inferSelect;
