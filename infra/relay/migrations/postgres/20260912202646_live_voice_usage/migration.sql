CREATE TABLE "relay_live_voice_starts" (
	"session_id" varchar(191) PRIMARY KEY,
	"user_id" varchar(191) NOT NULL,
	"started_at" varchar(64) NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_relay_live_voice_starts_user" ON "relay_live_voice_starts" ("user_id","started_at");