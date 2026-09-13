-- Cloud live-voice session table. Also creates relay_environment_link_limits
-- and relay_device_limits, which the link and device flows already query but
-- no earlier migration created.
CREATE TABLE "relay_device_limits" (
	"user_id" varchar(255) PRIMARY KEY,
	"max_devices" integer NOT NULL,
	"created_at" varchar(64) NOT NULL,
	"updated_at" varchar(64) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relay_environment_link_limits" (
	"user_id" varchar(191) PRIMARY KEY,
	"max_links" integer NOT NULL,
	"created_at" varchar(64) NOT NULL,
	"updated_at" varchar(64) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relay_live_voice_sessions" (
	"user_id" varchar(191) PRIMARY KEY,
	"session_id" varchar(191) NOT NULL,
	"environment_id" varchar(191) NOT NULL,
	"expires_at" varchar(64) NOT NULL,
	"created_at" varchar(64) NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_relay_live_voice_sessions_expires_at" ON "relay_live_voice_sessions" ("expires_at");
