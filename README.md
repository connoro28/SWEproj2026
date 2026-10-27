# Stake

Stake is a social accountability app built by Productivity Masters for CEN3031. This repository now contains the first runnable implementation of the PERN stack: PostgreSQL, Express, React, and Node.js.

**Implemented:** registration, login/logout, member/admin access, scheduled goals (daily or weekly, with a deadline time and time zone), private stake photo uploads, goal activation, daily photo check-ins, friend requests (API only), and a friends' check-in feed, with automated tests. **Planned:** projects/collaborators, the friends interface, reminders, moderation, and scheduled stake release. No photos are automatically released in this version.

## Run locally

Install Node.js 24 LTS with npm. If you use nvm, run `nvm install` and `nvm use` in this directory.

```sh
npm ci
npm run build
npm run preview:local
```

Open **http://localhost:3001**. Register an account, create a goal, and attach a photo. Register a second account after logging out to check that its dashboard is separate. There are no default accounts or passwords.

This preview uses embedded PostgreSQL (PGlite) in `var/preview-db` and private photos in `var/preview-photos`. It persists between restarts but is a single-machine preview. It is separate from the normal PostgreSQL setup below. Stop the preview with Ctrl+C before starting the regular API on the same port.

## Team development with PostgreSQL

Prerequisites: Node.js 24 LTS, npm, and Docker with Compose (or a separately installed PostgreSQL server).

```sh
npm ci
cp .env.example .env
docker compose up -d --wait
npm run db:migrate
npm run dev
```

Open **http://localhost:5173**. Vite serves the React interface and forwards `/api` requests to Express on port 3001. Use exactly the hostname configured in `APP_ORIGIN`; the default is `http://localhost:5173`.

The Compose credentials in `.env.example` are for this local database only. Docker exposes PostgreSQL on localhost port **5433** (the container uses 5432), avoiding conflicts with a separately installed PostgreSQL service. The database port and API bind to loopback. If using PostgreSQL installed separately instead of Docker, create a database and set `DATABASE_URL` to its connection string and port, then run the migration.

`npm run db:migrate` applies the numbered SQL files in `server/migrations/` in filename order and records each one in a `schema_migrations` table, so every file runs exactly once per database and rerunning the command only applies files it has not seen. Each file runs in a single transaction: a failing migration leaves no partial changes and is not recorded. `001_initial.sql` creates users, sessions, goals, and photos; `002_goal_scheduling.sql` adds goal schedules and activation. Neither erases data.

**Never edit a migration that has been committed or run anywhere.** Databases that already applied it will not run it again, so edits silently diverge. Put every schema change in a new, next-numbered file instead; see `server/migrations/README.md`.

For the intended shared-server deployment, all browsers use the same Express server; only that server connects to the central PostgreSQL database and private storage. Do not point each teammate's independent backend at one shared database while keeping separate local upload directories: the photo files would be missing on the other backends. The local preview does not demonstrate multi-machine access.

## Check the implementation

```sh
npm test
npm run build
```

Tests use embedded PostgreSQL by default, with a separate temporary photo directory for each test. They cover authentication, role restrictions, invalid input, session expiry and logout, goal ownership, schedule validation, activation rules, image formats/size, private retrieval, and duplicate upload cleanup.

To run against a real PostgreSQL server, set `TEST_DATABASE_URL` to a **dedicated disposable test database**, then run `npm test`. The test suite truncates its application tables before each test. Never use your development or production database as the test database.

GitHub Actions supplies a disposable PostgreSQL 17 service and runs `npm run check` (tests and frontend build) on pushes and pull requests. The hosted workflow must still run after this branch is pushed.

## Administrator access

Everyone registers as a member. The client cannot choose an admin role. Against the normal PostgreSQL database, an operator with database access can promote an existing registered account:

```sh
npm run admin -- existing-user@example.com
```

The account then sees the administrator directory. This command uses `DATABASE_URL`, not the embedded preview database. Content moderation and banning screens have not been implemented. Existing banned accounts are denied login and protected API access.

