import { useCallback, useEffect, useRef, useState } from "react";

import { type AssistantConversation, type AssistantModel, type ConversationEntry, type ConversationStatus, type ConversationSummary, failureKind } from "../api/contract";
import { useApi } from "../api/context";
import { action, type Action } from "./actions";
import { ASSISTANT_CHOICES } from "./data";
import type { AssistantChatModel, ConversationRow, Loading, ThreadEntry } from "./models";
import type { Notify } from "./notify";
import type { StatusDescriptor } from "./status";

/** How often an open conversation is read while the assistant works. */
const TURN_POLL_MS = 2000;

const CONVERSATION_STATUS: Readonly<Record<ConversationStatus, StatusDescriptor>> = {
  working: { kind: "progress", label: "Working" },
  waiting: { kind: "pending", label: "Waiting for you" },
  idle: { kind: "ok", label: "Done" },
  failed: { kind: "error", label: "Stopped" },
};

const PROPOSAL_STATUS = {
  pending: { kind: "pending", label: "Waiting for you" },
  applied: { kind: "ok", label: "Applied" },
  rejected: { kind: "off", label: "Rejected" },
  failed: { kind: "error", label: "Failed" },
} as const satisfies Readonly<Record<string, StatusDescriptor>>;

function threadEntries(conversation: AssistantConversation, decide: (proposalId: string, decision: "apply" | "reject") => void, deciding: string | null): readonly ThreadEntry[] {
  return conversation.entries.map((entry: ConversationEntry, index): ThreadEntry => {
    const id = `${conversation.id}:${index}`;
    if (entry.kind === "owner" || entry.kind === "assistant") return { kind: entry.kind, id, text: entry.text };
    if (entry.kind === "read") return { kind: "read", id, title: entry.title, status: entry.ok ? { kind: "ok", label: "Read" } : { kind: "error", label: "The read failed" } };
    const { proposal } = entry;
    const open = proposal.status === "pending" && conversation.status === "waiting";
    const busy = deciding === proposal.id;
    return {
      kind: "proposal", id, title: proposal.title, destructive: proposal.destructive,
      detail: JSON.stringify(proposal.arguments, null, 2),
      status: PROPOSAL_STATUS[proposal.status], result: proposal.result,
      apply: open ? action(`assistant.apply.${proposal.id}`, "Apply", () => decide(proposal.id, "apply"), { icon: "check", busy, disabled: deciding !== null, hint: "Run this change as you" }) : null,
      reject: open ? action(`assistant.reject.${proposal.id}`, "Reject", () => decide(proposal.id, "reject"), { icon: "close", disabled: deciding !== null }) : null,
    };
  });
}

function listedTitle(list: Loading<readonly ConversationSummary[]>, id: string): string {
  return list.status === "ready" ? list.value.find((item) => item.id === id)?.title ?? "" : "";
}

/**
 * The Owner's assistant panel (ADR-0096): read only while it is open, and an
 * open conversation read again while the assistant works on it.
 */
