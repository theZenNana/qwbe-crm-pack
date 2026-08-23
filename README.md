# crm-pack — CRM rebuilt as an external plugin (QWB-30)

Rebuilt on 2026-08-12 from the verified historical copy (this directory before the rewrite —
SHA-256 recorded in `../MANIFEST.sha256` and in `qwbe/docs/crm-history-research.md`). Not a Git
history rewrite: the old files were the source material, adapted onto the current public cube
contract (`qwbe-core/cube`, `defineCube`). Installable via
`POST /settings/packages/install-from` pointing at this directory.

## Domain model — the decided vocabulary

| Term | Meaning here |
| --- | --- |
| **CRM** | Sidebar hierarchy and lifecycle parent. Owns no domain table. |
| **Contact** | A person the business deals with. Owned by the `crm/contacts` cube. |
| **Contract** | A deal signed with a party. Owned by the `crm/contracts` cube. |
| **party** | The other side of a contract, by id only (`Contract.partyId`, nullable). The cube that holds the party is NOT named: no import, no copied field, no join. |
| **company** | Free text on a contact (`Contact.company`, nullable string). |

## The explicit limit of the initial model

The historical CRM has **no Account entity**, and this rebuild keeps that limit on purpose:

- `Contact.company` stays text. It does not reference anything.
- `Contract.partyId` is an opaque, non-empty cross-entity identifier, nullable.
- Nothing from the historical ERP package (`accounts`, `erp-settings`, the richer ERP
  `contacts`) is folded in. That was a different package; see
  `qwbe/docs/crm-history-research.md`.

A first-class account/company entity is a design decision of its own — made later, or never.
It is not a side effect of a restore.

## The minimal relation (version one, stated and tested)

One direction only: a contract **holds** a party id. Nothing resolves it inside this plugin.
If `contacts` is absent or switched off, `contracts` starts and serves anyway, with ids that
resolve to nothing — and vice versa. Showing a contract next to its contact is declared one
level up, in a space, by a third party, so neither cube ever learns the other exists. The
runtime probes (`probes/crm.mjs`) boot the kernel with each cube alone to prove the
independence, and exercise the party id as data (set, nullable, opaque).

## Money

`Contract.amount` is an integer in **minor units** (bani, cents) — `Schema.Int` rejects
fractions at the boundary. Totals are rendered **per currency**, never summed across
currencies: `contracts:value` and the summary both follow that rule.

## Layout

```
qwbe-package.json            package manifest — CRM parent and two children
cubes/crm/index.ts           hierarchy parent and `/crm` child catalogue
cubes/crm/contacts/index.ts  Contact: table, API, schemas, permissions, commands
cubes/crm/contracts/index.ts Contract: table, API, schemas, permissions, commands
cubes/crm/*/index.test.ts    source-local contract tests
probes/crm.mjs           runtime proof against a live kernel (scratch QWBE_DATA_DIR)
```

The cubes do not import each other. Both use only exported `qwbe-core/*` package subpaths.

## Running the tests

Unit tests and typechecking run from this source directory. Runtime probes use a Qwbe checkout
and scratch data:

```sh
npm install --ignore-scripts
npm test
npm run typecheck

# runtime probe (starts its own server on a scratch data dir)
QWBE_REPO=<qwbe> node probes/crm.mjs
```
