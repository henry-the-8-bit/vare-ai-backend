import { pgTable, uuid, varchar, integer, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { merchantsTable } from "./merchants";

export const csvUploadsTable = pgTable(
  "csv_uploads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .references(() => merchantsTable.id, { onDelete: "cascade" })
      .notNull(),
    filename: varchar("filename", { length: 255 }).notNull(),
    originalHeaders: jsonb("original_headers").notNull().$type<string[]>(),
    rowCount: integer("row_count"),
    rawRows: jsonb("raw_rows").$type<Record<string, string>[]>(),
    status: varchar("status", { length: 30 }).default("pending_mapping").notNull(),
    importedCount: integer("imported_count").default(0),
    errorCount: integer("error_count").default(0),
    errors: jsonb("errors").$type<{ row: number; error: string }[]>(),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (t) => [index("idx_csv_uploads_merchant").on(t.merchantId)],
);

export const csvColumnMappingsTable = pgTable(
  "csv_column_mappings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .references(() => merchantsTable.id, { onDelete: "cascade" })
      .notNull(),
    csvUploadId: uuid("csv_upload_id")
      .references(() => csvUploadsTable.id, { onDelete: "cascade" })
      .notNull(),
    csvHeader: varchar("csv_header", { length: 255 }).notNull(),
    vareField: varchar("vare_field", { length: 100 }),
    transformId: varchar("transform_id", { length: 50 }),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (t) => [index("idx_csv_column_mappings_upload").on(t.csvUploadId)],
);

export const csvFieldOverridesTable = pgTable(
  "csv_field_overrides",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .references(() => merchantsTable.id, { onDelete: "cascade" })
      .notNull(),
    csvUploadId: uuid("csv_upload_id")
      .references(() => csvUploadsTable.id, { onDelete: "cascade" })
      .notNull(),
    vareField: varchar("vare_field", { length: 100 }).notNull(),
    strategy: varchar("strategy", { length: 20 }).notNull(), // "default_value" | "ai_fill"
    defaultValue: varchar("default_value", { length: 500 }),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (t) => [index("idx_csv_field_overrides_upload").on(t.csvUploadId)],
);

export type CsvUpload = typeof csvUploadsTable.$inferSelect;
export type CsvColumnMapping = typeof csvColumnMappingsTable.$inferSelect;
export type CsvFieldOverride = typeof csvFieldOverridesTable.$inferSelect;
