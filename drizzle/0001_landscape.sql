CREATE TABLE `api_cache` (
	`key` text PRIMARY KEY NOT NULL,
	`host` text NOT NULL,
	`url` text NOT NULL,
	`status` integer NOT NULL,
	`body` text NOT NULL,
	`fetched_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `api_cache_expires_at_idx` ON `api_cache` (`expires_at`);--> statement-breakpoint
CREATE TABLE `llm_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`search_id` text,
	`stage` text,
	`purpose` text NOT NULL,
	`model` text NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`cache_write_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`ok` integer DEFAULT true NOT NULL,
	`error` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	FOREIGN KEY (`search_id`) REFERENCES `searches`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `llm_calls_search_idx` ON `llm_calls` (`search_id`);--> statement-breakpoint
CREATE INDEX `llm_calls_purpose_idx` ON `llm_calls` (`purpose`,`model`);--> statement-breakpoint
CREATE TABLE `paper_citations` (
	`citing_id` text NOT NULL,
	`cited_id` text NOT NULL,
	`is_influential` integer DEFAULT false NOT NULL,
	`intents` text DEFAULT '[]' NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	PRIMARY KEY(`citing_id`, `cited_id`),
	FOREIGN KEY (`citing_id`) REFERENCES `papers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`cited_id`) REFERENCES `papers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `paper_citations_cited_idx` ON `paper_citations` (`cited_id`);--> statement-breakpoint
CREATE TABLE `paper_extractions` (
	`id` text PRIMARY KEY NOT NULL,
	`paper_id` text NOT NULL,
	`version` integer NOT NULL,
	`source` text NOT NULL,
	`source_hash` text NOT NULL,
	`model` text NOT NULL,
	`problem` text DEFAULT '' NOT NULL,
	`method` text DEFAULT '' NOT NULL,
	`results` text DEFAULT '' NOT NULL,
	`contribution` text DEFAULT '' NOT NULL,
	`limitations` text,
	`datasets` text DEFAULT '[]' NOT NULL,
	`benchmarks` text DEFAULT '[]' NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	FOREIGN KEY (`paper_id`) REFERENCES `papers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `paper_extractions_cache_key` ON `paper_extractions` (`paper_id`,`version`,`source`,`source_hash`);--> statement-breakpoint
