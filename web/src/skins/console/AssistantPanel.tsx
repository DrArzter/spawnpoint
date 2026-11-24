import type { FormEvent } from "react";

import type { AssistantChatModel, ConversationRow, ThreadEntry } from "../../core/models";
import { ActionButton } from "./ui/ActionButton";
import { Ago } from "./ui/Ago";
import { Empty, LoadError } from "./ui/Empty";
import { TextArea } from "./ui/Fields";
import { Segmented } from "./ui/Segmented";
import { SidePanel } from "./ui/SidePanel";
import { Skeleton, SkeletonGroup } from "./ui/Skeleton";
import { Status } from "./ui/Status";
import { TrackList, TrackTitle, type Track } from "./ui/TrackList";

const tracks: readonly Track<ConversationRow>[] = [
  { id: "conversation", header: "Conversation", width: "minmax(0, 1fr)", kind: "stack", render: (row) => <TrackTitle action={row.select} current={row.current} line={<Ago at={row.updatedAt} />} title={row.title} /> },
  { id: "state", header: "State", width: "auto", kind: "end", quietHeader: true, render: (row) => <Status status={row.status} /> },
];

/** The Owner's assistant, over any page (ADR-0096): the conversations, the open one, and the message box. */
export function AssistantPanel({ model }: Readonly<{ model: AssistantChatModel }>) {
  const send = (event: FormEvent) => {
    event.preventDefault();
    if (!model.send.disabled && !model.send.busy) model.send.run();
  };
  const list = model.conversations;
  return (
    <SidePanel actions={<ActionButton action={model.send} variant="primary" />} cancel={model.close} title="Assistant" wide>
      <div className="c-assistant">
        <section aria-label="Conversations" className="c-assistant-list">
          <ActionButton action={model.startNew} size="sm" />
          {list.status === "error"
            ? <LoadError error={list.error} kind={list.kind} retry={list.retry} size="sm" title="Conversations could not be loaded" verb="use the assistant" />
            : <TrackList empty={<Empty icon="bolt" size="sm" title="No conversations" />} header={false} label="Conversations" loading={list.status === "loading"} rowKey={(row) => row.id} rows={list.status === "ready" ? list.value : []} tracks={tracks} />}
        </section>
        <section aria-label={model.thread?.title ?? "New conversation"} className="c-assistant-thread">
          {model.thread === null ? <Empty icon="bolt" size="sm" title="New conversation" /> : <Thread thread={model.thread} />}
          <form className="c-assistant-compose" onSubmit={send}>
            <Segmented label="Model" onChange={model.setModel} options={model.choices.map((choice) => ({ value: choice.value, label: choice.label, hint: choice.hint }))} value={model.model} />
            <TextArea aria-label="Message" maxLength={4000} onChange={(event) => model.setDraft(event.target.value)} placeholder="Message" prose rows={3} value={model.draft} />
          </form>
        </section>
      </div>
    </SidePanel>
  );
}

function Thread({ thread }: Readonly<{ thread: NonNullable<AssistantChatModel["thread"]> }>) {
  const entries = thread.entries;
  return (
    <div aria-live="polite" className="c-assistant-entries" role="log">
      {entries.status === "loading" && <SkeletonGroup label="Reading the conversation"><Skeleton text width="70%" /><Skeleton text width="50%" /></SkeletonGroup>}
      {entries.status === "error" && <LoadError error={entries.error} kind={entries.kind} retry={entries.retry} size="sm" title="The conversation could not be loaded" verb="use the assistant" />}
      {entries.status === "ready" && entries.value.map((entry) => <Entry entry={entry} key={entry.id} />)}
      {thread.working && <Status status={thread.status} />}
      {thread.note && <p className="c-assistant-note">{thread.note}</p>}
    </div>
  );
}

function Entry({ entry }: Readonly<{ entry: ThreadEntry }>) {
  if (entry.kind === "owner" || entry.kind === "assistant") return <div className="c-assistant-message" data-from={entry.kind}>{entry.text}</div>;
  if (entry.kind === "read") return <div className="c-assistant-read"><Status status={entry.status} /><span>{entry.title}</span></div>;
  return (
    <article className="c-assistant-proposal" data-destructive={entry.destructive || undefined}>
      <div className="c-assistant-proposal-head"><strong>{entry.title}</strong><Status status={entry.status} /></div>
      <pre className="c-assistant-detail">{entry.detail}</pre>
      {entry.result && <pre className="c-assistant-detail">{entry.result}</pre>}
      {(entry.apply || entry.reject) && (
        <div className="c-assistant-decide">
          {entry.apply && <ActionButton action={entry.apply} size="sm" />}
          {entry.reject && <ActionButton action={entry.reject} size="sm" />}
        </div>
      )}
    </article>
  );
}
