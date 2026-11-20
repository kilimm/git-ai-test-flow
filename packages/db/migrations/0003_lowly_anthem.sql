CREATE TABLE `credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`username` text,
	`secret_ciphertext` blob NOT NULL,
	`secret_iv` blob NOT NULL,
	`secret_auth_tag` blob NOT NULL,
	`key_version` integer NOT NULL,
	`expires_at` integer,
	`created_by_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_credentials_tenant_name` ON `credentials` (`tenant_id`,`name`);--> statement-breakpoint
CREATE INDEX `idx_credentials_tenant` ON `credentials` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `environments` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`api_base_url` text NOT NULL,
	`web_base_url` text,
	`healthcheck_url` text,
	`healthcheck_expected_status` integer DEFAULT 200 NOT NULL,
	`healthcheck_timeout_ms` integer DEFAULT 5000 NOT NULL,
	`version_source` text DEFAULT 'manual' NOT NULL,
	`version_endpoint` text,
	`version_json_path` text,
	`version_header` text,
	`deployed_sha` text,
	`strict_version_match` integer DEFAULT false NOT NULL,
	`test_account_credential_id` text,
	`reset_endpoint` text,
	`setup_script` text,
	`teardown_script` text,
	`env_vars_json` text DEFAULT '{}' NOT NULL,
	`db_type` text,
	`db_host` text,
	`db_port` integer,
	`db_name` text,
	`db_schema` text,
	`db_user` text,
	`db_credential_id` text,
	`db_ssl` integer DEFAULT false NOT NULL,
	`db_is_test` integer DEFAULT true NOT NULL,
	`db_write_mode` text DEFAULT 'readonly' NOT NULL,
	`browser_json` text DEFAULT '{}' NOT NULL,
	`case_timeout_ms` integer DEFAULT 60000 NOT NULL,
	`api_concurrency` integer DEFAULT 4 NOT NULL,
	`ui_concurrency` integer DEFAULT 1 NOT NULL,
	`health_status` text DEFAULT 'unknown' NOT NULL,
	`health_checked_at` integer,
	`health_message` text,
	`is_default` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`test_account_credential_id`) REFERENCES `credentials`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`db_credential_id`) REFERENCES `credentials`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_environments_project_name` ON `environments` (`project_id`,`name`);--> statement-breakpoint
CREATE INDEX `idx_environments_project` ON `environments` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_environments_db_credential` ON `environments` (`db_credential_id`);--> statement-breakpoint
CREATE INDEX `idx_environments_test_account` ON `environments` (`test_account_credential_id`);--> statement-breakpoint
CREATE TABLE `llm_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`purpose` text NOT NULL,
	`provider` text NOT NULL,
	`base_url` text NOT NULL,
	`model` text NOT NULL,
	`credential_id` text,
	`params_json` text DEFAULT '{}' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`health_status` text DEFAULT 'unknown' NOT NULL,
	`health_checked_at` integer,
	`health_message` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`credential_id`) REFERENCES `credentials`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_llm_profiles_project_name` ON `llm_profiles` (`project_id`,`name`);--> statement-breakpoint
CREATE INDEX `idx_llm_profiles_project` ON `llm_profiles` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_llm_profiles_credential` ON `llm_profiles` (`credential_id`);--> statement-breakpoint
CREATE TABLE `notification_channels` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`webhook_ciphertext` blob NOT NULL,
	`webhook_iv` blob NOT NULL,
	`webhook_auth_tag` blob NOT NULL,
	`webhook_key_version` integer NOT NULL,
	`secret_ciphertext` blob NOT NULL,
	`secret_iv` blob NOT NULL,
	`secret_auth_tag` blob NOT NULL,
	`secret_key_version` integer NOT NULL,
	`events_json` text DEFAULT '[]' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_tested_at` integer,
	`last_test_status` text DEFAULT 'unknown' NOT NULL,
	`last_test_message` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_notification_channels_project_name` ON `notification_channels` (`project_id`,`name`);--> statement-breakpoint
CREATE INDEX `idx_notification_channels_project` ON `notification_channels` (`project_id`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`product_repo_url` text NOT NULL,
	`default_branch` text NOT NULL,
	`git_credential_id` text,
	`suite_mode` text DEFAULT 'managed' NOT NULL,
	`suite_repo_url` text,
	`suite_path` text,
	`feature_root` text DEFAULT 'features/' NOT NULL,
	`docs_root` text DEFAULT 'docs/ai/' NOT NULL,
	`settings_json` text DEFAULT '{}' NOT NULL,
	`created_by_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`git_credential_id`) REFERENCES `credentials`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_projects_tenant_slug` ON `projects` (`tenant_id`,`slug`);--> statement-breakpoint
CREATE INDEX `idx_projects_tenant` ON `projects` (`tenant_id`);