-- One-time server bootstrap. Run as the server administrator, connected to
-- the harness database, before any migration.
--
-- Creates three roles and holds no secrets:
--   harness_owner  owns the schema; used for migrations and for deleting runs.
--   harness_app    what the worker and the terminal connect as; can read and append only.
--   harness_web    what a web server in the cloud connects as; can read, and write
--                  only what the creator may ask for (see migration 0002).
--
-- harness_app and harness_web are created without a login. Give them one out of band:
--   ALTER ROLE harness_app LOGIN PASSWORD '<generated>';

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'harness_owner') THEN
    CREATE ROLE harness_owner NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'harness_app') THEN
    CREATE ROLE harness_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'harness_web') THEN
    CREATE ROLE harness_web NOLOGIN;
  END IF;
END $$;

-- Let the administrator act as the owner for migrations.
DO $$
BEGIN
  EXECUTE format('GRANT harness_owner TO %I', current_user);
  EXECUTE format('GRANT CONNECT, CREATE ON DATABASE %I TO harness_owner', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO harness_app', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO harness_web', current_database());
END $$;
