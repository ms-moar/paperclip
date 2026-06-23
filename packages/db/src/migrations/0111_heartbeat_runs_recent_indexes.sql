CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_created_idx"
  ON "heartbeat_runs" ("company_id", "created_at" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_agent_created_idx"
  ON "heartbeat_runs" ("company_id", "agent_id", "created_at" DESC, "id" DESC);
