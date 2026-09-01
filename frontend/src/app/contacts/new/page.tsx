// The contact create form. Same generic component and cube metadata as the
// organization one; organizationId renders as the typeahead picker over the
// organizations cube (the relation declared in the contact manifest).
import { CubeCreateForm } from "@/components/cube-create-form"

export default function NewContactPage() {
  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-4 p-4">
      <h1 className="text-xl font-semibold">New contact</h1>
      {/* externalId stays off the form (QWB-54 review 2, finding 7): it is
          the import tool's identity, and its unique index turns a hand-typed
          duplicate into a 500, not a form refusal. */}
      <CubeCreateForm
        cube="crm/contacts"
        fields={["name", "email", "phone", "company", "organizationId"]}
      />
    </main>
  )
}
