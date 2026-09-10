CREATE TABLE `entries` (
	`id` text PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`category` text DEFAULT 'Other' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`why_saved` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'to-read' NOT NULL,
	`rating` integer,
	`title` text DEFAULT '' NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`key_claims` text DEFAULT '[]' NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`authors` text DEFAULT '[]' NOT NULL,
	`org` text,
	`venue` text,
	`published_at` text,
	`content_type` text DEFAULT 'other' NOT NULL,
	`embedding` blob,
	`raw_text` text,
	`ingest_status` text DEFAULT 'pending' NOT NULL,
	`ingest_error` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `entries_created_at_idx` ON `entries` (`created_at`);--> statement-breakpoint
CREATE INDEX `entries_category_idx` ON `entries` (`category`);--> statement-breakpoint
CREATE INDEX `entries_status_idx` ON `entries` (`ingest_status`);