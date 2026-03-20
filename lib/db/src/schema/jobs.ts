import { pgTable, uuid, varchar, integer, jsonb, timestamp } from "drizzle-orm/pg-core";
import { merchantsTable } from "./merchants";

export const syncJobsTable = pgTable("sync_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  merchantId: uuid("merchant_id").references(() => merchantsTable.id, { onDelete: "cascade" }),
  jobType: varchar("job_type", { length: 50 }).notNull(),
  status: varchar("status", { length: 20 }).default("queued"),
  totalRecords: integer("total_records").default(0),
  processedRecords: integer("processed_records").default(0),
  errorCount: integer("error_count").default(0),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  durationSeconds: integer("duration_seconds"),
  errorLog: jsonb("error_log"),
  config: jsonb("config"),
  createdAt: timestamp("created_at").defaultNow(),
});

export type SyncJob = typeof syncJobsTable.$inferSelect;