## API

State-changing requests require `X-Stake-Request: 1`. If an Origin header is present, it must match `APP_ORIGIN`. The React client supplies the request header. Authentication uses a random opaque token in an HttpOnly, SameSite cookie; PostgreSQL stores only the token hash and expiry.

| Method | Endpoint | Behavior |
| --- | --- | --- |
| GET | `/api/health` | Checks database connectivity |
| POST | `/api/auth/register` | Creates a member and starts a session |
| POST | `/api/auth/login` | Verifies password and starts a session |
| POST | `/api/auth/logout` | Revokes the session and clears the cookie |
| GET | `/api/auth/me` | Returns the signed-in account |
| GET / POST | `/api/goals` | Lists owned goals / creates a draft goal; see the fields below |
| POST | `/api/goals/:id/stake` | Uploads one private stake for an owned goal; multipart field `photo` |
| POST | `/api/goals/:id/activate` | Activates an owned draft goal that has a stake photo; returns the goal |
| GET / POST | `/api/goals/:id/check-ins` | Lists an owned goal's check-ins newest first with `progress` (`todayDone`, `thisWeekCount`, `target`, `canCheckInNow`) / submits today's photo check-in; multipart field `photo` |
| GET | `/api/photos/:id` | Retrieves a photo for its owner; accepted friends may retrieve check-in photos only, never stakes. Everyone else gets 404 |
| GET | `/api/feed?cursor=` | Lists accepted friends' check-ins on active goals, newest first, 20 per page, with `nextCursor` (null on the last page) |
| GET | `/api/users/search?q=` | Finds up to 20 other active members by name prefix or exact email; `q` needs at least 2 characters. Returns `id`, `name`, and `relationship` (`none`, `pending_outgoing`, `pending_incoming`, `friends`), never email |
| GET / POST | `/api/friends/requests` | Lists pending requests as `{ incoming, outgoing }` / sends a request; body `{ addresseeId }` |
| POST | `/api/friends/requests/:id/accept` | Accepts a pending request; addressee only |
| POST | `/api/friends/requests/:id/decline` | Declines a pending request; addressee only |
| GET | `/api/friends` | Lists accepted friends in either direction (`id`, `name`) |
| GET | `/api/admin/users` | Lists up to 100 accounts; admins only |

`POST /api/goals` takes a JSON body:

| Field | Required | Rules |
| --- | --- | --- |
| `title` | Yes | 1–120 characters |
| `description` | No | Up to 1000 characters |
| `targetDate` | No | `YYYY-MM-DD`; a planning date, not a deadline |
| `frequency` | Yes | `daily` or `weekly` |
| `timesPerWeek` | Weekly only | Integer 1–7; must be omitted for daily goals |
| `deadlineTime` | Yes | 24-hour `HH:MM`, e.g. `21:00` |
| `timezone` | Yes | IANA time zone, e.g. `America/New_York`; the client sends the browser's zone |

Invalid fields return 400. New goals are always drafts. `POST /api/goals/:id/activate` returns 409 if the goal is already active or has no stake photo, and 404 for a goal the caller does not own. Activation is permanent: there is no endpoint to edit or deactivate an active goal.

`POST /api/goals/:id/check-ins` returns 409 if the goal is not active, if today's deadline has passed, or if the goal already has a check-in today. The server computes the local date and time in PostgreSQL from the goal's time zone; the client's clock is never used. Check-in photos follow the same upload rules as stakes.

Uploads accept JPEG, PNG, and WebP images up to 5 MB and 16 megapixels. Images are decoded, resized when needed, stripped of original metadata, and stored as WebP. Files are outside the public frontend directory. PostgreSQL stores the image identifiers, ownership through the goal, and storage metadata. Responses never return filesystem paths. There is no photo-replacement or deletion flow yet.

