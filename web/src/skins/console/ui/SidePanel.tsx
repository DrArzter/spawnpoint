import { DialogFrame } from "./Dialog";
import type { ComponentProps } from "react";

/**
 * A form at the end edge, full height (full screen on a phone): Cancel and Save stay in its sticky footer.
 * A wide panel holds a whole file: it takes most of a wide screen.
 */
export function SidePanel({ wide = false, ...props }: Omit<ComponentProps<typeof DialogFrame>, "kind" | "className"> & Readonly<{ wide?: boolean }>) {
  return <DialogFrame className={wide ? "c-panel-wide" : undefined} kind="panel" {...props} />;
}
