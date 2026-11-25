import type { AssistantPanelModel, WorldLogModel } from "../../core/models";
import { Choice, Choices, Empty, Field, LoadError, Log, Panel, Skeleton, SkeletonGroup, TextInput, Verb } from "./ui";
import { t } from "../../i18n";

// A world's recent log, read on demand, and the Owner's assistant under it
// (ADR-0094). Addresses and player names arrive already replaced by tokens.
export function LogPanel({ model }: Readonly<{ model: WorldLogModel }>) {
  const log = model.log;
  const label = t("log.worldDisplayNameGameLog", { worldDisplayName: model.world.displayName });
  return <>
    <Panel name={t("common.log")} verbs={<Verb action={model.read} size="small" />}>
      {log === null && <Empty title={t("log.noLogRead")} />}
      {log?.status === "loading" && <Log label={label} live rows={[]} tall />}
      {log?.status === "error" && <LoadError state={log} title={t("log.logCouldNotRead")} verb={t("log.readLog2")} />}
      {log?.status === "ready" && (log.value.rows.length === 0 ? <Empty title={t("log.logEmpty")} /> : <Log label={label} rows={log.value.rows} tall />)}
    </Panel>
    {model.assistant && <Assistant model={model.assistant} />}
  </>;
}

function Assistant({ model }: Readonly<{ model: AssistantPanelModel }>) {
  const answer = model.answer;
  return (
    <Panel name={t("common.assistant")}>
      <Choices label={t("common.model")}>
        {model.choices.map((choice) => <Choice key={choice.value} onClick={() => model.setModel(choice.value)} pressed={model.model === choice.value} title={choice.hint}>{choice.label}</Choice>)}
      </Choices>
      <form className="t-entry-form" onSubmit={(event) => { event.preventDefault(); if (!model.ask.disabled && !model.ask.busy) model.ask.run(); }}>
        <Field label={t("log.question")}>
          <TextInput autoComplete="off" maxLength={500} onChange={(event) => model.setQuestion(event.target.value)} placeholder={t("log.optional")} value={model.question} />
        </Field>
        <Verb action={model.ask} className="t-entry-verb" tone="primary" tooltipWhenDisabled type="submit" />
      </form>
      {answer?.status === "loading" && <SkeletonGroup className="t-assistant-answer" label={t("log.waitingAnswer")}><Skeleton width="long" /><Skeleton width="medium" /><Skeleton width="long" /></SkeletonGroup>}
      {answer?.status === "error" && <LoadError state={answer} title={t("common.noAnswer")} verb={t("log.askAssistant")} />}
      {answer?.status === "ready" && <div aria-live="polite" className="t-assistant-answer">{answer.value.text}</div>}
    </Panel>
  );
}
