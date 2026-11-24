CREATE TABLE "case_blobs" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"path" text NOT NULL,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"origin" text DEFAULT 'manual' NOT NULL,
	"source_commit" text,
	"updated_by" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "case_storage" text DEFAULT 'repo' NOT NULL;--> statement-breakpoint
ALTER TABLE "case_blobs" ADD CONSTRAINT "case_blobs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_blobs" ADD CONSTRAINT "case_blobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_case_blobs_path" ON "case_blobs" USING btree ("project_id","path");--> statement-breakpoint
CREATE INDEX "idx_case_blobs_project" ON "case_blobs" USING btree ("project_id");