CREATE TABLE `feature_files` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`project_id` text NOT NULL,
	`repo` text DEFAULT 'suite' NOT NULL,
	`path` text NOT NULL,
	`blob_sha` text,
	`module_key` text,
	`tags_json` text DEFAULT '[]' NOT NULL,
	`scenario_count` integer DEFAULT 0 NOT NULL,
	`parse_status` text DEFAULT 'parsed' NOT NULL,
	`parse_error` text,
	`indexed_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_feature_files_path` ON `feature_files` (`project_id`,`repo`,`path`);--> statement-breakpoint
CREATE INDEX `idx_feature_files_project` ON `feature_files` (`project_id`);--> statement-breakpoint
CREATE TABLE `generation_files` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`generation_id` text NOT NULL,
	`path` text NOT NULL,
	`action` text DEFAULT 'create' NOT NULL,
	`content` text NOT NULL,
	`content_hash` text NOT NULL,
	`scenario_count` integer DEFAULT 0 NOT NULL,
	`validation_status` text DEFAULT 'pending' NOT NULL,
	`validation_errors_json` text DEFAULT '[]' NOT NULL,
	`committed_sha` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`generation_id`) REFERENCES `generations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_generation_files_path` ON `generation_files` (`generation_id`,`path`);--> statement-breakpoint
CREATE INDEX `idx_generation_files_generation` ON `generation_files` (`generation_id`);--> statement-breakpoint
CREATE TABLE `generations` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`project_id` text NOT NULL,
	`base_sha` text,
	`head_sha` text NOT NULL,
	`branch` text,
	`mode` text DEFAULT 'range' NOT NULL,
	`trigger` text DEFAULT 'manual' NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`approval_status` text DEFAULT 'pending' NOT NULL,
	`feature_points_json` text DEFAULT '[]' NOT NULL,
	`stats_json` text DEFAULT '{}' NOT NULL,
	`model` text,
	`prompt_version` text,
	`workflow_thread_id` text,
	`idempotency_key` text NOT NULL,
	`error_json` text,
	`created_by_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_generations_idempotency` ON `generations` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_generations_project_created` ON `generations` (`project_id`,"created_at" desc);--> statement-breakpoint
CREATE INDEX `idx_generations_tenant` ON `generations` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `test_cases` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`project_id` text NOT NULL,
	`feature_file_id` text NOT NULL,
	`case_key` text NOT NULL,
	`name` text NOT NULL,
	`line` integer DEFAULT 1 NOT NULL,
	`tags_json` text DEFAULT '[]' NOT NULL,
	`content_hash` text NOT NULL,
	`fingerprint` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`indexed_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`feature_file_id`) REFERENCES `feature_files`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_test_cases_file_case` ON `test_cases` (`feature_file_id`,`case_key`);--> statement-breakpoint
CREATE INDEX `idx_test_cases_project` ON `test_cases` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_test_cases_status` ON `test_cases` (`project_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_test_cases_fingerprint` ON `test_cases` (`fingerprint`);--> statement-breakpoint
CREATE VIRTUAL TABLE `test_cases_fts` USING fts5(
	`case_id` UNINDEXED,
	`project_id` UNINDEXED,
	`module_key`,
	`name`,
	`steps`,
	`tags`,
	tokenize = 'unicode61'
);
