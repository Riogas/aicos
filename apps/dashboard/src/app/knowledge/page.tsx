import { KnowledgeClient } from "./client";

export const dynamic = "force-dynamic";
export const metadata = { title: "AICOS · Conocimiento" };

export default function KnowledgePage() {
  return <KnowledgeClient />;
}
