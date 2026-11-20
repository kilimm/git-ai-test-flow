CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`run_id` text NOT NULL,
	`run_case_id` text,
	`step_result_id` text,
	`type` text NOT NULL,
	`storage` text DEFAULT 'local' NOT NULL,
	`path` text NOT NULL,
	`mime` text NOT NULL,
	`size` integer NOT NULL,
	`sha256` text NOT NULL,
	`redacted` integer DEFAULT false NOT NULL,
	`expires_at` integer,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_case_id`) REFERENCES `run_cases`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`step_result_id`) REFERENCES `step_results`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_artifacts_run` ON `artifacts` (`run_id`);--> statement-breakpoint
CREATE INDEX `idx_artifacts_run_case` ON `artifacts` (`run_case_id`);--> statement-breakpoint
CREATE INDEX `idx_artifacts_expires` ON `artifacts` (`expires_at`);--> statement-breakpoint
CREATE TABLE `run_cases` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`run_id` text NOT NULL,
	`case_id` text,
	`source` text DEFAULT 'suite' NOT NULL,
	`feature_path` text NOT NULL,
	`scenario_name` text NOT NULL,
	`line` integer DEFAULT 1 NOT NULL,
	`case_key` text,
	`tags_json` text DEFAULT '[]' NOT NULL,
	`layer` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempt` integer DEFAULT 1 NOT NULL,
	`classification` text,
	`confidence` integer,
	`duration_ms` integer,
	`error_message` text,
	`evidence_json` text DEFAULT '{}' NOT NULL,
	`repair_status` text,
	`started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`case_id`) REFERENCES `test_cases`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_run_cases_run_status` ON `run_cases` (`run_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_run_cases_run_case_key` ON `run_cases` (`run_id`,`case_key`);--> statement-breakpoint
CREATE TABLE `run_events` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`run_id` text NOT NULL,
	`seq` integer NOT NULL,
	`type` text NOT NULL,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_run_events_seq` ON `run_events` (`run_id`,`seq`);--> statement-breakpoint
CREATE INDEX `idx_run_events_run` ON `run_events` (`run_id`,`seq`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`project_id` text NOT NULL,
	`environment_id` text,
	`baseline_environment_id` text,
	`generation_id` text,
	`trigger` text DEFAULT 'manual' NOT NULL,
	`base_sha` text,
	`head_sha` text NOT NULL,
	`deployed_sha` text,
	`version_match` integer,
	`branch` text,
	`suites_json` text DEFAULT '[]' NOT NULL,
	`selection_json` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`stats_json` text DEFAULT '{}' NOT NULL,
	`workflow_thread_id` text,
	`idempotency_key` text NOT NULL,
	`error_json` text,
	`created_by_user_id` text,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`baseline_environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`generation_id`) REFERENCES `generations`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_runs_idempotency` ON `runs` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_runs_project_head` ON `runs` (`project_id`,`head_sha`);--> statement-breakpoint
CREATE INDEX `idx_runs_tenant_created` ON `runs` (`tenant_id`,"created_at" desc);--> statement-breakpoint
CREATE INDEX `idx_runs_project_created` ON `runs` (`project_id`,"created_at" desc);--> statement-breakpoint
CREATE INDEX `idx_runs_status` ON `runs` (`status`);--> statement-breakpoint
CREATE TABLE `step_results` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`run_case_id` text NOT NULL,
	`step_index` integer NOT NULL,
	`keyword` text NOT NULL,
	`text` text NOT NULL,
	`type` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`duration_ms` integer,
	`input_json` text DEFAULT '{}' NOT NULL,
	`output_json` text DEFAULT '{}' NOT NULL,
	`error_json` text,
	`artifacts_json` text DEFAULT '[]' NOT NULL,
	`agent_meta_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_case_id`) REFERENCES `run_cases`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_step_results_case` ON `step_results` (`run_case_id`);