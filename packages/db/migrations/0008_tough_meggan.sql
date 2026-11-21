CREATE TABLE `doc_commit_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`project_id` text NOT NULL,
	`commit_sha` text NOT NULL,
	`committed_at` integer NOT NULL,
	`author` text NOT NULL,
	`title` text NOT NULL,
	`summary_md` text NOT NULL,
	`detail_md` text DEFAULT '' NOT NULL,
	`files_json` text DEFAULT '[]' NOT NULL,
	`modules_json` text DEFAULT '[]' NOT NULL,
	`token_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_doc_commit_entries_project_sha` ON `doc_commit_entries` (`project_id`,`commit_sha`);--> statement-breakpoint
CREATE INDEX `idx_doc_commit_entries_project_time` ON `doc_commit_entries` (`project_id`,"committed_at" desc);--> statement-breakpoint
CREATE TABLE `doc_modules` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`project_id` text NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`path_patterns_json` text DEFAULT '[]' NOT NULL,
	`owner` text DEFAULT '' NOT NULL,
	`depends_on_json` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_doc_modules_project_key` ON `doc_modules` (`project_id`,`key`);--> statement-breakpoint
CREATE INDEX `idx_doc_modules_project` ON `doc_modules` (`project_id`);--> statement-breakpoint
CREATE TABLE `doc_rollups` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`project_id` text NOT NULL,
	`doc_module_id` text,
	`tier` text NOT NULL,
	`period_start` integer NOT NULL,
	`period_end` integer NOT NULL,
	`commit_count` integer NOT NULL,
	`content_md` text NOT NULL,
	`source_sha_range` text NOT NULL,
	`source_entry_ids_json` text DEFAULT '[]' NOT NULL,
	`token_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`doc_module_id`) REFERENCES `doc_modules`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_doc_rollups_project_tier` ON `doc_rollups` (`project_id`,`tier`,`period_end`);--> statement-breakpoint
CREATE TABLE `doc_sync_state` (
	`project_id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`last_processed_sha` text,
	`last_doc_commit_sha` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `doc_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`project_id` text NOT NULL,
	`doc_module_id` text NOT NULL,
	`commit_sha` text NOT NULL,
	`content_md` text NOT NULL,
	`content_hash` text NOT NULL,
	`summary` text,
	`source_refs_json` text DEFAULT '[]' NOT NULL,
	`generated` integer DEFAULT true NOT NULL,
	`human_edited` integer DEFAULT false NOT NULL,
	`model` text,
	`prompt_version` text,
	`token_count` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`doc_module_id`) REFERENCES `doc_modules`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_doc_versions_module_created` ON `doc_versions` (`doc_module_id`,"created_at" desc);--> statement-breakpoint
CREATE INDEX `idx_doc_versions_project` ON `doc_versions` (`project_id`);--> statement-breakpoint
CREATE TABLE `project_members` (
	`project_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`project_id`, `user_id`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_project_members_user` ON `project_members` (`user_id`);--> statement-breakpoint
CREATE TABLE `trigger_configs` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`action` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`cron` text,
	`branch` text,
	`environment_id` text,
	`selection_json` text DEFAULT '{}' NOT NULL,
	`token_hash` text,
	`last_fired_at` integer,
	`next_run_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_trigger_configs_project` ON `trigger_configs` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_trigger_configs_due` ON `trigger_configs` (`enabled`,`next_run_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_trigger_configs_token` ON `trigger_configs` (`token_hash`);--> statement-breakpoint
ALTER TABLE `projects` ADD `access_mode` text DEFAULT 'tenant' NOT NULL;--> statement-breakpoint
ALTER TABLE `repair_attempts` ADD `review_status` text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE `repair_attempts` ADD `feature_path` text;--> statement-breakpoint
ALTER TABLE `repair_attempts` ADD `verified_at` integer;--> statement-breakpoint
CREATE VIRTUAL TABLE `doc_modules_fts` USING fts5(doc_module_id UNINDEXED, project_id UNINDEXED, key, name, description, content);
