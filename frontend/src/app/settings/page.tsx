// The Settings area: runtime custom fields are managed here, per
// entity, never on the lists. The cube selector addresses every cube this pack
// serves -- organizations, contacts and contracts -- whether or not the app has
// a list route for it, because definitions ride the customfields API, not the
// cube's own frontend.
//
// Middleware already guards the route with the session cookie; the panel
// additionally requires the customfields:write permission and says so.

"use client"

import { useState } from "react"

import { CustomFieldsPanel } from "@/components/custom-fields-panel"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

// The cubes the selector offers, with the names the customfields API knows
// them by (the full cube name, the same value seed-demo.mjs and the vtiger
// import address definitions with).
const CUBES = [
  { value: "crm/organizations", label: "Organizations" },
  { value: "crm/contacts", label: "Contacts" },
  { value: "crm/contracts", label: "Contracts" },
]

export default function SettingsPage() {
  const [cube, setCube] = useState(CUBES[0].value)
  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-4 p-4">
      <h1 className="text-xl font-semibold">Settings</h1>
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">Entity</span>
        <Select value={cube} onValueChange={setCube}>
          <SelectTrigger className="w-48" aria-label="Entity">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CUBES.map((c) => (
              <SelectItem key={c.value} value={c.value}>
                {c.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <CustomFieldsPanel cube={cube} />
    </main>
  )
}
