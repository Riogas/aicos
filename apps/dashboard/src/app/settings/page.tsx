import { SettingsClient } from "./client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Matrix · Ajustes" };

export default function SettingsPage() {
  return <SettingsClient />;
}
