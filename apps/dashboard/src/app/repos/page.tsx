import { ReposClient } from "./client";

export const dynamic = "force-dynamic";
export const metadata = { title: "AICOS · Repos" };

export default function ReposPage() {
  return <ReposClient />;
}
