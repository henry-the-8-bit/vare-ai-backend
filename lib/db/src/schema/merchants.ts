import { pgTable, uuid, varchar, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const merchantsTable = pgTable("merchants", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyName: varchar("company_name", { length: 200 }).notNull(),
  contactFirstName: varchar("contact_first_name", { length: 100 }),
  contactLastName: varchar("contact_last_name", { length: 100 }),
  contactEmail: varchar("contact_email", { length: 255 }).notNull(),
  contactPhone: varchar("contact_phone", { length: 50 }),
  estimatedSkuCount: varchar("estimated_sku_count", { length: 50 }),
  primaryVertical: varchar("primary_vertical", { length: 100 }),
  magentoVersion: varchar("magento_version", { length: 50 }),
  hostingEnvironment: varchar("hosting_environment", { length: 100 }),
  erpSystem: varchar("erp_system", { length: 100 }),
  pimSystem: varchar("pim_system", { length: 100 }),
  complexityScore: integer("complexity_score").default(0),
  onboardingPhase: integer("onboarding_phase").default(1),
  onboardingStatus: varchar("onboarding_status", { length: 20 }).default("in_progress"),
  apiKey: varchar("api_key", { length: 255 }),
  sandboxMode: boolean("sandbox_mode").default(true),
  isLive: boolean("is_live").default(false),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertMerchantSchema = createInsertSchema(merchantsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const updateMerchantSchema = insertMerchantSchema.partial();

export type Merchant = typeof merchantsTable.$inferSelect;
export type InsertMerchant = z.infer<typeof insertMerchantSchema>;
export type UpdateMerchant = z.infer<typeof updateMerchantSchema>;
