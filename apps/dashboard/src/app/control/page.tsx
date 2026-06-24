import { ControlClient } from "./client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Matrix · Control" };

export default function ControlPage() {
  return <ControlClient />;
}
