CREATE INDEX `idx_simulations_user_created` ON `simulations` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_simulations_active_status` ON `simulations` (`status`);