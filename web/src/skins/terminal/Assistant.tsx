import type { AssistantChatModel, ThreadEntry } from "../../core/models";
import { Choice, Choices, Drawer, Empty, Field, Indicator, LoadError, Skeleton, SkeletonGroup, State, TextArea, Verb } from "./ui";

// The Owner's assistant (ADR-0096), over any page: the conversations as a row
// of choices, the open one, and the message box. A proposal runs only when
// the Owner applies it.
export function AssistantDrawer({ model }: Readonly<{ model: AssistantChatModel }>) {
  const list = model.conversations;
  return (
    <Drawer
      cancel={model.close}
      cancelLabel={model.close.label}
      closeActionId={model.close.id}
      footer={<Verb action={model.send} tone="primary" tooltipWhenDisabled />}
      onClose={model.close.run}
      open
      title="Assistant"
      wide
    >
      <div className="t-assistant-list">
        <Verb action={model.startNew} size="small" />
        {list.status === "loading" && <SkeletonGroup label="Reading the conversations"><Skeleton width="medium" /></SkeletonGroup>}
        {list.status === "error" && <LoadError state={list} title="The conversations could not be loaded" verb="use the assistant" />}
        {list.status === "ready" && list.value.length > 0 && (
          <Choices label="Conversations">
            {list.value.map((row) => <Choice data-action={row.select.id} key={row.id} onClick={row.select.run} pressed={row.current} title={row.status.label}>{row.title}</Choice>)}
          </Choices>
        )}
      </div>
      {model.thread === null ? <Empty title="New conversation" /> : <Thread thread={model.thread} />}
      <Choices label="Model">
        {model.choices.map((choice) => <Choice key={choice.value} onClick={() => model.setModel(choice.value)} pressed={model.model === choice.value} title={choice.hint}>{choice.label}</Choice>)}
      </Choices>
      <Field hideLabel label="Message">
        <TextArea maxLength={4000} onChange={(event) => model.setDraft(event.target.value)} placeholder="Message" prose value={model.draft} />
      </Field>
    </Drawer>
  );
}

function Thread({ thread }: Readonly<{ thread: NonNullable<AssistantChatModel["thread"]> }>) {
  const entries = thread.entries;
  return (
    <div aria-live="polite" className="t-assistant-entries" role="log">
      {entries.status === "loading" && <SkeletonGroup label="Reading the conversation"><Skeleton width="long" /><Skeleton width="medium" /></SkeletonGroup>}
      {entries.status === "error" && <LoadError state={entries} title="The conversation could not be loaded" verb="use the assistant" />}
      {entries.status === "ready" && entries.value.map((entry) => <Entry entry={entry} key={entry.id} />)}
      {thread.working && <State kind={thread.status.kind} label={thread.status.label} />}
      {thread.note && <p>{thread.note}</p>}
    </div>
  );
}

function Entry({ entry }: Readonly<{ entry: ThreadEntry }>) {
  if (entry.kind === "owner" || entry.kind === "assistant") return <div className="t-assistant-message" data-from={entry.kind}>{entry.text}</div>;
  if (entry.kind === "read") return <span className="t-inline"><Indicator kind={entry.status.kind} label={entry.status.label} />{entry.title}</span>;
  return (
    <article className={entry.destructive ? "t-assistant-proposal t-assistant-destructive" : "t-assistant-proposal"}>
      <span className="t-inline"><strong>{entry.title}</strong><State kind={entry.status.kind} label={entry.status.label} /></span>
      <pre className="t-assistant-detail">{entry.detail}</pre>
      {entry.result && <pre className="t-assistant-detail">{entry.result}</pre>}
      {(entry.apply || entry.reject) && (
        <span className="t-inline">
          {entry.apply && <Verb action={entry.apply} size="small" />}
          {entry.reject && <Verb action={entry.reject} size="small" />}
        </span>
      )}
    </article>
  );
}
