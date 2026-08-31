// The landing page is the organizations list: the identity page is a detail, not a home.
import { redirect } from "next/navigation"

export default function Home() {
  redirect("/organizations")
}
