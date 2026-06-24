import { PlaybooksClient } from "./client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Matrix · Playbooks" };

export default function PlaybooksPage() {
  return <PlaybooksClient />;
}
