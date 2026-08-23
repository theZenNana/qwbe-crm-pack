import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform"
import { Effect, Schema } from "effect"
import { Authorization, requirePermission } from "qwbe-core/auth"
import { type CubeTools, defineCube } from "qwbe-core/cube"
import { Forbidden } from "qwbe-core/errors"

const ChildInfo = Schema.Struct({
  name: Schema.String,
  entity: Schema.NullOr(Schema.String),
  enabled: Schema.Boolean,
})

const group = HttpApiGroup.make("crm")
  .add(HttpApiEndpoint.get("children")`/crm`.addSuccess(Schema.Array(ChildInfo)).addError(Forbidden))
  .middleware(Authorization)

export const cube = defineCube(group, {
  manifest: {
    name: "crm",
    tables: [],
    screen: true,
    requiresAuth: true,
    permissions: [{ name: "crm:read", roles: ["admin", "reader"] }],
  },

  create: ({ catalogue }: CubeTools) => ({
    commands: [
      {
        name: "crm:children",
        summary: "the mounted CRM modules",
        permission: "crm:read",
        run: () =>
          Effect.succeed(
            catalogue()
              .filter((entry) => entry.parent === "crm")
              .map((entry) => `${entry.name} (${entry.enabled ? "on" : "off"})`)
              .join("\n") || "(none)",
          ),
      },
    ],

    handlers: {
      children: () =>
        Effect.gen(function* () {
          yield* requirePermission("crm:read")
          return catalogue()
            .filter((entry) => entry.parent === "crm")
            .map((entry) => ({ name: entry.name, entity: entry.entity ?? null, enabled: entry.enabled }))
        }),
    },
  }),
})
