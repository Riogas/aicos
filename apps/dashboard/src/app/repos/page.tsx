import { ReposClient } from "./client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Matrix · Repos" };

export default function ReposPage() {
  return <ReposClient />;
}
