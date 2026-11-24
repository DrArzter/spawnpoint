import { useEffect, useRef, type FormEvent, type KeyboardEvent } from "react";

import type { AssistantChatModel, ConversationRow, ThreadEntry } from "../../core/models";
import { ActionButton } from "./ui/ActionButton";
import { Ago } from "./ui/Ago";
import { LoadError } from "./ui/Empty";
import { Indicator } from "./ui/Indicator";
import { TextArea } from "./ui/Fields";
import { Segmented } from "./ui/Segmented";
import { SidePanel } from "./ui/SidePanel";
import { Skeleton, SkeletonGroup } from "./ui/Skeleton";
import { Status } from "./ui/Status";
import { TrackList, TrackTitle, type Track } from "./ui/TrackList";

const tracks: readonly Track<ConversationRow>[] = [
  { id: "conversation", header: "Conversation", width: "minmax(0, 1fr)", kind: "stack", render: (row) => <TrackTitle action={row.select} current={row.current} line={<Ago at={row.updatedAt} />} title={row.title} /> },
  // The list is narrow: the state is a mark, its label the tooltip.
  { id: "state", header: "State", width: "auto", kind: "end", quietHeader: true, render: (row) => <Indicator status={row.status} /> },
];

/**
 * The Owner's assistant, over any page (ADR-0096): the conversations beside the
 * open one, and under it one composer, the message with its model and Send.
 * Enter sends; Shift+Enter starts a new line. The panel closes from its head.
 */
export function AssistantPanel({ model }: Readonly<{ model: AssistantChatModel }>) {
  const ready = !model.send.disabled && !model.send.busy;
  const send = (event: FormEvent) => {
    event.preventDefault();
    if (ready) model.send.run();
  };
  const sendOnEnter = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (ready) model.send.run();
  };
  const list = model.conversations;
  return (
    <SidePanel cancel={model.close} footer={false} resize="assistant" title="Assistant" wide>
      <div className="c-assistant">
        <div className="c-assistant-layout">
          <section aria-label="Conversations" className="c-assistant-list">
            <ActionButton action={model.startNew} size="sm" />
            {list.status === "error" && <LoadError error={list.error} kind={list.kind} retry={list.retry} size="sm" title="Conversations could not be loaded" verb="use the assistant" />}
            {list.status !== "error" && (list.status === "loading" || list.value.length > 0) && (
              <TrackList header={false} label="Conversations" loading={list.status === "loading"} rowKey={(row) => row.id} rows={list.status === "ready" ? list.value : []} tracks={tracks} />
            )}
          </section>
          <section aria-label={model.thread?.title ?? "New conversation"} className="c-assistant-thread">
            {model.thread === null ? <div className="c-assistant-entries" /> : <Thread thread={model.thread} />}
            <form className="c-assistant-compose" onSubmit={send}>
              <TextArea aria-label="Message" maxLength={4000} onChange={(event) => model.setDraft(event.target.value)} onKeyDown={sendOnEnter} placeholder="Message" prose rows={3} value={model.draft} />
              <div className="c-assistant-compose-bar">
                <Segmented label="Model" onChange={model.setModel} options={model.choices.map((choice) => ({ value: choice.value, label: choice.label, hint: choice.hint }))} value={model.model} />
                <ActionButton action={model.send} variant="primary" />
              </div>
            </form>
          </section>
        </div>
      </div>
    </SidePanel>
  );
}

function Thread({ thread }: Readonly<{ thread: NonNullable<AssistantChatModel["thread"]> }>) {
  const entries = thread.entries;
  const log = useRef<HTMLDivElement>(null);
  const count = entries.status === "ready" ? entries.value.length : 0;
  // The newest entry stays in view as the conversation grows.
  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [count, thread.working]);
  return (
    <div aria-live="polite" className="c-assistant-entries" ref={log} role="log">
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
