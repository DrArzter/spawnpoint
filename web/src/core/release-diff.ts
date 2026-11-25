import type { DiffClasses, DiffMod, DiffValue, ReleaseDiff } from "../api/contract";
import { formatBytes } from "../lib/format";
import type { ChangeRow } from "./models";
import { t } from "../i18n";

const CHANGE_ORDER = ["removed", "changed", "added"] as const;

function modDetail(mod: DiffMod): string | null {
  const parts = [mod.modIds && mod.modIds.length > 0 ? mod.modIds.join(", ") : null, mod.side ? t("releases.addonSide", { side: mod.side }) : null];
  return parts.filter((part) => part !== null).join(" · ") || null;
}

function modRows(part: string, section: DiffClasses<DiffMod>): Record<ChangeRow["change"], ChangeRow[]> {
  const row = (change: ChangeRow["change"], name: string, detail: string | null): ChangeRow => ({ id: `${change}:${part}:${name}`, change, part, name, detail });
  return {
    removed: section.removed.map((mod) => row("removed", mod.file, modDetail(mod))),
    changed: section.changed.map(({ from, to }) => row("changed", to.file, from.file === to.file ? modDetail(to) : t("releases.wasFile", { file: from.file }))),
    added: section.added.map((mod) => row("added", mod.file, modDetail(mod))),
  };
}

function valueRow<T>(part: string, value: DiffValue<T>, text: (item: T) => string): ChangeRow[] {
  if (!value.changed) return [];
  const show = (item: T | null) => (item === null ? "none" : text(item));
  return [{ id: `changed:${part}`, change: "changed", part, name: show(value.to), detail: t("releases.wasFile", { file: show(value.from) }) }];
}

/**
 * The diff as rows the owner reads before a promotion: losses first, then
 * changes, then additions; the release-wide values lead each group.
 */
export function releaseChangeRows(diff: ReleaseDiff): Readonly<{ rows: readonly ChangeRow[]; unchanged: number }> {
  const values = [
    ...valueRow(t("releases.gameVersion"), diff.gameVersion, (version) => version),
    ...valueRow(t("releases.loader"), diff.loader, (loader) => [loader.type, loader.version].filter(Boolean).join(" ")),
    ...valueRow(t("releases.runtimeImage"), diff.runtimeImage, (image) => image),
    ...valueRow(t("releases.clientPack"), diff.clientPack, (pack) => formatBytes(pack.bytes)),
  ];
  const groups = [
    modRows(t("releases.serverMod"), diff.serverMods),
    modRows(t("releases.clientMod"), diff.clientMods),
    // An override's path starts with its root, so the root needs no column of its own.
    ...diff.overrides.map((root) => modRows(t("releases.override"), {
      added: root.added.map((file) => ({ file: file.path, sha256: file.sha256, bytes: file.bytes, side: null, modIds: null })),
      removed: root.removed.map((file) => ({ file: file.path, sha256: file.sha256, bytes: file.bytes, side: null, modIds: null })),
      changed: root.changed.map(({ from, to }) => ({
        from: { file: from.path, sha256: from.sha256, bytes: from.bytes, side: null, modIds: null },
        to: { file: to.path, sha256: to.sha256, bytes: to.bytes, side: null, modIds: null },
      })),
      unchanged: root.unchanged,
    })),
  ];
  const rows = CHANGE_ORDER.flatMap((change) => [...values.filter((row) => row.change === change), ...groups.flatMap((group) => group[change])]);
  const unchanged = diff.serverMods.unchanged + diff.clientMods.unchanged + diff.overrides.reduce((sum, root) => sum + root.unchanged, 0);
  return { rows, unchanged };
}
