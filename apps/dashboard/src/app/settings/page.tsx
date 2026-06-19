import { SettingsClient } from "./client";

export const dynamic = "force-dynamic";
export const metadata = { title: "AICOS · Ajustes" };

export default function SettingsPage() {
  return <SettingsClient />;
}
