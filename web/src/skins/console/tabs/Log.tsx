import type { WorldLogModel } from "../../../core/models";
import { ActionButton } from "../ui/ActionButton";
import { Card } from "../ui/Card";
import { Empty, LoadError } from "../ui/Empty";
import { HostLog } from "../ui/HostLog";
import { t } from "../../../i18n";

/** A world's recent log: the game's own once it runs, the host's lines of its start before that (ADR-0094). */
export function LogTab({ model }: Readonly<{ model: WorldLogModel }>) {
  const log = model.log;
  const game = model.source === "game";
  const label = t(game ? "log.worldDisplayNameGameLog" : "log.worldDisplayNameStartLog", { worldDisplayName: model.world.displayName });
  return (
    <Card actions={<ActionButton action={model.read} size="sm" />} body="flush" fill count={log?.status === "ready" ? log.value.rows.length : undefined} title={t(game ? "common.log" : "log.startLog")}>
      {log === null && <Empty icon="table_rows" size="sm" title={t(game ? "log.noLogRead" : "log.worldNotRunning")} />}
      {log?.status === "loading" && <HostLog label={label} live rows={[]} tall />}
      {log?.status === "error" && <LoadError error={log.error} kind={log.kind} retry={log.retry} size="sm" title={t("log.logCouldNotRead")} verb={t("log.readLog2")} />}
      {log?.status === "ready" && (log.value.rows.length === 0 ? <Empty icon="table_rows" size="sm" title={t("log.logEmpty")} /> : <HostLog label={label} rows={log.value.rows} tall />)}
    </Card>
  );
}
