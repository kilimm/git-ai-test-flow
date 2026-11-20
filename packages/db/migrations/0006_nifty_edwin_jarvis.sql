CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`project_id` text NOT NULL,
	`run_id` text NOT NULL,
	`channel_id` text,
	`event_type` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`response_status` integer,
	`response_body` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`dedupe_key` text NOT NULL,
	`sent_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `notification_channels`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_notifications_dedupe` ON `notifications` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `idx_notifications_run` ON `notifications` (`run_id`);--> statement-breakpoint
CREATE INDEX `idx_notifications_project_created` ON `notifications` (`project_id`,"created_at" desc);--> statement-breakpoint
CREATE TABLE `repair_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`run_case_id` text NOT NULL,
	`attempt_no` integer NOT NULL,
	`original_content` text NOT NULL,
	`patched_content` text,
	`patch_diff` text,
	`repair_class` text NOT NULL,
	`rationale` text NOT NULL,
	`evidence_json` text DEFAULT '{}' NOT NULL,
	`model` text,
	`guard_status` text DEFAULT 'blocked' NOT NULL,
	`guard_findings_json` text DEFAULT '[]' NOT NULL,
	`applied_commit` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_case_id`) REFERENCES `run_cases`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_repair_attempts_case_no` ON `repair_attempts` (`run_case_id`,`attempt_no`);--> statement-breakpoint
CREATE INDEX `idx_repair_attempts_case` ON `repair_attempts` (`run_case_id`);