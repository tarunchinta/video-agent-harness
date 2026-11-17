-- One-time server bootstrap. Run as the server administrator, connected to
-- the harness database, before any migration.
--
-- Creates two roles and holds no secrets:
--   harness_owner  owns the schema; used for migrations and for deleting runs.
--   harness_app    what the harness connects as; can read and append only.
--
-- harness_app is created without a login. Give it one out of band:
--   ALTER ROLE harness_app LOGIN PASSWORD '<generated>';

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'harness_owner') THEN
    CREATE ROLE harness_owner NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'harness_app') THEN
    CREATE ROLE harness_app NOLOGIN;
  END IF;
END $$;

-- Let the administrator act as the owner for migrations.
DO $$
BEGIN
  EXECUTE format('GRANT harness_owner TO %I', current_user);
  EXECUTE format('GRANT CONNECT, CREATE ON DATABASE %I TO harness_owner', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO harness_app', current_database());
END $$;
