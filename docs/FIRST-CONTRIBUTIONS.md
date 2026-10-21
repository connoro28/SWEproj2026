# First contributions to Stake

This starter turns the planned authentication, testing, and private upload work into runnable code. Scrum reports describe the team's intended work; they are not evidence that earlier code exists. Jira requires sign-in and has not been reviewed, so the tasks below have no invented Jira IDs or completion statuses.

## What this contribution implements

- React registration/login screens, account details, and a responsive goals dashboard.
- Express registration, login, logout, and database-backed sessions.
- Password hashing with bcrypt; member accounts by default; a restricted admin directory.
- PostgreSQL schema for users, sessions, draft goals, and photo metadata.
- A private photo upload attached to an owned draft goal. JPEG, PNG, and WebP inputs are limited to 5 MB, decoded, and converted to WebP without original metadata.
- Tests for access control, account validation, password hashing, session expiry/revocation, and uploaded image types, sizes, and privacy.
- A GitHub Actions workflow that runs those tests against a separate PostgreSQL service, then builds the frontend.

## First handoff

Miguel: read `server/app.js` and `server/test/app.test.js` together. Run the tests, register two accounts, and demonstrate that the second account cannot retrieve the first account's stake photo. Review the implementation before claiming it as understood or complete in a report.

Connor: review `server/schema.sql`, reproduce the PostgreSQL setup, and coordinate the next migration. Design projects, collaborators, goal windows, and check-ins before extending the draft-goal schema. The current initial migration is repeatable; future changes should use numbered migrations and a migration-history table.

Ronin: run the React interface, review the form flow and responsive layout, and connect the next check-in screens to the agreed API. Review the Actions result after the branch is pushed; a workflow file alone is not a successful CI run.

## Suggested Jira tasks

| Order | Task | Suggested owner | Completion evidence |
| --- | --- | --- | --- |
| 1 | Review and run PERN foundation | All three | Everyone runs the same branch with PostgreSQL |
| 2 | Review account registration and authentication | Miguel | Registration/login/logout and access tests pass |
| 3 | Review private stake upload pipeline | Miguel | Valid formats work; unauthorized requests fail |
| 4 | Reproduce schema setup and agree next migration | Connor | Fresh PostgreSQL database starts consistently |
| 5 | Review registration/login and dashboard UI | Ronin | Browser walkthrough on desktop and mobile |
| 6 | Add projects and collaborator membership | Connor + Ronin | Project owner can grant permitted goal access |
| 7 | Add goal schedules, windows, and photo check-ins | Connor + Miguel | Completion rules persist and have boundary tests |
| 8 | Add friendships and an authorized progress feed | Ronin + Connor | Two accounts demonstrate social accountability |
| 9 | Add deadline processing and stake release | Miguel + Connor | No duplicate or incorrect release under concurrent requests/restarts |
| 10 | Add reporting, moderation, and account bans | All three | Members report; only admins moderate |

The first five tasks have starter code, not automatically completed Jira tickets. Agree on estimates as a team rather than presenting generated estimates as a completed Planning Poker session.

## Decisions before activation and release

- Define daily/weekly requirements, user timezones, grace periods, late uploads, and what happens after a missed window.
- Decide the review policy for unreleased photos. The README proposal mentioned pre-approval; the later architecture uses reports and keeps unreleased stakes private. This starter permits only the owner to retrieve a stake, including when another account is an administrator.
- Decide whether proof photos must be captured in the app. Current stake uploads accept existing files; they do not verify when a photo was taken. In-app capture alone cannot guarantee truthful evidence.
- Explicitly show users the release conditions and intended audience before goal activation.

No goals activate in this version. Target dates are planning dates, not deadlines for automatic release. Photos are never posted to another account.

## Branch review process

Use a feature branch and pull request. Include the problem, implemented behavior, test results, and unfinished features. Have a teammate reproduce the setup and review before merging. Never commit `.env`, credentials, uploaded images, or local database files.
