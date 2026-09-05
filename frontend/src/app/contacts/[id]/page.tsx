// One contact, the kit-based pilot (QWB-54). The page supplies only the
// contact's field grouping; the frame, card, field display, relation links and
// title come from the reusable kit renderer, assembled from the cube's
// published metadata. The organization shows as a link resolved through the
// relation metadata on organizationId, exactly as the generic detail did.
import { CubeKitShow } from "@/components/kit/cube-show"
import { KitContext } from "@/components/kit/kit-context"
import type { FieldGroup } from "@/lib/kit-form"

// The contact's sections. Names the metadata does not publish as editable are
// dropped, and the custom group renders every runtime-defined field.
const CONTACT_GROUPS: FieldGroup[] = [
  { title: "Identity", fields: ["name", "email", "phone"] },
  { title: "Organization", fields: ["organizationId"] },
  { title: "Details", fields: ["company"] },
  { title: "Custom fields", custom: true },
]

export default function ContactDetailPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-4 p-4">
      <Detail id={params} />
    </main>
  )
}

async function Detail({ id }: { id: Promise<{ id: string }> }) {
  const { id: resolved } = await id
  return (
    <KitContext>
      <CubeKitShow cube="crm/contacts" id={resolved} fieldGroups={CONTACT_GROUPS} />
    </KitContext>
  )
}
