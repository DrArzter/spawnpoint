import type { AssistantPanelModel, WorldLogModel } from "../../core/models";
import { Choice, Choices, Empty, Field, LoadError, Log, Panel, Skeleton, SkeletonGroup, TextInput, Verb } from "./ui";

// A world's recent log, read on demand, and the Owner's assistant under it
// (ADR-0094). Addresses and player names arrive already replaced by tokens.
export function LogPanel({ model }: Readonly<{ model: WorldLogModel }>) {
  const log = model.log;
  const label = `${model.world.displayName}: game log`;
  return <>
    <Panel name="Log" verbs={<Verb action={model.read} size="small" />}>
      {log === null && <Empty title="No log read" />}
      {log?.status === "loading" && <Log label={label} live rows={[]} tall />}
      {log?.status === "error" && <LoadError state={log} title="The log could not be read" verb="read the log" />}
      {log?.status === "ready" && (log.value.rows.length === 0 ? <Empty title="The log is empty" /> : <Log label={label} rows={log.value.rows} tall />)}
    </Panel>
    {model.assistant && <Assistant model={model.assistant} />}
  </>;
}

function Assistant({ model }: Readonly<{ model: AssistantPanelModel }>) {
  const answer = model.answer;
  return (
    <Panel name="Assistant">
      <Choices label="Model">
        {model.choices.map((choice) => <Choice key={choice.value} onClick={() => model.setModel(choice.value)} pressed={model.model === choice.value} title={choice.hint}>{choice.label}</Choice>)}
      </Choices>
      <form className="t-entry-form" onSubmit={(event) => { event.preventDefault(); if (!model.ask.disabled && !model.ask.busy) model.ask.run(); }}>
        <Field label="Question">
          <TextInput autoComplete="off" maxLength={500} onChange={(event) => model.setQuestion(event.target.value)} placeholder="Optional" value={model.question} />
        </Field>
        <Verb action={model.ask} className="t-entry-verb" tone="primary" tooltipWhenDisabled type="submit" />
      </form>
      {answer?.status === "loading" && <SkeletonGroup className="t-assistant-answer" label="Waiting for the answer"><Skeleton width="long" /><Skeleton width="medium" /><Skeleton width="long" /></SkeletonGroup>}
      {answer?.status === "error" && <LoadError state={answer} title="No answer" verb="ask the assistant" />}
      {answer?.status === "ready" && <div aria-live="polite" className="t-assistant-answer">{answer.value.text}</div>}
    </Panel>
  );
}
