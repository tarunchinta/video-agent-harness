# Event log database

Schema for the run event log and run state. The design and the reasoning are in
`docs/plans/event-log-and-run-state.md`.

Requires PostgreSQL 18. No extensions. It runs the same on Azure Database for
PostgreSQL flexible server and on a local `postgres:18` container.

## Files

| File | Run as | When |
|---|---|---|
| `bootstrap.sql` | Server administrator | Once per database, before any migration |
| `migrations/0001_event_log_and_run_state.sql` | A member of `harness_owner` | Once; it records itself in `harness.schema_migrations` |
| `migrations/0002_web_role.sql` | A member of `harness_owner` | Once, after 0001 |

`migrate()` in `packages/store-postgres` applies `bootstrap.sql` and every migration not yet recorded, in order;
the Postgres store's tests use it on a throwaway database. You can also apply the files in order with any client that
sends a whole file as one script, for example:

```sh
psql "host=<server>.postgres.database.azure.com dbname=harness user=<admin> sslmode=require" \
  -v ON_ERROR_STOP=1 -f db/bootstrap.sql -f db/migrations/0001_event_log_and_run_state.sql \
  -f db/migrations/0002_web_role.sql
```

Both files are safe to read before running: they hold no secrets.

## Roles

| Role | Login | Can do |
|---|---|---|
| `harness_owner` | No | Owns the `harness` schema. Used for migrations and for deleting a run. |
| `harness_app` | Yes, once given a password | Read everything; insert events and artifacts; insert and update runs. Cannot delete, cannot update events or artifacts, cannot change the schema. What the worker and the terminal use. |
| `harness_web` | Yes, once given a password | Read everything; append only creator events (create, answer a review, budget, resume, pause, cancel, `x.web.*`) and the closing events a cancel writes. Cannot take or extend a lease, so it cannot drive a run or write model output. What `harness web --remote` uses. |

`bootstrap.sql` creates `harness_app` and `harness_web` without a login. Give
them one out of band and keep the passwords out of the repo:

```sql
ALTER ROLE harness_app LOGIN PASSWORD '<generated>' CONNECTION LIMIT 20;
ALTER ROLE harness_web LOGIN PASSWORD '<another one>' CONNECTION LIMIT 10;
```

Nothing in the harness connects to the database yet. Runs are kept as files
under `runs/` until the Postgres event store is built. When it is, it will read
its connection string from `DATABASE_URL` in `.env`, which is git-ignored:

```
DATABASE_URL=postgres://harness_app:<password>@<server>.postgres.database.azure.com:5432/harness?sslmode=require
```

## Deleting a run

The application role cannot delete. Do it as the owner; events and artifact
rows follow by cascade.

```sql
BEGIN;
SET LOCAL ROLE harness_owner;
DELETE FROM harness.runs WHERE run_id = '<run id>';
COMMIT;
```

## Azure notes

- **Admin sign-in.** With Microsoft Entra authentication, the admin user is the
  account's sign-in name and the password is a short-lived token:
  `az account get-access-token --resource-type oss-rdbms --query accessToken -o tsv`.
- **Firewall.** The server only accepts addresses listed in its firewall rules.
  A connection from an unlisted address times out; it does not return an error.
- **The address to allow may not be the one a "what is my IP" site shows.** Some
  networks, mobile hotspots in particular, send database traffic out from a
  different address than web traffic. If the rule looks right and connections
  still time out, this is the likely cause. The reliable way to find the
  address is to ask the server from a session that can connect:
  `SELECT inet_client_addr();`
- **Updating the rule** after your address changes:

  ```sh
  az postgres flexible-server firewall-rule create \
    --resource-group <resource group> --name <server> --rule-name dev-machine \
    --start-ip-address <address> --end-ip-address <address>
  ```

- **Live updates.** `LISTEN` needs a direct connection on port 5432. It does not
  work through the built-in PgBouncer on port 6432.
