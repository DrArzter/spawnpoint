import { Timestamp } from "../../components/ui/Timestamp";
import type { ConsoleModel } from "../../core/models";
import { Choice, Choices, Page, Skeleton, SkeletonGroup, State, Verb, Verbs } from "./ui";

// The console page is the one place the two faces agree on: a terminal. Here
// it is the whole screen's own grammar continued: the world in its head, who
// typed what and what the game answered, the prompt, the quick commands as
// keys (ADR-0063).
export function Rcon({ model }: Readonly<{ model: ConsoleModel }>) {
  const { game, world, session, log, unavailable } = model;
  return (
    <Page>
      <h1 className="visually-hidden">Console</h1>
      {model.targets.length > 1 && (
        <Choices label="World">
          {model.targets.map((target) => (
            <Choice data-action={target.choose.id} key={target.id} onClick={target.choose.run} pressed={target.current}>{target.name}</Choice>
          ))}
        </Choices>
      )}
      <section aria-label="RCON terminal" className="t-rcon">
        <header className="t-rcon-head">
          <strong>{world ? world.displayName : `${game?.displayName ?? "Game"} session`}</strong>
          <State kind={session.kind} label={session.label} />
        </header>
        <div aria-live="polite" className="t-rcon-log" role="log">
          {unavailable !== null && <span className="t-rcon-line t-rcon-muted">{unavailable}</span>}
          {log?.status === "loading" && (
            <SkeletonGroup label="Reading the console history">
              <Skeleton width="long" />
              <Skeleton width="medium" />
            </SkeletonGroup>
          )}
          {log?.status === "error" && (
            <span className="t-rcon-line t-rcon-amber">{log.error} <Verb action={log.retry} size="small" /></span>
          )}
          {log?.status === "ready" && log.value.length === 0 && (
            <span className="t-rcon-line t-rcon-muted">No commands yet. Each one is recorded with who ran it.</span>
          )}
          {log?.status === "ready" && log.value.map((line) => (
            <span className="t-rcon-entry" key={line.id}>
              <span className="t-rcon-line">
                <span className="t-rcon-prompt">{line.who}&gt;</span> {line.command}{" "}
                <Timestamp className="t-rcon-muted" value={line.at} />
              </span>
              {line.pending && <span className="t-rcon-line t-rcon-muted">{line.status.label}</span>}
              {!line.pending && line.output !== null && line.output !== "" && (
                <span className={line.status.kind === "ok" ? "t-rcon-line" : "t-rcon-line t-rcon-amber"}>{line.output}</span>
              )}
              {!line.pending && line.status.kind !== "ok" && !line.output && <span className="t-rcon-line t-rcon-amber">{line.status.label}</span>}
            </span>
          ))}
        </div>
        <form className="t-rcon-input" onSubmit={(event) => { event.preventDefault(); if (!model.run.disabled) model.run.run(); }}>
          <span aria-hidden="true" className="t-rcon-prompt">rcon&gt;</span>
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
          <Verb action={model.run} size="small" type="submit" />
        </form>
      </section>
      <Verbs>
        {model.quickCommands.map((command) => <Verb action={command} key={command.label} size="small" />)}
      </Verbs>
    </Page>
  );
}
