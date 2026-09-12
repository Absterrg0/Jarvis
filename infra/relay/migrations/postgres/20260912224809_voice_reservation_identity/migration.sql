ALTER TABLE "relay_live_voice_sessions" ADD COLUMN "reservation_id" varchar(36) DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "relay_live_voice_sessions" ALTER COLUMN "session_id" DROP NOT NULL;
--> statement-breakpoint
-- Earlier empty ids also represent an uncertain upstream outcome.
UPDATE "relay_live_voice_sessions" SET "session_id" = NULL WHERE "session_id" = '';
