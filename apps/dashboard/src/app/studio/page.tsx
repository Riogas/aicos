import { StudioClient } from "./client";
import "./studio.css";

export const dynamic = "force-dynamic";

export const metadata = { title: "AICOS · Strategy Room" };

export default function StudioPage() {
  return <StudioClient />;
}
