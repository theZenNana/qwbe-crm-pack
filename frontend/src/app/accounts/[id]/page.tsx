// One organization, assembled from metadata, with its contacts derived by
// filtering the contacts cube on accountId (QWB-49). No related-list endpoint
// exists by design; the pinned filter IS the derived list.
import { CubeDetail } from "@/components/cube-detail"

export default function AccountDetailPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-4 p-4">
      <Detail id={params} />
    </main>
  )
}

async function Detail({ id }: { id: Promise<{ id: string }> }) {
  const { id: resolved } = await id
  return <CubeDetail cube="crm/accounts" id={resolved} childLists={[{ cube: "crm/contacts", field: "accountId", label: "Contacts" }]} />
}
