import type { PresetRow } from "../../core/models";
import { Indicator } from "./ui/Indicator";
import { Status } from "./ui/Status";

/** The preset's release state, and beside it the build of a newer revision when only older releases are published. */
export function BuildState({ row }: Readonly<{ row: Pick<PresetRow, "status" | "revision"> }>) {
  return (
    <span className="c-releases-build">
      <Status status={row.status} />
      {row.revision && <Indicator status={row.revision} />}
    </span>
  );
}
