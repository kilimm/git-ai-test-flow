DROP INDEX "uq_runs_idempotency";--> statement-breakpoint
CREATE UNIQUE INDEX "uq_runs_idempotency" ON "runs" USING btree ("idempotency_key") WHERE status in ('queued', 'running');