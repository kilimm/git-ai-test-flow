CREATE TABLE "artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"run_id" text NOT NULL,
	"run_case_id" text,
	"step_result_id" text,
	"type" text NOT NULL,
	"storage" text DEFAULT 'local' NOT NULL,
	"path" text NOT NULL,
	"mime" text NOT NULL,
	"size" bigint NOT NULL,
	"sha256" text NOT NULL,
	"redacted" boolean DEFAULT false NOT NULL,
	"expires_at" bigint,
	"metadata_json" text DEFAULT '{}' NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text,
	"actor_user_id" text,
	"action" text NOT NULL,
	"resource_type" text,
	"resource_id" text,
	"ip" text,
	"user_agent" text,
	"detail_json" text DEFAULT '{}' NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ci_integrations" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"provider" text NOT NULL,
	"repository" text NOT NULL,
	"api_base_url" text,
	"token_credential_id" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"username" text,
	"secret_ciphertext" "bytea" NOT NULL,
	"secret_iv" "bytea" NOT NULL,
	"secret_auth_tag" "bytea" NOT NULL,
	"key_version" integer NOT NULL,
	"expires_at" bigint,
	"created_by_user_id" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "doc_commit_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"commit_sha" text NOT NULL,
	"committed_at" bigint NOT NULL,
	"author" text NOT NULL,
	"title" text NOT NULL,
	"summary_md" text NOT NULL,
	"detail_md" text DEFAULT '' NOT NULL,
	"files_json" text DEFAULT '[]' NOT NULL,
	"modules_json" text DEFAULT '[]' NOT NULL,
	"token_count" integer DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "doc_modules" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"path_patterns_json" text DEFAULT '[]' NOT NULL,
	"owner" text DEFAULT '' NOT NULL,
	"depends_on_json" text DEFAULT '[]' NOT NULL,
	"search_text" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "doc_rollups" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"doc_module_id" text,
	"tier" text NOT NULL,
	"period_start" bigint NOT NULL,
	"period_end" bigint NOT NULL,
	"commit_count" integer NOT NULL,
	"content_md" text NOT NULL,
	"source_sha_range" text NOT NULL,
	"source_entry_ids_json" text DEFAULT '[]' NOT NULL,
	"token_count" integer DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "doc_sync_state" (
	"project_id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"last_processed_sha" text,
	"last_doc_commit_sha" text,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "doc_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"doc_module_id" text NOT NULL,
	"commit_sha" text NOT NULL,
	"content_md" text NOT NULL,
	"content_hash" text NOT NULL,
	"summary" text,
	"source_refs_json" text DEFAULT '[]' NOT NULL,
	"generated" boolean DEFAULT true NOT NULL,
	"human_edited" boolean DEFAULT false NOT NULL,
	"model" text,
	"prompt_version" text,
	"token_count" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "environment_groups" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "environments" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"group_id" text,
	"name" text NOT NULL,
	"api_base_url" text NOT NULL,
	"web_base_url" text,
	"healthcheck_url" text,
	"healthcheck_expected_status" integer DEFAULT 200 NOT NULL,
	"healthcheck_timeout_ms" integer DEFAULT 5000 NOT NULL,
	"version_source" text DEFAULT 'manual' NOT NULL,
	"version_endpoint" text,
	"version_json_path" text,
	"version_header" text,
	"deployed_sha" text,
	"strict_version_match" boolean DEFAULT false NOT NULL,
	"test_account_credential_id" text,
	"reset_endpoint" text,
	"setup_script" text,
	"teardown_script" text,
	"env_vars_json" text DEFAULT '{}' NOT NULL,
	"db_type" text,
	"db_host" text,
	"db_port" integer,
	"db_name" text,
	"db_schema" text,
	"db_user" text,
	"db_credential_id" text,
	"db_ssl" boolean DEFAULT false NOT NULL,
	"db_is_test" boolean DEFAULT true NOT NULL,
	"db_write_mode" text DEFAULT 'readonly' NOT NULL,
	"browser_json" text DEFAULT '{}' NOT NULL,
	"case_timeout_ms" integer DEFAULT 60000 NOT NULL,
	"api_concurrency" integer DEFAULT 4 NOT NULL,
	"ui_concurrency" integer DEFAULT 1 NOT NULL,
	"health_status" text DEFAULT 'unknown' NOT NULL,
	"health_checked_at" bigint,
	"health_message" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feature_files" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"repo" text DEFAULT 'suite' NOT NULL,
	"path" text NOT NULL,
	"blob_sha" text,
	"module_key" text,
	"tags_json" text DEFAULT '[]' NOT NULL,
	"scenario_count" integer DEFAULT 0 NOT NULL,
	"parse_status" text DEFAULT 'parsed' NOT NULL,
	"parse_error" text,
	"indexed_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "generation_files" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"generation_id" text NOT NULL,
	"path" text NOT NULL,
	"action" text DEFAULT 'create' NOT NULL,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"scenario_count" integer DEFAULT 0 NOT NULL,
	"validation_status" text DEFAULT 'pending' NOT NULL,
	"validation_errors_json" text DEFAULT '[]' NOT NULL,
	"committed_sha" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "generations" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"base_sha" text,
	"head_sha" text NOT NULL,
	"branch" text,
	"mode" text DEFAULT 'range' NOT NULL,
	"trigger" text DEFAULT 'manual' NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"approval_status" text DEFAULT 'pending' NOT NULL,
	"feature_points_json" text DEFAULT '[]' NOT NULL,
	"stats_json" text DEFAULT '{}' NOT NULL,
	"model" text,
	"prompt_version" text,
	"workflow_thread_id" text,
	"idempotency_key" text NOT NULL,
	"error_json" text,
	"created_by_user_id" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"finished_at" bigint
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text,
	"type" text NOT NULL,
	"payload_json" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"run_after" bigint NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"locked_by" text,
	"lease_expires_at" bigint,
	"dedupe_key" text,
	"last_error" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "jobs_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "llm_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"purpose" text NOT NULL,
	"provider" text NOT NULL,
	"base_url" text NOT NULL,
	"model" text NOT NULL,
	"credential_id" text,
	"params_json" text DEFAULT '{}' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"health_status" text DEFAULT 'unknown' NOT NULL,
	"health_checked_at" bigint,
	"health_message" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_channels" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"webhook_ciphertext" "bytea" NOT NULL,
	"webhook_iv" "bytea" NOT NULL,
	"webhook_auth_tag" "bytea" NOT NULL,
	"webhook_key_version" integer NOT NULL,
	"secret_ciphertext" "bytea" NOT NULL,
	"secret_iv" "bytea" NOT NULL,
	"secret_auth_tag" "bytea" NOT NULL,
	"secret_key_version" integer NOT NULL,
	"events_json" text DEFAULT '[]' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_tested_at" bigint,
	"last_test_status" text DEFAULT 'unknown' NOT NULL,
	"last_test_message" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"run_id" text NOT NULL,
	"channel_id" text,
	"event_type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"payload_json" text DEFAULT '{}' NOT NULL,
	"response_status" integer,
	"response_body" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"dedupe_key" text NOT NULL,
	"sent_at" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_members" (
	"project_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "project_members_project_id_user_id_pk" PRIMARY KEY("project_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"product_repo_url" text NOT NULL,
	"default_branch" text NOT NULL,
	"git_credential_id" text,
	"suite_mode" text DEFAULT 'managed' NOT NULL,
	"suite_repo_url" text,
	"suite_path" text,
	"feature_root" text DEFAULT 'features/' NOT NULL,
	"docs_root" text DEFAULT 'docs/ai/' NOT NULL,
	"settings_json" text DEFAULT '{}' NOT NULL,
	"access_mode" text DEFAULT 'tenant' NOT NULL,
	"created_by_user_id" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repair_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"run_case_id" text NOT NULL,
	"attempt_no" integer NOT NULL,
	"original_content" text NOT NULL,
	"patched_content" text,
	"patch_diff" text,
	"repair_class" text NOT NULL,
	"rationale" text NOT NULL,
	"evidence_json" text DEFAULT '{}' NOT NULL,
	"model" text,
	"guard_status" text DEFAULT 'blocked' NOT NULL,
	"guard_findings_json" text DEFAULT '[]' NOT NULL,
	"review_status" text DEFAULT 'pending' NOT NULL,
	"feature_path" text,
	"applied_commit" text,
	"verified_at" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_cases" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"run_id" text NOT NULL,
	"case_id" text,
	"source" text DEFAULT 'suite' NOT NULL,
	"feature_path" text NOT NULL,
	"scenario_name" text NOT NULL,
	"line" integer DEFAULT 1 NOT NULL,
	"case_key" text,
	"tags_json" text DEFAULT '[]' NOT NULL,
	"layer" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"classification" text,
	"confidence" bigint,
	"duration_ms" integer,
	"error_message" text,
	"evidence_json" text DEFAULT '{}' NOT NULL,
	"repair_status" text,
	"started_at" bigint,
	"finished_at" bigint
);
--> statement-breakpoint
CREATE TABLE "run_events" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"run_id" text NOT NULL,
	"seq" integer NOT NULL,
	"type" text NOT NULL,
	"payload_json" text DEFAULT '{}' NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runner_nodes" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"capacity" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'offline' NOT NULL,
	"version" text,
	"last_heartbeat_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "runner_nodes_name_unique" UNIQUE("name"),
	CONSTRAINT "runner_nodes_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"environment_id" text,
	"baseline_environment_id" text,
	"generation_id" text,
	"trigger" text DEFAULT 'manual' NOT NULL,
	"base_sha" text,
	"head_sha" text NOT NULL,
	"deployed_sha" text,
	"version_match" boolean,
	"branch" text,
	"suites_json" text DEFAULT '[]' NOT NULL,
	"selection_json" text DEFAULT '{}' NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"stats_json" text DEFAULT '{}' NOT NULL,
	"workflow_thread_id" text,
	"idempotency_key" text NOT NULL,
	"error_json" text,
	"created_by_user_id" text,
	"created_at" bigint NOT NULL,
	"started_at" bigint,
	"finished_at" bigint,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"tenant_id" text,
	"token_hash" text NOT NULL,
	"expires_at" bigint NOT NULL,
	"last_seen_at" bigint NOT NULL,
	"ip" text,
	"user_agent" text,
	"revoked_at" bigint,
	"created_at" bigint NOT NULL,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "sso_identities" (
	"provider_id" text NOT NULL,
	"subject" text NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" bigint NOT NULL,
	"last_login_at" bigint,
	CONSTRAINT "sso_identities_provider_id_subject_pk" PRIMARY KEY("provider_id","subject")
);
--> statement-breakpoint
CREATE TABLE "sso_providers" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"issuer" text NOT NULL,
	"client_id" text NOT NULL,
	"client_secret_ciphertext" "bytea" NOT NULL,
	"client_secret_iv" "bytea" NOT NULL,
	"client_secret_auth_tag" "bytea" NOT NULL,
	"client_secret_key_version" integer NOT NULL,
	"authorization_endpoint" text NOT NULL,
	"token_endpoint" text NOT NULL,
	"userinfo_endpoint" text NOT NULL,
	"scopes_json" text DEFAULT '["openid","email","profile"]' NOT NULL,
	"allowed_email_domains_json" text DEFAULT '[]' NOT NULL,
	"default_role" text DEFAULT 'viewer' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "step_results" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"run_case_id" text NOT NULL,
	"step_index" integer NOT NULL,
	"keyword" text NOT NULL,
	"text" text NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"duration_ms" integer,
	"input_json" text DEFAULT '{}' NOT NULL,
	"output_json" text DEFAULT '{}' NOT NULL,
	"error_json" text,
	"artifacts_json" text DEFAULT '[]' NOT NULL,
	"agent_meta_json" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_members" (
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "tenant_members_tenant_id_user_id_pk" PRIMARY KEY("tenant_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "tenant_quotas" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"max_runs_per_day" integer DEFAULT 200 NOT NULL,
	"max_concurrent_runs" integer DEFAULT 5 NOT NULL,
	"max_llm_tokens_per_month" integer DEFAULT 2000000 NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"settings_json" text DEFAULT '{}' NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "tenants_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "test_cases" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"feature_file_id" text NOT NULL,
	"case_key" text NOT NULL,
	"name" text NOT NULL,
	"line" integer DEFAULT 1 NOT NULL,
	"tags_json" text DEFAULT '[]' NOT NULL,
	"content_hash" text NOT NULL,
	"fingerprint" text NOT NULL,
	"search_text" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"indexed_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trigger_configs" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"action" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"cron" text,
	"branch" text,
	"environment_id" text,
	"selection_json" text DEFAULT '{}' NOT NULL,
	"token_hash" text,
	"last_fired_at" bigint,
	"next_run_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"email" text,
	"password_hash" text NOT NULL,
	"display_name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"is_platform_admin" boolean DEFAULT false NOT NULL,
	"last_login_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username"),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "worker_heartbeats" (
	"worker_id" text PRIMARY KEY NOT NULL,
	"last_seen_at" bigint NOT NULL,
	"status" text DEFAULT 'idle' NOT NULL,
	"details_json" text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_run_case_id_run_cases_id_fk" FOREIGN KEY ("run_case_id") REFERENCES "public"."run_cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_step_result_id_step_results_id_fk" FOREIGN KEY ("step_result_id") REFERENCES "public"."step_results"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ci_integrations" ADD CONSTRAINT "ci_integrations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ci_integrations" ADD CONSTRAINT "ci_integrations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ci_integrations" ADD CONSTRAINT "ci_integrations_token_credential_id_credentials_id_fk" FOREIGN KEY ("token_credential_id") REFERENCES "public"."credentials"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_commit_entries" ADD CONSTRAINT "doc_commit_entries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_commit_entries" ADD CONSTRAINT "doc_commit_entries_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_modules" ADD CONSTRAINT "doc_modules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_modules" ADD CONSTRAINT "doc_modules_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_rollups" ADD CONSTRAINT "doc_rollups_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_rollups" ADD CONSTRAINT "doc_rollups_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_rollups" ADD CONSTRAINT "doc_rollups_doc_module_id_doc_modules_id_fk" FOREIGN KEY ("doc_module_id") REFERENCES "public"."doc_modules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_sync_state" ADD CONSTRAINT "doc_sync_state_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_sync_state" ADD CONSTRAINT "doc_sync_state_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_versions" ADD CONSTRAINT "doc_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_versions" ADD CONSTRAINT "doc_versions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_versions" ADD CONSTRAINT "doc_versions_doc_module_id_doc_modules_id_fk" FOREIGN KEY ("doc_module_id") REFERENCES "public"."doc_modules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_groups" ADD CONSTRAINT "environment_groups_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_groups" ADD CONSTRAINT "environment_groups_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_group_id_environment_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."environment_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_test_account_credential_id_credentials_id_fk" FOREIGN KEY ("test_account_credential_id") REFERENCES "public"."credentials"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_db_credential_id_credentials_id_fk" FOREIGN KEY ("db_credential_id") REFERENCES "public"."credentials"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_files" ADD CONSTRAINT "feature_files_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_files" ADD CONSTRAINT "feature_files_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_files" ADD CONSTRAINT "generation_files_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_files" ADD CONSTRAINT "generation_files_generation_id_generations_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."generations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generations" ADD CONSTRAINT "generations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generations" ADD CONSTRAINT "generations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generations" ADD CONSTRAINT "generations_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_profiles" ADD CONSTRAINT "llm_profiles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_profiles" ADD CONSTRAINT "llm_profiles_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_profiles" ADD CONSTRAINT "llm_profiles_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_channels" ADD CONSTRAINT "notification_channels_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_channels" ADD CONSTRAINT "notification_channels_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_channel_id_notification_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."notification_channels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_git_credential_id_credentials_id_fk" FOREIGN KEY ("git_credential_id") REFERENCES "public"."credentials"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repair_attempts" ADD CONSTRAINT "repair_attempts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repair_attempts" ADD CONSTRAINT "repair_attempts_run_case_id_run_cases_id_fk" FOREIGN KEY ("run_case_id") REFERENCES "public"."run_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_cases" ADD CONSTRAINT "run_cases_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_cases" ADD CONSTRAINT "run_cases_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_cases" ADD CONSTRAINT "run_cases_case_id_test_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."test_cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_baseline_environment_id_environments_id_fk" FOREIGN KEY ("baseline_environment_id") REFERENCES "public"."environments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_generation_id_generations_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."generations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_identities" ADD CONSTRAINT "sso_identities_provider_id_sso_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."sso_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_identities" ADD CONSTRAINT "sso_identities_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_identities" ADD CONSTRAINT "sso_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_providers" ADD CONSTRAINT "sso_providers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "step_results" ADD CONSTRAINT "step_results_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "step_results" ADD CONSTRAINT "step_results_run_case_id_run_cases_id_fk" FOREIGN KEY ("run_case_id") REFERENCES "public"."run_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_members" ADD CONSTRAINT "tenant_members_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_members" ADD CONSTRAINT "tenant_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_quotas" ADD CONSTRAINT "tenant_quotas_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_cases" ADD CONSTRAINT "test_cases_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_cases" ADD CONSTRAINT "test_cases_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_cases" ADD CONSTRAINT "test_cases_feature_file_id_feature_files_id_fk" FOREIGN KEY ("feature_file_id") REFERENCES "public"."feature_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger_configs" ADD CONSTRAINT "trigger_configs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger_configs" ADD CONSTRAINT "trigger_configs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger_configs" ADD CONSTRAINT "trigger_configs_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_artifacts_run" ON "artifacts" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_artifacts_run_case" ON "artifacts" USING btree ("run_case_id");--> statement-breakpoint
CREATE INDEX "idx_artifacts_expires" ON "artifacts" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_audit_logs_tenant_created" ON "audit_logs" USING btree ("tenant_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "idx_audit_logs_action" ON "audit_logs" USING btree ("action");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_ci_integrations_project_name" ON "ci_integrations" USING btree ("project_id","name");--> statement-breakpoint
CREATE INDEX "idx_ci_integrations_project" ON "ci_integrations" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_credentials_tenant_name" ON "credentials" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE INDEX "idx_credentials_tenant" ON "credentials" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_doc_commit_entries_project_sha" ON "doc_commit_entries" USING btree ("project_id","commit_sha");--> statement-breakpoint
CREATE INDEX "idx_doc_commit_entries_project_time" ON "doc_commit_entries" USING btree ("project_id","committed_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_doc_modules_project_key" ON "doc_modules" USING btree ("project_id","key");--> statement-breakpoint
CREATE INDEX "idx_doc_modules_project" ON "doc_modules" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_doc_rollups_project_tier" ON "doc_rollups" USING btree ("project_id","tier","period_end");--> statement-breakpoint
CREATE INDEX "idx_doc_versions_module_created" ON "doc_versions" USING btree ("doc_module_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "idx_doc_versions_project" ON "doc_versions" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_environment_groups_project_name" ON "environment_groups" USING btree ("project_id","name");--> statement-breakpoint
CREATE INDEX "idx_environment_groups_project" ON "environment_groups" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_environments_project_name" ON "environments" USING btree ("project_id","name");--> statement-breakpoint
CREATE INDEX "idx_environments_project" ON "environments" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_environments_db_credential" ON "environments" USING btree ("db_credential_id");--> statement-breakpoint
CREATE INDEX "idx_environments_test_account" ON "environments" USING btree ("test_account_credential_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_feature_files_path" ON "feature_files" USING btree ("project_id","repo","path");--> statement-breakpoint
CREATE INDEX "idx_feature_files_project" ON "feature_files" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_generation_files_path" ON "generation_files" USING btree ("generation_id","path");--> statement-breakpoint
CREATE INDEX "idx_generation_files_generation" ON "generation_files" USING btree ("generation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_generations_idempotency" ON "generations" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_generations_project_created" ON "generations" USING btree ("project_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "idx_generations_tenant" ON "generations" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_jobs_claim" ON "jobs" USING btree ("status","run_after","priority" desc,"created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_llm_profiles_project_name" ON "llm_profiles" USING btree ("project_id","name");--> statement-breakpoint
CREATE INDEX "idx_llm_profiles_project" ON "llm_profiles" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_llm_profiles_credential" ON "llm_profiles" USING btree ("credential_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_notification_channels_project_name" ON "notification_channels" USING btree ("project_id","name");--> statement-breakpoint
CREATE INDEX "idx_notification_channels_project" ON "notification_channels" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_notifications_dedupe" ON "notifications" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "idx_notifications_run" ON "notifications" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_notifications_project_created" ON "notifications" USING btree ("project_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "idx_project_members_user" ON "project_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_projects_tenant_slug" ON "projects" USING btree ("tenant_id","slug");--> statement-breakpoint
CREATE INDEX "idx_projects_tenant" ON "projects" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_repair_attempts_case_no" ON "repair_attempts" USING btree ("run_case_id","attempt_no");--> statement-breakpoint
CREATE INDEX "idx_repair_attempts_case" ON "repair_attempts" USING btree ("run_case_id");--> statement-breakpoint
CREATE INDEX "idx_run_cases_run_status" ON "run_cases" USING btree ("run_id","status");--> statement-breakpoint
CREATE INDEX "idx_run_cases_run_case_key" ON "run_cases" USING btree ("run_id","case_key");--> statement-breakpoint
CREATE INDEX "idx_run_cases_history" ON "run_cases" USING btree ("tenant_id","feature_path","scenario_name");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_run_events_seq" ON "run_events" USING btree ("run_id","seq");--> statement-breakpoint
CREATE INDEX "idx_runner_nodes_heartbeat" ON "runner_nodes" USING btree ("last_heartbeat_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_runs_idempotency" ON "runs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_runs_project_head" ON "runs" USING btree ("project_id","head_sha");--> statement-breakpoint
CREATE INDEX "idx_runs_tenant_created" ON "runs" USING btree ("tenant_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "idx_runs_project_created" ON "runs" USING btree ("project_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "idx_runs_status" ON "runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_sessions_user" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_sessions_expires" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sso_identities_provider_user" ON "sso_identities" USING btree ("provider_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sso_providers_tenant_name" ON "sso_providers" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE INDEX "idx_sso_providers_tenant" ON "sso_providers" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_step_results_case" ON "step_results" USING btree ("run_case_id");--> statement-breakpoint
CREATE INDEX "idx_tenant_members_user" ON "tenant_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_test_cases_file_case" ON "test_cases" USING btree ("feature_file_id","case_key");--> statement-breakpoint
CREATE INDEX "idx_test_cases_project" ON "test_cases" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_test_cases_status" ON "test_cases" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "idx_test_cases_fingerprint" ON "test_cases" USING btree ("fingerprint");--> statement-breakpoint
CREATE INDEX "idx_trigger_configs_project" ON "trigger_configs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_trigger_configs_due" ON "trigger_configs" USING btree ("enabled","next_run_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_trigger_configs_token" ON "trigger_configs" USING btree ("token_hash");