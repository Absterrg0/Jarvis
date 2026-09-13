-- Merge migration: the environment_last_used and voice_reservation_identity
-- branches both descend from live_voice_usage. Both changes are already applied
-- by their own migrations; this only converges the snapshot chain.
SELECT 1;
