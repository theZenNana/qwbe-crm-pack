// One contact, assembled from metadata. The organization shows as a link
// resolved through the relation metadata on organizationId.
import { CubeDetail } from "@/components/cube-detail"

export default function ContactDetailPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-4 p-4">
      <Detail id={params} />
    </main>
  )
}

async function Detail({ id }: { id: Promise<{ id: string }> }) {
  const { id: resolved } = await id
  return <CubeDetail cube="crm/contacts" id={resolved} />
}
