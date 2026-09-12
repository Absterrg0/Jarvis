ALTER TABLE "relay_environment_links" ADD COLUMN "enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
UPDATE "relay_environment_links" AS l SET "enabled" = false
FROM (
  SELECT "user_id", "environment_id",
    row_number() OVER (
      PARTITION BY "user_id" ORDER BY "created_at" ASC, "environment_id" ASC
    ) AS position
  FROM "relay_environment_links"
  WHERE "revoked_at" IS NULL
) AS ranked
WHERE l."user_id" = ranked."user_id"
  AND l."environment_id" = ranked."environment_id"
  AND ranked.position > 5;
