// One organization, assembled from metadata, with its contacts derived by
// filtering the contacts cube on organizationId. No related-list endpoint
// exists by design; the pinned filter IS the derived list.
//
// The Organizations pilot (QWB-53): the shadcn-admin-kit edit island
// (components/cube-admin-edit.tsx) renders the fields grouped the way the
// users read an organization in the source system (identity, how to reach
// it, billing address, notes) and every editable field as a kit input in
// one form. Names only: labels, types, required flags and editability keep
// coming from the cube metadata, a name removed on the backend is skipped,
// and a field this list does not name (or a custom field defined at
// runtime) still shows, in its own section.
import Link from "next/link"

import { CubeAdminEdit } from "@/components/cube-admin-edit"
import { CubeList } from "@/components/cube-list"
import { SchemaApiPanel } from "@/components/schema-api-panel"
import { type FieldGroupSpec, routeOf } from "@/lib/cube"

const ORGANIZATION_GROUPS: FieldGroupSpec[] = [
  {
    legend: "Organization",
    fields: ["name", "organizationNo", "organizationType", "industry", "rating", "ownership", "employees"],
  },
  { legend: "Contact details", fields: ["phone", "email", "website", "emailOptOut"] },
  { legend: "Billing address", fields: ["billingStreet", "billingCity", "billingCode", "billingCountry"] },
  { legend: "Notes", fields: ["description"] },
  { legend: "Source system", fields: ["externalId"] },
]

export default function OrganizationDetailPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-4 p-4">
      <Detail id={params} />
    </main>
  )
}

async function Detail({ id }: { id: Promise<{ id: string }> }) {
  const { id: resolved } = await id
  return (
    <div className="flex flex-col gap-6">
      <CubeAdminEdit cube="crm/organizations" id={resolved} groups={ORGANIZATION_GROUPS} />
      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Contacts</h2>
        <CubeList cube="crm/contacts" fixedFilters={{ organizationId: resolved }} />
        <Link className="text-sm underline" href={routeOf("crm/contacts")}>
          All rows
        </Link>
      </section>
      <SchemaApiPanel cube="crm/organizations" id={resolved} />
    </div>
  )
}
