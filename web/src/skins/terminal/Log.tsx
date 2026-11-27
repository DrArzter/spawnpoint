import type { WorldLogModel } from "../../core/models";
import { Empty, LoadError, Log, Panel, Verb } from "./ui";
import { t } from "../../i18n";

// A world's recent log: the game's own once it runs, the host's lines of its
// start before that (ADR-0094). Addresses and player names arrive replaced.
export function LogPanel({ model }: Readonly<{ model: WorldLogModel }>) {
  const log = model.log;
  const game = model.source === "game";
  const label = t(game ? "log.worldDisplayNameGameLog" : "log.worldDisplayNameStartLog", { worldDisplayName: model.world.displayName });
  return (
    <Panel name={t(game ? "common.log" : "log.startLog")} verbs={<Verb action={model.read} size="small" />}>
      {log === null && <Empty title={t(game ? "log.noLogRead" : "log.worldNotRunning")} />}
      {log?.status === "loading" && <Log label={label} live rows={[]} tall />}
      {log?.status === "error" && <LoadError state={log} title={t("log.logCouldNotRead")} verb={t("log.readLog2")} />}
      {log?.status === "ready" && (log.value.rows.length === 0 ? <Empty title={t("log.logEmpty")} /> : <Log label={label} rows={log.value.rows} tall />)}
    </Panel>
  );
}
