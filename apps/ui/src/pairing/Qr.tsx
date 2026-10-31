import type { ReactNode } from "react";
import { encode } from "uqr";

/**
 * A QR code of `text`, drawn as one SVG path from `uqr`'s modules: black on white in both themes, as scanners read best,
 * with the quiet border of 2 modules `encode` adds.
 */
export function Qr({ text, label }: { readonly text: string; readonly label: string }): ReactNode {
  const { data, size } = encode(text, { ecc: "M", border: 2 });
  let path = "";
  data.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) path += `M${x} ${y}h1v1h-1z`;
    });
  });
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      className="size-40 rounded-md bg-white p-1"
    >
      <path d={path} fill="#000" />
    </svg>
  );
}
