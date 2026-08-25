-- Output provenance is immutable to direct callers, but the schema deliberately
-- uses ON DELETE SET NULL when its producer run is removed. PostgreSQL executes
-- that referential action as a nested trigger statement. Permit only that
-- non-null-to-null cleanup; all direct producer changes remain rejected.
CREATE OR REPLACE FUNCTION arcdb_protect_output_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.lifecycle_state IN ('COMMITTED', 'CONSUMED', 'PROMOTED', 'SUPERSEDED', 'INVALIDATED') THEN
      RAISE EXCEPTION 'committed output versions cannot be deleted' USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.version_id IS DISTINCT FROM OLD.version_id OR
       NEW.logical_id IS DISTINCT FROM OLD.logical_id OR
       NEW.output_type IS DISTINCT FROM OLD.output_type OR
       NEW.schema_id IS DISTINCT FROM OLD.schema_id OR
       NEW.content_ref IS DISTINCT FROM OLD.content_ref OR
       NEW.content_digest IS DISTINCT FROM OLD.content_digest OR
       (
         NEW.producer_run_id IS DISTINCT FROM OLD.producer_run_id AND
         NOT (
           pg_trigger_depth() > 1 AND
           OLD.producer_run_id IS NOT NULL AND
           NEW.producer_run_id IS NULL
         )
       ) OR
       NEW.producer_agent_id IS DISTINCT FROM OLD.producer_agent_id OR
       NEW.parent_version_ids IS DISTINCT FROM OLD.parent_version_ids OR
       NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'output version identity and content are immutable' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
