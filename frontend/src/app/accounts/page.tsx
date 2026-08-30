// The organizations list. Nothing entity-specific here but the cube name:
// columns, sorting, search and paging all come from the cube metadata (QWB-49).
import { CubeList } from "@/components/cube-list"

export default function AccountsPage() {
  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-4 p-4">
      <h1 className="text-xl font-semibold">Organizations</h1>
      <CubeList cube="crm/accounts" />
    </main>
  )
}
