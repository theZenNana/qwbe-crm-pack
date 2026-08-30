# crm-pack frontend (QWB-48)

Next.js (App Router) + TypeScript + Tailwind app for the CRM pack. All UI
components come from [shadcn/ui](https://ui.shadcn.com) — copied exactly as the
shadcn CLI generated them, never restyled.

## Authentication model

Follows `qwbe/docs/external-frontend-auth.md`: the qwbe token never reaches the
browser. It lives in an httpOnly cookie set by the Next.js server, and every
call to qwbe goes through a Next.js route handler acting as a server-side proxy
(`src/app/api/qwbe/[...path]/route.ts`).

## Metadata-driven lists and details (QWB-49)

The lists at `/accounts` and `/contacts` are one generic component driven entirely by the
per-cube field metadata that qwbe publishes at `GET /catalog/{cube}/metadata`: columns,
sorting, editability, search and paging all come from that metadata, so adding a field to a
cube makes it appear in the UI with no frontend change. Inline editing PATCHes through the
server-side proxy and surfaces a qwbe validation error in the edited cell; detail pages are
assembled from the same metadata, with an organization's contacts derived by filtering
`crm/contacts` on `accountId` and a contact's organization shown as a relation link.
Paging and sorting are server-side end to end — the row request always carries
`offset`, `limit` and `sortBy` and never fetches more than one page.

## Run it

```sh
npm install
cp .env.example .env.local   # then edit if needed
npm run dev                  # http://localhost:3000
```

## Environment variables

| Variable       | Side          | Meaning                                  |
| -------------- | ------------- | ---------------------------------------- |
| `QWBE_API_URL` | server only   | Base URL of the qwbe API, e.g. `http://localhost:4500`. No `NEXT_PUBLIC_` prefix on purpose. |

## Tests and checks

```sh
npm test        # unit tests: cookie, login, proxy logic and the metadata-driven list logic (node --test)
npm run lint
npm run typecheck
npm run e2e     # end-to-end scenarios through the Orca browser (see below)
```

## End-to-end scenarios through the Orca browser (QWB-51)

`npm run e2e` runs one command end to end (`e2e/run-e2e.mjs`):

1. Copies the merged qwbe platform from its repository with `git archive origin/main` into
   `/tmp/qwbe-e2e` (the qwbe checkout itself is never touched) and installs the crm-pack
   cubes under `core/plugins/crm-pack` the way `plugins/crm-pack/probes/crm.mjs` does.
2. Starts qwbe and this frontend on free ports (never 4500/4510), each with `nohup` from
   inside the runner, records the PIDs, and polls both URLs before any browser step. If
   either server does not come up, the run stops with a clear message.
3. Seeds, through the qwbe API with a real login, two organizations and two contacts (one
   linked through `accountId`). The seed is idempotent and its teardown deletes exactly the
   rows it created; all names are obviously fake.
4. Drives the real UI through the Orca browser (`orca` CLI): login, the organization list
   with sorting and searching, an inline edit on an editable field, the refused inline edit
   on a non-editable field, organization -> contact -> back, and logout. Every scenario
   leaves at least one screenshot and a PASS/RED/SKIP line.
5. Tears down: seed rows deleted, servers killed by PID, work directory removed. Exits
   non-zero if any scenario is not PASS.

Results (screenshots plus `results.md`) land in
`/home/lucian/Projects/wiki/aplicatii/qwbe/crm-pack/e2e/<YYYY-MM-DD>/`.

What it needs: the Orca app running locally with its runtime ready (`orca status --json`
must report `state: "ready"`), the `orca` CLI shim at
`/home/lucian/.config/orca/linux-orca-cli-shim/orca` (override with `ORCA_CLI`), and the
qwbe and crm-pack checkouts at their default paths (override with `QWBE_REPO` and
`CRM_PACK`). It runs only on the Orca host.

A refused login (no qwbe session) is not faked green: the login scenario is driven anyway
and recorded RED with screenshots, the session-bound scenarios are recorded SKIP, and the
runner exits non-zero.

The list tests stub qwbe entirely: they prove that columns are derived from metadata
(a field added to the stub appears without touching any component), that non-editable
fields refuse editing, that a refused PATCH leaves the old value and carries qwbe's
own message for the edited field back to the cell, that relation links resolve to the
right href (and yield no link for a target without a route), that sorting refuses a
non-sortable column, and that the list request carries the page, sort and filter
parameters without letting a filter key override paging.
