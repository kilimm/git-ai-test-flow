CREATE TABLE "script_library" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"module_key" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"pattern" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"params_json" text DEFAULT '[]' NOT NULL,
	"examples_json" text DEFAULT '[]' NOT NULL,
	"source" text,
	"source_hash" text,
	"status" text DEFAULT 'active' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "script_library" ADD CONSTRAINT "script_library_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_script_library_name" ON "script_library" USING btree ("tenant_id","module_key","name");--> statement-breakpoint
CREATE INDEX "idx_script_library_status" ON "script_library" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "idx_script_library_module" ON "script_library" USING btree ("tenant_id","module_key");