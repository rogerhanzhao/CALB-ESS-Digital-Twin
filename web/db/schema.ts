import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const simulations = sqliteTable("simulations", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  chemistry: text("chemistry").notNull().default("LFP"),
  horizonYears: integer("horizon_years").notNull(),
  cyclesPerDay: real("cycles_per_day").notNull(),
  status: text("status").notNull().default("queued"),
  progress: integer("progress").notNull().default(0),
  endSoh: real("end_soh"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  index("idx_simulations_user_created").on(table.userId, table.createdAt),
  index("idx_simulations_active_status").on(table.status),
]);