export function useAssistantChat(offered: boolean, notify: Notify): AssistantChatModel | null {
  const api = useApi();
  const [shown, setShown] = useState(false);
  const [list, setList] = useState<Loading<readonly ConversationSummary[]>>({ status: "loading" });
  const [listRevision, setListRevision] = useState(0);
  const [current, setCurrent] = useState<string | null>(null);
  const [conversation, setConversation] = useState<Loading<AssistantConversation> | null>(null);
  const [model, setModel] = useState<AssistantModel>("haiku");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [deciding, setDeciding] = useState<string | null>(null);
  const reading = useRef(0);

  const fail = useCallback((error: unknown, message: string) => notify({ tone: "error", message: error instanceof Error ? error.message : message }), [notify]);

  useEffect(() => {
    if (!offered || !shown) return;
    let live = true;
    setList({ status: "loading" });
    api.listConversations()
      .then((value) => { if (live) setList({ status: "ready", value }); })
      .catch((cause: unknown) => {
        if (live) setList({ status: "error", error: cause instanceof Error ? cause.message : "The conversations could not be read.", kind: failureKind(cause), retry: action("assistant.list.retry", "Try again", () => setListRevision((value) => value + 1)) });
      });
    return () => { live = false; };
  }, [offered, shown, listRevision]);

  const load = useCallback((conversationId: string) => {
    reading.current += 1;
    const mine = reading.current;
    setConversation({ status: "loading" });
    api.loadConversation(conversationId)
      .then((value) => { if (reading.current === mine) setConversation({ status: "ready", value }); })
      .catch((cause: unknown) => {
        if (reading.current === mine) setConversation({ status: "error", error: cause instanceof Error ? cause.message : "The conversation could not be read.", kind: failureKind(cause), retry: action("assistant.retry", "Try again", () => load(conversationId)) });
      });
  }, []);

  // While the assistant works, its conversation is read again until it stops.
  const working = conversation?.status === "ready" && conversation.value.status === "working";
  useEffect(() => {
    if (!shown || !working || current === null) return;
    const mine = reading.current;
    const timer = window.setTimeout(() => {
      api.loadConversation(current)
        .then((value) => {
          if (reading.current !== mine) return;
          setConversation({ status: "ready", value });
          if (value.status !== "working") setListRevision((count) => count + 1);
        })
        .catch(() => undefined);
    }, TURN_POLL_MS);
    return () => window.clearTimeout(timer);
  }, [shown, working, current, conversation]);

  const shownConversation = (value: AssistantConversation) => {
    reading.current += 1;
    setCurrent(value.id);
    setConversation({ status: "ready", value });
    setListRevision((count) => count + 1);
  };

  const decide = (proposalId: string, decision: "apply" | "reject") => {
    if (current === null) return;
    setDeciding(proposalId);
    api.decideProposal(current, proposalId, decision)
      .then(shownConversation)
      .catch((error: unknown) => fail(error, "The proposal could not be decided."))
      .finally(() => setDeciding(null));
  };

  if (!offered) return null;

  const ready = conversation?.status === "ready" ? conversation.value : null;
  const busy = ready !== null && (ready.status === "working" || ready.status === "waiting");
  const text = draft.trim();
  const send: Action = action("assistant.send", "Send", () => {
    if (text === "" || busy || sending) return;
    setSending(true);
    (current === null ? api.startConversation(model, text) : api.sendMessage(current, model, text))
      .then((value) => { setDraft(""); shownConversation(value); })
      .catch((error: unknown) => fail(error, "The message could not be sent."))
      .finally(() => setSending(false));
  }, {
    icon: "send", busy: sending, disabled: text === "" || busy || sending,
    hint: busy ? "The assistant is working, or waits for your decision" : undefined,
  });

  const rows: Loading<readonly ConversationRow[]> = list.status !== "ready" ? list : {
    status: "ready",
    value: list.value.map((item) => ({
      id: item.id, title: item.title, status: CONVERSATION_STATUS[item.status], updatedAt: item.updatedAt, current: item.id === current,
      select: action(`assistant.open.${item.id}`, item.title, () => { setCurrent(item.id); setModel(item.model); load(item.id); }),
    })),
  };

  const thread: AssistantChatModel["thread"] = current === null || conversation === null ? null : {
    title: ready?.title ?? listedTitle(list, current),
    status: ready === null ? { kind: "progress", label: "Reading" } : CONVERSATION_STATUS[ready.status],
    entries: conversation.status === "ready" ? { status: "ready", value: threadEntries(conversation.value, decide, deciding) } : conversation,
    note: ready?.note ?? null,
    working: ready?.status === "working",
  };

  return {
    open: action("assistant.show", "Assistant", () => setShown(true), { icon: "bolt" }),
    shown,
    close: action("assistant.close", "Close", () => setShown(false)),
    conversations: rows,
    thread,
    startNew: action("assistant.new", "New conversation", () => { reading.current += 1; setCurrent(null); setConversation(null); }, { icon: "add" }),
    choices: ASSISTANT_CHOICES,
    model,
    setModel,
    draft,
    setDraft,
    send,
  };
}
