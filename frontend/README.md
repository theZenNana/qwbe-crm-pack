# crm-pack frontend (QWB-48)

Next.js (App Router) + TypeScript + Tailwind app for the CRM pack. All UI
components come from [shadcn/ui](https://ui.shadcn.com) — copied exactly as the
shadcn CLI generated them, never restyled.

## Authentication model

Follows `qwbe/docs/external-frontend-auth.md`: the qwbe token never reaches the
browser. It lives in an httpOnly cookie set by the Next.js server, and every
call to qwbe goes through a Next.js route handler acting as a server-side proxy
(`src/app/api/qwbe/[...path]/route.ts`).

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
npm test        # unit tests on cookie, login and proxy logic (node --test)
npm run lint
npm run typecheck
```
