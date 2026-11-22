-- Files reuse actor-private personal pins; preserve all historical rows/receipts.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='flightdeck_pg_thread_pins'::regclass AND conname='fd_personal_pin_type' AND pg_get_constraintdef(oid) LIKE '%file%') THEN
  ALTER TABLE flightdeck_pg_thread_pins DROP CONSTRAINT IF EXISTS fd_personal_pin_type;
  ALTER TABLE flightdeck_pg_thread_pins ADD CONSTRAINT fd_personal_pin_type CHECK(resource_type IN ('thread','task','document','channel','file') AND
    ((resource_type='thread' AND thread_id IS NOT NULL AND thread_id=resource_id) OR (resource_type<>'thread' AND thread_id IS NULL)));
 END IF;
END $$;
