CREATE TABLE `ci_integrations` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`provider` text NOT NULL,
	`repository` text NOT NULL,
	`api_base_url` text,
	`token_credential_id` text,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`token_credential_id`) REFERENCES `credentials`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_ci_integrations_project_name` ON `ci_integrations` (`project_id`,`name`);--> statement-breakpoint
CREATE INDEX `idx_ci_integrations_project` ON `ci_integrations` (`project_id`);--> statement-breakpoint
CREATE TABLE `environment_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_environment_groups_project_name` ON `environment_groups` (`project_id`,`name`);--> statement-breakpoint
CREATE INDEX `idx_environment_groups_project` ON `environment_groups` (`project_id`);--> statement-breakpoint
CREATE TABLE `runner_nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`capacity` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'offline' NOT NULL,
	`version` text,
	`last_heartbeat_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runner_nodes_name_unique` ON `runner_nodes` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `runner_nodes_token_hash_unique` ON `runner_nodes` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_runner_nodes_heartbeat` ON `runner_nodes` (`last_heartbeat_at`);--> statement-breakpoint
CREATE TABLE `sso_providers` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`issuer` text NOT NULL,
	`client_id` text NOT NULL,
	`client_secret_ciphertext` blob NOT NULL,
	`client_secret_iv` blob NOT NULL,
	`client_secret_auth_tag` blob NOT NULL,
	`client_secret_key_version` integer NOT NULL,
	`authorization_endpoint` text NOT NULL,
	`token_endpoint` text NOT NULL,
	`userinfo_endpoint` text NOT NULL,
	`scopes_json` text DEFAULT '["openid","email","profile"]' NOT NULL,
	`allowed_email_domains_json` text DEFAULT '[]' NOT NULL,
	`default_role` text DEFAULT 'viewer' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_sso_providers_tenant_name` ON `sso_providers` (`tenant_id`,`name`);--> statement-breakpoint
CREATE INDEX `idx_sso_providers_tenant` ON `sso_providers` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `tenant_quotas` (
	`tenant_id` text PRIMARY KEY NOT NULL,
	`max_runs_per_day` integer DEFAULT 200 NOT NULL,
	`max_concurrent_runs` integer DEFAULT 5 NOT NULL,
	`max_llm_tokens_per_month` integer DEFAULT 2000000 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `environments` ADD `group_id` text REFERENCES environment_groups(id);