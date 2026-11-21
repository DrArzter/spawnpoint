import type { FormEvent } from "react";

import type { ConsoleModel } from "../../../core/models";
import { ActionButton } from "../ui/ActionButton";
import { Card } from "../ui/Card";
import { Empty, LoadError } from "../ui/Empty";
import { TextInput } from "../ui/Fields";
import { SkeletonRows } from "../ui/Skeleton";
import { Terminal } from "../ui/Terminal";

/** The world's console: its command log, the quick commands at the card head, and one command line. */
export function ConsoleTab({ model, world }: Readonly<{ model: ConsoleModel; world: string }>) {
  const log = model.log;
  const run = (event: FormEvent) => {
    event.preventDefault();
    if (!model.run.disabled && !model.run.busy) model.run.run();
  };
  const quick = model.quickCommands.map((item, index) => <ActionButton action={item} className="c-mono" key={`${item.id}:${item.label}:${index}`} size="sm" />);
  return (
    <Card actions={quick.length > 0 ? <span className="c-console-quick">{quick}</span> : undefined} body="flush" count={log?.status === "ready" ? log.value.length : undefined} title="Command log">
      {log === null && <Empty icon="terminal" title="World is offline" />}
      {log?.status === "loading" && <SkeletonRows columns={5} rows={6} />}
      {log?.status === "error" && <LoadError error={log.error} kind={log.kind} retry={log.retry} title="Console could not be loaded" verb="read the console" />}
      {log?.status === "ready" && (log.value.length === 0 ? <Empty icon="terminal" title="No commands" /> : <Terminal label={`${world} console`} lines={log.value} />)}
      <form className="c-console-line" onSubmit={run}>
        <TextInput
          aria-disabled={model.unavailable ? true : undefined}
          aria-label="Command"
          autoComplete="off"
          data-tip={model.unavailable ?? undefined}
          mono
          onChange={(event) => model.setDraft(event.target.value)}
          placeholder="Command"
          readOnly={model.unavailable !== null}
          value={model.draft}
        />
        <ActionButton action={model.run} />
      </form>
    </Card>
  );
}
