// Contact edit, the kit-based pilot (QWB-54). Same contract as the detail
// pilot: the page supplies the field grouping, the reusable kit renderer does
// the rest with shadcn-admin-kit form components. The organization picker
// searches the organizations cube through the same `q` filter the typeahead
// uses; the httpOnly-cookie proxy carries every call.
import { CubeKitEditForm } from "@/components/kit/cube-edit-form"
import { KitContext } from "@/components/kit/kit-context"
import type { FieldGroup } from "@/lib/kit-form"

const CONTACT_GROUPS: FieldGroup[] = [
  { title: "Identity", fields: ["name", "email", "phone"] },
  { title: "Organization", fields: ["organizationId"] },
  { title: "Details", fields: ["company"] },
  { title: "Custom fields", custom: true },
]

export default function EditContactPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-4 p-4">
      <Edit id={params} />
    </main>
  )
}

async function Edit({ id }: { id: Promise<{ id: string }> }) {
  const { id: resolved } = await id
  return (
    <KitContext>
      <CubeKitEditForm cube="crm/contacts" id={resolved} fieldGroups={CONTACT_GROUPS} />
    </KitContext>
  )
}