CREATE TABLE `paper_fulltext` (
	`paper_id` text PRIMARY KEY NOT NULL,
	`text` text NOT NULL,
	`source` text NOT NULL,
	`source_url` text,
	`hash` text NOT NULL,
	`truncated` integer DEFAULT false NOT NULL,
	`fetched_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	FOREIGN KEY (`paper_id`) REFERENCES `papers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `papers` (
	`id` text PRIMARY KEY NOT NULL,
	`arxiv_id` text,
	`doi` text,
	`s2_id` text,
	`openalex_id` text,
	`norm_title` text NOT NULL,
	`title` text NOT NULL,
	`abstract` text,
	`authors` text DEFAULT '[]' NOT NULL,
	`year` integer,
	`published_at` text,
	`venue` text,
	`arxiv_url` text,
	`pdf_url` text,
	`citation_count` integer,
	`influential_citation_count` integer,
	`max_author_h_index` integer,
	`metrics_updated_at` text,
	`embedding` blob,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `papers_arxiv_id_unique` ON `papers` (`arxiv_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `papers_doi_unique` ON `papers` (`doi`);--> statement-breakpoint
CREATE UNIQUE INDEX `papers_s2_id_unique` ON `papers` (`s2_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `papers_openalex_id_unique` ON `papers` (`openalex_id`);--> statement-breakpoint
CREATE INDEX `papers_norm_title_idx` ON `papers` (`norm_title`);--> statement-breakpoint
CREATE TABLE `search_clusters` (
	`search_id` text NOT NULL,
	`idx` integer NOT NULL,
	`label` text NOT NULL,
	`summary` text,
	`key_terms` text DEFAULT '[]' NOT NULL,
	`centroid` blob,
	`size` integer NOT NULL,
	`year_min` integer,
	`year_max` integer,
	`base_cluster_idx` integer,
	`change` text,
	PRIMARY KEY(`search_id`, `idx`),
	FOREIGN KEY (`search_id`) REFERENCES `searches`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `search_documents` (
	`search_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'done' NOT NULL,
	`data` text,
	`error` text,
	`model` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	PRIMARY KEY(`search_id`, `kind`),
	FOREIGN KEY (`search_id`) REFERENCES `searches`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `search_edges` (
	`search_id` text NOT NULL,
	`source_id` text NOT NULL,
	`target_id` text NOT NULL,
	`kind` text NOT NULL,
	`weight` real DEFAULT 1 NOT NULL,
	PRIMARY KEY(`search_id`, `source_id`, `target_id`, `kind`),
	FOREIGN KEY (`search_id`) REFERENCES `searches`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `papers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_id`) REFERENCES `papers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `search_edges_target_idx` ON `search_edges` (`search_id`,`target_id`);--> statement-breakpoint
CREATE TABLE `search_papers` (
	`search_id` text NOT NULL,
	`paper_id` text NOT NULL,
	`origin` text NOT NULL,
	`source_rank` integer,
	`query_hits` text DEFAULT '[]' NOT NULL,
	`bm25` real,
	`cosine` real,
	`rrf` real,
	`rerank` real,
	`final_rank` integer,
	`selected` integer DEFAULT false NOT NULL,
	`foundational` integer DEFAULT false NOT NULL,
	`citation_count` integer,
	`influential_citation_count` integer,
	`velocity` real,
	`pagerank` real,
	`max_author_h_index` integer,
	`influence` real,
	`cluster_idx` integer,
	`extraction_id` text,
	`game_changer` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`search_id`, `paper_id`),
	FOREIGN KEY (`search_id`) REFERENCES `searches`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`paper_id`) REFERENCES `papers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`extraction_id`) REFERENCES `paper_extractions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `search_papers_paper_idx` ON `search_papers` (`paper_id`);--> statement-breakpoint
CREATE INDEX `search_papers_selected_idx` ON `search_papers` (`search_id`,`selected`,`final_rank`);--> statement-breakpoint
CREATE TABLE `search_stages` (
	`search_id` text NOT NULL,
	`stage` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`checkpoint` text,
	`error` text,
	`started_at` text,
	`finished_at` text,
	PRIMARY KEY(`search_id`, `stage`),
	FOREIGN KEY (`search_id`) REFERENCES `searches`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `searches` (
	`id` text PRIMARY KEY NOT NULL,
	`topic_id` text NOT NULL,
	`kind` text DEFAULT 'initial' NOT NULL,
	`base_search_id` text,
	`depth` text NOT NULL,
	`config` text NOT NULL,
	`queries` text DEFAULT '[]' NOT NULL,
	`since` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`stage` text,
	`progress` real DEFAULT 0 NOT NULL,
	`counters` text DEFAULT '{}' NOT NULL,
	`error` text,
	`cancel_requested` integer DEFAULT false NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`cache_write_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`started_at` text,
	`finished_at` text,
	`heartbeat_at` text,
	FOREIGN KEY (`topic_id`) REFERENCES `topics`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`base_search_id`) REFERENCES `searches`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `searches_topic_created_idx` ON `searches` (`topic_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `searches_status_idx` ON `searches` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `searches_one_active_per_topic` ON `searches` (`topic_id`) WHERE status in ('queued', 'running');--> statement-breakpoint
CREATE TABLE `topics` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`embedding` blob,
	`default_depth` text DEFAULT 'standard' NOT NULL,
	`summary` text,
	`last_search_id` text,
	`last_search_at` text,
	`paper_count` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `topics_slug_unique` ON `topics` (`slug`);--> statement-breakpoint
CREATE INDEX `topics_last_search_at_idx` ON `topics` (`last_search_at`);