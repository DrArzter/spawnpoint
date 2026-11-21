import { DialogFrame } from "./Dialog";
import type { ComponentProps } from "react";

/** A form at the end edge, full height (full screen on a phone): Cancel and Save stay in its sticky footer. */
export function SidePanel(props: Omit<ComponentProps<typeof DialogFrame>, "kind" | "className">) {
  return <DialogFrame kind="panel" {...props} />;
}
