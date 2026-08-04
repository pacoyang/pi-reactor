/**
 * DDL sequence. Its own file because pi does the same with
 * `src/migrations.ts` ("One-time migrations that run on startup"). Adding a
 * migration touches only this pure-SQL file; db.ts connection logic stays put.
 *
 * Rule: APPEND ONLY. A published migration is never edited; every schema change
 * is a new entry. Array index + 1 is the `PRAGMA user_version`.
 */

export const MIGRATIONS: readonly string[] = [
	// v1 -- initial schema
	`
	-- Events: the append-only record of everything that arrived.
	CREATE TABLE events (
	  seq         INTEGER PRIMARY KEY,
	  ce_id       TEXT NOT NULL,
	  ce_source   TEXT NOT NULL,
	  ce_type     TEXT NOT NULL,
	  ce_time     TEXT,
	  lane        TEXT NOT NULL CHECK (lane IN ('interactive','batch')),
	  data        TEXT NOT NULL,
	  received_at TEXT NOT NULL,
	  UNIQUE (ce_source, ce_id)   -- CloudEvents dedup semantics; exactly-once enqueue rests on this
	);

	-- Jobs: the scheduling unit of the batch lane.
	CREATE TABLE jobs (
	  id                 INTEGER PRIMARY KEY,
	  event_seq          INTEGER NOT NULL REFERENCES events(seq) ON DELETE CASCADE,
	  agent              TEXT NOT NULL,
	  task               TEXT,
	  skill              TEXT,
	  trigger_id         TEXT,          -- points back at schedules for cron fires (breaker counts them)
	  state              TEXT NOT NULL DEFAULT 'pending'
	                     CHECK (state IN ('pending','running','succeeded','failed',
	                                      'interrupted','dead')),
	  reason             TEXT,          -- policy = timeout|budget_exceeded|config_error (never retried)
	                                    --      infra  = provider_error|crash (the only retryable class)
	  attempts           INTEGER NOT NULL DEFAULT 0,
	  max_duration_s     INTEGER NOT NULL DEFAULT 1800,
	  require_clean_tree INTEGER NOT NULL DEFAULT 0,
	  retryable          INTEGER NOT NULL DEFAULT 1,
	  notify_sink        TEXT,
	  notify_when        TEXT CHECK (notify_when IN ('success','failure','always')),
	  scheduled_at       TEXT,          -- earliest time a backed-off retry may be claimed
	  created_at         TEXT NOT NULL,
	  started_at         TEXT,
	  finished_at        TEXT
	);
	CREATE INDEX jobs_claim ON jobs(state, scheduled_at, created_at);

	-- Schedule state. Config itself never lands here: only the watermark and breaker.
	CREATE TABLE schedules (
	  trigger_id           TEXT PRIMARY KEY,
	  last_fired_at        TEXT,        -- scheduledAt of the most recent actual enqueue
	  consecutive_failures INTEGER NOT NULL DEFAULT 0,   -- any success resets to zero
	  tripped_at           TEXT,        -- non-null = tripped; cleared by schedule.resume
	  updated_at           TEXT NOT NULL
	);

	-- Run history: one row per spawn. PII-free -- no prompt or output body.
	CREATE TABLE runs (
	  id            INTEGER PRIMARY KEY,
	  job_id        INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
	  agent         TEXT NOT NULL,
	  pid           INTEGER,
	  session_file  TEXT,               -- pi session JSONL path (the body lives there; reaper ages it out)
	  outcome       TEXT CHECK (outcome IN ('succeeded','failed','interrupted')),
	  reason        TEXT,
	  error_summary TEXT,               -- truncated error summary, no user content
	  input_tokens  INTEGER, output_tokens INTEGER,
	  cache_read    INTEGER, cache_write  INTEGER,
	  total_tokens  INTEGER,            -- the unit the budget gate counts
	  started_at    TEXT NOT NULL,
	  finished_at   TEXT
	);
	CREATE INDEX runs_day ON runs(started_at);

	-- Outbound: transactional outbox. The final text lands here rather than in
	-- runs, which separates notification from history and keeps runs PII-free.
	CREATE TABLE outbox (
	  id           INTEGER PRIMARY KEY,
	  run_id       INTEGER REFERENCES runs(id) ON DELETE SET NULL,  -- NULL = agent-initiated notify
	  sink         TEXT NOT NULL,
	  body         TEXT NOT NULL,
	  state        TEXT NOT NULL DEFAULT 'pending'
	               CHECK (state IN ('pending','sent','dead')),
	  attempts     INTEGER NOT NULL DEFAULT 0,
	  scheduled_at TEXT,                -- backoff 1m/5m/30m...; dead after maxAttempts=8
	  created_at   TEXT NOT NULL,
	  sent_at      TEXT
	);
	CREATE INDEX outbox_claim ON outbox(state, scheduled_at, created_at);

	-- Runtime switches (durable pause and friends). A KV table beats one table per boolean.
	CREATE TABLE runtime_state (
	  key        TEXT PRIMARY KEY,
	  value      TEXT NOT NULL,
	  updated_at TEXT NOT NULL
	);
	`,

	// v2 -- pi's session id, the one handle that survives leaving this machine
	`
	-- Captured from the get_state handshake, which is the earliest this exists
	-- anywhere outside pi. Notifications and \`resume\` address sessions by it
	-- because the alternatives do not travel: a run id is a per-daemon
	-- autoincrement, and session_file is an absolute path on one host.
	--
	-- Deliberately unindexed. The only lookup is a prefix comparison, which no
	-- index on this column can serve anyway, and runs is small (bounded by
	-- retention) and read once per interactive resume. An index here would be a
	-- net loss: paid on every claim and settle, both hot, to speed up nothing.
	ALTER TABLE runs ADD COLUMN session_id TEXT;
	`,
];
