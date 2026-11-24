import type { SnackInput } from "../components/ui/Snackbar";

/** How an outcome reaches the person, whatever the skin draws it as. */
export type Notify = (input: SnackInput) => void;
