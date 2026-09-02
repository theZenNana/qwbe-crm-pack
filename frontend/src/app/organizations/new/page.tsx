// The organization create form. The field list is the F1 basic set, in display
// order; labels, required flags and validation come from the cube metadata
// (QWB-49), so nothing here duplicates the schema.
import { CubeCreateForm } from "@/components/cube-create-form"

export default function NewOrganizationPage() {
  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-4 p-4">
      <h1 className="text-xl font-semibold">New organization</h1>
      {/* externalId stays off the form (QWB-54 review 2, finding 7): it is
          the import tool's identity, and its unique index turns a hand-typed
          duplicate into a 500, not a form refusal. */}
      <CubeCreateForm
        cube="crm/organizations"
        fields={["name", "industry", "phone", "email", "website"]}
      />
    </main>
  )
}
