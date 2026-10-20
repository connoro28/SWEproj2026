# Migrations

`npm run db:migrate` runs every `.sql` file here that the database has not yet
applied, in filename order, and records its version (the filename without
`.sql`) in the `schema_migrations` table.

## Naming

`NNN_snake_case.sql`: a three-digit, zero-padded, sequential number followed by
a short description, e.g. `002_add_check_ins.sql`. Take the next unused number;
never reuse or skip one.

## Never edit an applied migration

Once a migration is committed or has run on any database, do not change it,
even to fix a typo. Databases that already applied it will not run it again,
so an edit makes schemas silently differ between machines. Make every change,
including corrections, in a new, next-numbered file.

Each file runs as one transaction, so don't put `BEGIN`/`COMMIT` in it.
