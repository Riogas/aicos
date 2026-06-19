import { SchedulesClient } from "./client";

export const dynamic = "force-dynamic";
export const metadata = { title: "AICOS · Programadas" };

export default function SchedulesPage() {
  return <SchedulesClient />;
}
