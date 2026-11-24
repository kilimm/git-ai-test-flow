ALTER TABLE "runs" DROP CONSTRAINT "runs_baseline_environment_id_environments_id_fk";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "baseline_environment_id";
