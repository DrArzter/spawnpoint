import { formatBytes } from "../lib/format";
import { t } from "../i18n";
import type { BackupsModel, Detail, Loading } from "./models";

/**
 * The newest backup of a world, as the Details tab tells it: when, how large,
 * of which wipe, and how many there are. Empty when the world has none yet;
 * null when the role may not read backups.
 */
export function backupOverview(backups: BackupsModel): Loading<readonly Detail[]> | null {
  if (!backups.canRead) return null;
  const inventory = backups.inventory;
  if (inventory.status !== "ready") return inventory;
  const entries = inventory.value.entries;
  const newest = entries.reduce<(typeof entries)[number] | null>((best, entry) => (best === null || entry.storedAt > best.storedAt ? entry : best), null);
  if (newest === null) return { status: "ready", value: [] };
  const wipe = backups.wipeNumber(newest.generationId);
  return {
    status: "ready",
    value: [
      { label: t("world.stored"), value: { type: "time", at: newest.storedAt } },
      { label: t("common.size"), value: { type: "text", text: formatBytes(newest.sizeBytes) } },
      { label: t("common.wipe"), value: wipe === undefined ? { type: "absent", text: "—" } : { type: "text", text: `#${wipe}` } },
      { label: t("common.backups"), value: { type: "number", value: entries.length } },
    ],
  };
}
