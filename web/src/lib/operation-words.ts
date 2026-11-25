import { t } from "../i18n";

/** A requested change of a world, as the API and the console name it. */
export type OperationKind = "start" | "stop" | "wipe" | "regenerate" | "archive" | "restore" | "purge";

/** The change as a noun, for messages about its request: "start", "new wipe". */
export function operationNoun(kind: OperationKind): string {
  switch (kind) {
    case "start": return t("operation.nounStart");
    case "stop": return t("operation.nounStop");
    case "wipe":
    case "regenerate": return t("operation.nounWipe");
    case "archive": return t("operation.nounArchive");
    case "restore": return t("operation.nounRestore");
    default: return t("operation.nounPurge");
  }
}
