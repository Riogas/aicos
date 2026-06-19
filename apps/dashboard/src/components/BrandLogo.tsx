"use client";

import { useState } from "react";

/**
 * Logo de marca. Usa `/aicos-logo.png` (o .svg) si el archivo existe en
 * `public/`; si no, cae al monograma SVG por defecto. Así el operador puede
 * "ponerlo en el sitio" solo dejando el archivo en
 * `apps/dashboard/public/aicos-logo.png` — sin tocar código.
 */
export function BrandLogo() {
  const [failed, setFailed] = useState(false);
  if (!failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src="/aicos-logo.png"
        alt="AICOS"
        className="h-7 w-7 rounded-md object-contain"
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <div className="relative grid h-6 w-6 place-items-center overflow-hidden rounded-md bg-gradient-to-br from-accent to-violet shadow-glow">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className="text-white">
        <path d="M6 19V5h4l4 14h4M9 12h6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}
