import { StudioClient } from "./client";
import "./studio.css";

export const dynamic = "force-dynamic";

export const metadata = { title: "Matrix · Strategy Room" };

export default function StudioPage() {
  return <StudioClient />;
}
