import type { FormEvent } from "react";

import type { ConsoleModel } from "../../../core/models";
import { ActionButton } from "../ui/ActionButton";
import { Card } from "../ui/Card";
import { Empty, LoadError } from "../ui/Empty";
import { TextInput } from "../ui/Fields";
import { Terminal } from "../ui/Terminal";
import { t } from "../../../i18n";

/** The world's console: its command log, the quick commands at the card head, and one command line. */
export function ConsoleTab({ model, world }: Readonly<{ model: ConsoleModel; world: string }>) {
  const log = model.log;
  const run = (event: FormEvent) => {
    event.preventDefault();
    if (!model.run.disabled && !model.run.busy) model.run.run();
  };
  const quick = model.quickCommands.map((item, index) => <ActionButton action={item} className="c-mono" key={`${item.id}:${item.label}:${index}`} size="sm" />);
  return (
    <Card actions={quick.length > 0 ? <span className="c-console-quick">{quick}</span> : undefined} body="flush" count={log?.status === "ready" ? log.value.length : undefined} title={t("rcon.commandLog")}>
      {log === null && <Empty icon="terminal" title={t("rcon.worldOffline")} />}
      {log?.status === "loading" && <Terminal label={t("rcon.worldConsole", { world })} lines={[]} loading />}
      {log?.status === "error" && <LoadError error={log.error} kind={log.kind} retry={log.retry} title={t("rcon.consoleCouldNotLoaded")} verb={t("rcon.readConsole")} />}
      {log?.status === "ready" && (log.value.length === 0 ? <Empty icon="terminal" title={t("rcon.noCommands")} /> : <Terminal label={t("rcon.worldConsole", { world })} lines={log.value} />)}
      <form className="c-console-line" onSubmit={run}>
        <TextInput
          aria-disabled={model.unavailable ? true : undefined}
          aria-label={t("rcon.command")}
          autoComplete="off"
          data-tip={model.unavailable ?? undefined}
          mono
          onChange={(event) => model.setDraft(event.target.value)}
          placeholder={t("rcon.command")}
          readOnly={model.unavailable !== null}
          value={model.draft}
        />
        <ActionButton action={model.run} />
      </form>
    </Card>
  );
}
