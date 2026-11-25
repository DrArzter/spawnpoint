import { t } from "../i18n";
import { action } from "./actions";
import type { Notice } from "./models";
import type { ControlPlaneSnapshot } from "../model";

/*
 * A persistent host no world is placed on (ADR-0100). Its worlds moved to the
 * fleet; its disks still cost money, so the worlds page offers to delete it.
 */

export type PersistentHost = Readonly<{ providerRef: string; name: string; stopped: boolean }>;

/** The persistent host, when one exists and no live world is placed on it. */
export function unusedPersistentHost(snapshot: ControlPlaneSnapshot | null): PersistentHost | null {
  if (snapshot === null) return null;
  const host = snapshot.hosts.find((item) => item.provenance !== "launched");
  if (host === undefined) return null;
  const placed = snapshot.games.some((game) => game.worlds.some((world) => world.placement === "configured" && world.materialization !== "archived"));
  if (placed) return null;
  return { providerRef: host.providerRef ?? host.id, name: host.name, stopped: host.state === "stopped" };
}

/** The notice that offers the deletion, for a role and a deployment that can make it. */
export function persistentHostNotice(
  snapshot: ControlPlaneSnapshot | null,
  allowed: boolean,
  onDelete: (host: Readonly<{ providerRef: string; name: string }>) => void,
): Notice | null {
  const host = allowed ? unusedPersistentHost(snapshot) : null;
  if (host === null) return null;
  return {
    id: "persistent-host-unused",
    tone: "info",
    title: t("host.unused", { hostName: host.name }),
    action: action("host.delete", t("host.delete"), () => onDelete(host), {
      icon: "delete_forever",
      disabled: !host.stopped,
      ...(host.stopped ? {} : { hint: t("error.host_not_stopped") }),
    }),
  };
}