Sending a friend request returns 400 for yourself, 404 for a missing or banned account, and 409 if a pending or accepted request already exists in either direction. Accepting or declining a request you did not receive returns 404; answering one that is no longer pending returns 409. A declined request can be sent again by either member. Banned members are left out of search, request lists, and friends lists.

### Photo privacy

**A stake photo is private to its owner, forever.** No friend and no administrator can retrieve it. Check-in photos are visible to the owner and to members with an *accepted* friendship with the owner, as long as the owner's account and the goal are active; these are the same conditions that put a check-in in the feed. Pending and declined requests grant nothing. Every refused photo request returns 404, exactly like a photo that does not exist. The rule lives in one SQL query in `GET /api/photos/:id`; `server/test/feed.test.js` holds the authorization tests.

The feed uses a cursor (the last item's `submitted_at` with microseconds, and its id) rather than an offset, so items are not skipped or repeated when new check-ins arrive while someone scrolls.

### Goal scheduling rules

These are settled team decisions:

- **Frequency.** A goal is either `daily` (a check-in every day) or `weekly` with a target of 1–7 check-ins per week.
- **Time zones.** Each goal stores its own IANA time zone, captured from the browser when the goal is created. The deadline is a wall-clock time in that zone, so it does not shift if the user travels or changes their device's zone later.
- **No grace period.** The deadline is a hard cutoff.
- **Deadlines apply per day.** This includes weekly goals: "3 times per week by 9:00 PM" means check-ins on three separate days, each submitted by 9:00 PM in the goal's time zone. A goal accepts at most one check-in per local day, and once the deadline time passes that day is closed. Weeks start on Monday in the goal's time zone.
- **A stake is required to activate.** A goal cannot be activated without a stake photo, as specified in the architecture document. This is the core product rule.

Stake release is not built yet; activation records `activated_at` for it to start from. Drafts created before migration `002_goal_scheduling` have no schedule and cannot be activated.

### Removing users and their photos

Deleting a user with SQL `DELETE FROM users WHERE ...` cascades to their goals, sessions, and photo metadata. A database trigger also queues the deleted photos' storage keys. The running API checks that queue on startup and every 30 seconds, removing the corresponding private image files. This frees disk space; the database stores metadata rather than the image bytes.

## Project layout

```text
client/                     React screens and styling
server/app.js               API, authentication, authorization, uploads
server/migrations/          Numbered PostgreSQL migrations
server/migrate.js           Applies pending migrations once each
server/test/                Integration tests
server/preview.js           Single-machine embedded preview
.github/workflows/check.yml PostgreSQL tests and frontend build
compose.yaml                Local PostgreSQL service
var/                        Ignored local data and private photos
```

Configuration lives in `.env` (ignored by Git). Keep `.env.example` free of real credentials. For deployment, build the frontend, set `NODE_ENV=production`, set an HTTPS `APP_ORIGIN`, and run `npm start` behind a same-origin HTTPS reverse proxy. Express serves `dist/` in production and uses secure cookies. Deployment, shared persistent photo storage/backups, and production infrastructure remain future work; this starter is for local development.

## Team and next work

- Ronin Mithaug — Product Owner
- Connor Opdyke — Scrum Master
- Miguel Rosario — Development Team Lead

Start with [First contributions](docs/FIRST-CONTRIBUTIONS.md) for ownership, proposed Jira tasks, decisions, and review steps. The Jira board requires sign-in and was not read during implementation; no Jira items have been modified.

## Planning references

The original planning artifacts are preserved:

- [Development Environment and Project Proposal](Development%20Environment%20and%20Project%20Proposal%20%28DEPP%29%20Plan.pdf)
- [Architecture models](Stake_Architecture_Models.pdf)
- [User stories](User%20Stories%20%281%29.pdf)
- [Sprint 0 presentation](Stake%20Sprint%200%20Presentation.pptx)

These describe the intended full product, including features that are not implemented yet. The architecture's layered client-server design guides this initial implementation. Earlier proposal wording about photo pre-approval and user moderation needs team agreement before those features are built.
