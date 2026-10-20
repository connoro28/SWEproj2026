# Stake

Stake is a social accountability app built by Productivity Masters for CEN3031. This repository now contains the first runnable implementation of the PERN stack: PostgreSQL, Express, React, and Node.js.

**Implemented:** registration, login/logout, member/admin access, draft goals, and private stake photo uploads with automated tests. **Planned:** projects/collaborators, check-ins, friendships/feed, reminders, moderation, and scheduled stake release. No photos are automatically released in this version.

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

The migration creates users, sessions, goals, and photos. It is repeatable and does not erase data.

For the intended shared-server deployment, all browsers use the same Express server; only that server connects to the central PostgreSQL database and private storage. Do not point each teammate's independent backend at one shared database while keeping separate local upload directories: the photo files would be missing on the other backends. The local preview does not demonstrate multi-machine access.

## Check the implementation

```sh
npm test
npm run build
```

Tests use embedded PostgreSQL by default, with a separate temporary photo directory for each test. They cover authentication, role restrictions, invalid input, session expiry and logout, goal ownership, image formats/size, private retrieval, and duplicate upload cleanup.

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
| GET / POST | `/api/goals` | Lists owned goals / creates a draft goal |
| POST | `/api/goals/:id/stake` | Uploads one private stake for an owned goal; multipart field `photo` |
| GET | `/api/photos/:id` | Retrieves a photo only for its owner |
| GET | `/api/admin/users` | Lists up to 100 accounts; admins only |

Uploads accept JPEG, PNG, and WebP images up to 5 MB and 16 megapixels. Images are decoded, resized when needed, stripped of original metadata, and stored as WebP. Files are outside the public frontend directory. PostgreSQL stores the image identifiers, ownership through the goal, and storage metadata. Responses never return filesystem paths. There is no photo-replacement or deletion flow yet.

### Removing users and their photos

Deleting a user with SQL `DELETE FROM users WHERE ...` cascades to their goals, sessions, and photo metadata. A database trigger also queues the deleted photos' storage keys. The running API checks that queue on startup and every 30 seconds, removing the corresponding private image files. This frees disk space; the database stores metadata rather than the image bytes.

## Project layout

```text
client/                     React screens and styling
server/app.js               API, authentication, authorization, uploads
server/schema.sql           Initial PostgreSQL schema
server/migrate.js           Repeatable initial database setup
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
