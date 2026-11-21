CREATE TABLE `worker_heartbeats` (
	`worker_id` text PRIMARY KEY NOT NULL,
	`last_seen_at` integer NOT NULL,
	`status` text DEFAULT 'idle' NOT NULL,
	`details_json` text DEFAULT '{}' NOT NULL
);
