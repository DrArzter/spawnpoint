import { Button } from "../../components/ui/Button";
import { ChoiceChip } from "../../components/ui/Chip";
import { Status } from "../../components/ui/Status";
import { Timestamp } from "../../components/ui/Timestamp";
import type { ConsoleModel } from "../../core/models";
import { Icon } from "../../icons";

// The console commits to the terminal grammar: who typed what, and what the
// game answered (ADR-0063). Every line is a recorded command, so nothing here
// is decoration standing in for a session.
export function Rcon({ model }: Readonly<{ model: ConsoleModel }>) {
  const { game, world, session, log, unavailable } = model;
  return (
    <div className="page">
      <h1 className="visually-hidden">Console</h1>
      {model.targets.length > 1 && (
        <fieldset className="chip-row fieldset-plain">
          <legend className="visually-hidden">World</legend>
          {model.targets.map((target) => (
            <ChoiceChip data-action={target.choose.id} key={target.id} onClick={target.choose.run} pressed={target.current}>{target.name}</ChoiceChip>
          ))}
        </fieldset>
      )}
      <section aria-label="RCON terminal" className="terminal">
        <header className="terminal-bar">
          <Icon name="terminal" size={18} />
          <strong>{world ? world.displayName : `${game?.displayName ?? "Game"} session`}</strong>
          <Status className="terminal-status" kind={session.kind} label={session.label} />
        </header>
        <div aria-busy={log?.status === "loading" || undefined} aria-live="polite" className="terminal-output" role="log">
          {unavailable !== null && <span className="line line-muted">{unavailable}</span>}
          {log?.status === "loading" && <span className="line line-muted">Reading the console history</span>}
          {log?.status === "error" && (
            <span className="line line-amber">
              {log.error}{" "}
              <Button data-action={log.retry.id} onClick={log.retry.run} size="small" variant="text">{log.retry.label}</Button>
            </span>
          )}
          {log?.status === "ready" && log.value.length === 0 && (
            <span className="line line-muted">No commands yet. Each one is recorded with who ran it.</span>
          )}
          {log?.status === "ready" && log.value.map((line) => (
            <span className="console-entry" key={line.id}>
              <span className="line">
                <span className="prompt">{line.who}&gt;</span> {line.command}{" "}
                <Timestamp className="line-muted" value={line.at} />
              </span>
              {line.pending && <span className="line line-muted">{line.status.label}</span>}
              {!line.pending && line.output !== null && line.output !== "" && (
                <span className={line.status.kind === "ok" ? "line" : "line line-amber"}>{line.output}</span>
              )}
              {!line.pending && line.status.kind !== "ok" && !line.output && <span className="line line-amber">{line.status.label}</span>}
            </span>
          ))}
        </div>
        <form className="terminal-input" onSubmit={(event) => { event.preventDefault(); if (!model.run.disabled) model.run.run(); }}>
          <span aria-hidden="true" className="prompt">rcon&gt;</span>
          <input
            aria-label="RCON command"
            autoComplete="off"
            disabled={unavailable !== null}
            maxLength={256}
            onChange={(event) => model.setDraft(event.target.value)}
            placeholder={unavailable === null ? "Type a command" : "Console unavailable"}
            spellCheck={false}
            value={model.draft}
          />
          <Button data-action={model.run.id} disabled={model.run.disabled} icon="keyboard_return" loading={model.run.busy} size="small" title={model.run.hint} type="submit" variant="text">{model.run.label}</Button>
        </form>
      </section>
      <fieldset className="quick-commands fieldset-plain">
        <legend className="visually-hidden">Quick commands</legend>
        {model.quickCommands.map((command) => (
          <Button data-action={command.id} disabled={command.disabled} key={command.label} onClick={command.run} size="small" title={command.hint} variant="outlined"><code>{command.label}</code></Button>
        ))}
      </fieldset>
    </div>
  );
}
