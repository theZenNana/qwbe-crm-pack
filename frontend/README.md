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
```

The list tests stub qwbe entirely: they prove that columns are derived from metadata
(a field added to the stub appears without touching any component), that non-editable
fields refuse editing, that a PATCH failure surfaces the qwbe message in the cell,
that relation links resolve to the right href, and that the list request carries the
page, sort and filter parameters.
