import { DialogFrame } from "./Dialog";
import type { ComponentProps } from "react";

/**
 * A drawer at the end edge, full height (full screen on a phone): Cancel and Save stay in its sticky footer.
 * The person widens or narrows any drawer from its start edge; the width is kept for every drawer of the
 * same size, so a form keeps a form's width and a wide drawer (a whole file, a conversation) a wide one.
 */
export function SidePanel({ wide = false, ...props }: Omit<ComponentProps<typeof DialogFrame>, "kind" | "className" | "resize"> & Readonly<{ wide?: boolean }>) {
  return <DialogFrame className={wide ? "c-panel-wide" : undefined} kind="panel" resize={wide ? "wide" : "form"} {...props} />;
}
