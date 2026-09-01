// The contacts list. Same generic component, different cube name (QWB-49);
// the searchable organizationId relation becomes the organization filter.
import { CubeList } from "@/components/cube-list"

export default function ContactsPage() {
  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-4 p-4">
      <h1 className="text-xl font-semibold">Contacts</h1>
      <CubeList cube="crm/contacts" createHref="/contacts/new" addLabel="Add contact" />
    </main>
  )
}
