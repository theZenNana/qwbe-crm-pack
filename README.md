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
| **Organization** | The company a business deals with — the vtiger Accounts module, rebuilt (QWB-47). Owned by the `crm/accounts` cube. |
| **Contract** | A deal signed with a party. Owned by the `crm/contracts` cube. |
| **party** | The other side of a contract, by id only (`Contract.partyId`, nullable). The cube that holds the party is NOT named: no import, no copied field, no join. |
| **company** | Free text on a contact (`Contact.company`, nullable string). Kept even now that Organization exists: it is historical data, not a reference. |

## The relation to the Organization (decided QWB-47, replacing the old limit)

The original restore had **no Account entity** on purpose. That limit was lifted by decision
(QWB-47): vtiger's Organizations — the object the users worked in all day, about 60 thousand
rows — are now the `crm/accounts` cube, entity `Organization`.

The relation has ONE truth: **`Contact.accountId`**.

- It lives on the contact. Nullable, opaque, set by the caller at create time.
- An organization's contacts are DERIVED: the contacts list takes an `accountId` filter
  (`GET /contacts?accountId=...`). There is no related-list endpoint and no contactIds field.
- Neither cube imports the other, and neither names the other in its manifest. The id is
  checked for shape at the schema edge; resolving it to a name is the job of whoever displays
  it (a space, a frontend, the entity summary mechanism).
- The `crm/accounts` fields are a photograph of the vtiger standard Accounts fields that
  actually carry data — not a one-to-one copy. Left out: what is empty or vtiger-internal
  (`notify_owner`, `parentid` — Account-to-Account hierarchy is out of scope), the custom
  fields (`cf_*` — a separate system, not this pack), and `annualrevenue` (a bare integer with
  no currency; money comes back only in minor units with a currency, as in contracts).

What stayed deliberate from the old limit: `Contact.company` is still text and references
nothing, and `Contract.partyId` is still opaque. History is data, not a foreign key.

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
qwbe-package.json            package manifest — CRM parent and three children
cubes/crm/index.ts           hierarchy parent and `/crm` child catalogue
cubes/crm/accounts/index.ts  Organization: table, API, schemas, permissions, commands
cubes/crm/contacts/index.ts  Contact: table, API, schemas, permissions, commands
cubes/crm/contracts/index.ts Contract: table, API, schemas, permissions, commands
cubes/crm/*/index.test.ts    source-local contract tests
probes/crm.mjs           runtime proof against a live kernel (scratch QWBE_DATA_DIR)
```

The cubes do not import each other. All use only exported `qwbe-core/*` package subpaths.

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
