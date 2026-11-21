CREATE TABLE `sso_identities` (
	`provider_id` text NOT NULL,
	`subject` text NOT NULL,
	`tenant_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_login_at` integer,
	PRIMARY KEY(`provider_id`, `subject`),
	FOREIGN KEY (`provider_id`) REFERENCES `sso_providers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_sso_identities_provider_user` ON `sso_identities` (`provider_id`,`user_id`);