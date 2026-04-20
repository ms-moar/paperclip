ALTER TABLE "heartbeat_runs" ADD COLUMN "adapter_retry_count" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "not_before" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX "heartbeat_runs_queued_not_before_idx" ON "heartbeat_runs" ("agent_id", "status", "not_before") WHERE "status" = 'queued';
