import type { FormEvent } from "react";

import type { AssistantPanelModel, WorldLogModel } from "../../../core/models";
import { ActionButton } from "../ui/ActionButton";
import { Card } from "../ui/Card";
import { Empty, LoadError } from "../ui/Empty";
import { TextInput } from "../ui/Fields";
import { Grid } from "../ui/Grid";
import { HostLog } from "../ui/HostLog";
import { Segmented } from "../ui/Segmented";
import { Skeleton, SkeletonGroup } from "../ui/Skeleton";

/** A world's recent log, read on demand, and the Owner's assistant under it (ADR-0094). */
export function LogTab({ model }: Readonly<{ model: WorldLogModel }>) {
  const log = model.log;
  const label = `${model.world.displayName}: game log`;
  return (
    <Grid kind="stack">
      <Card actions={<ActionButton action={model.read} size="sm" />} body="flush" count={log?.status === "ready" ? log.value.rows.length : undefined} title="Log">
        {log === null && <Empty icon="table_rows" size="sm" title="No log read" />}
        {log?.status === "loading" && <HostLog label={label} live rows={[]} tall />}
        {log?.status === "error" && <LoadError error={log.error} kind={log.kind} retry={log.retry} size="sm" title="The log could not be read" verb="read the log" />}
        {log?.status === "ready" && (log.value.rows.length === 0 ? <Empty icon="table_rows" size="sm" title="The log is empty" /> : <HostLog label={label} rows={log.value.rows} tall />)}
      </Card>
      {model.assistant && <Assistant model={model.assistant} />}
    </Grid>
  );
}

function Assistant({ model }: Readonly<{ model: AssistantPanelModel }>) {
  const answer = model.answer;
  const ask = (event: FormEvent) => {
    event.preventDefault();
    if (!model.ask.disabled && !model.ask.busy) model.ask.run();
  };
  return (
    <Card title="Assistant">
      <form className="c-assistant-ask" onSubmit={ask}>
        <Segmented label="Model" onChange={model.setModel} options={model.choices.map((choice) => ({ value: choice.value, label: choice.label, hint: choice.hint }))} value={model.model} />
        <TextInput aria-label="Question" autoComplete="off" maxLength={500} onChange={(event) => model.setQuestion(event.target.value)} placeholder="Question (optional)" value={model.question} />
        <ActionButton action={model.ask} />
      </form>
      {answer?.status === "loading" && <SkeletonGroup className="c-assistant-answer" label="Waiting for the answer"><Skeleton text width="90%" /><Skeleton text width="70%" /><Skeleton text width="80%" /></SkeletonGroup>}
      {answer?.status === "error" && <LoadError error={answer.error} kind={answer.kind} retry={answer.retry} size="sm" title="No answer" verb="ask the assistant" />}
      {answer?.status === "ready" && <div aria-live="polite" className="c-assistant-answer">{answer.value.text}</div>}
    </Card>
  );
}
