import { useCallback, useEffect, useRef, useState } from "react";

import { type AssistantConversation, type AssistantModel, type ConversationEntry, type ConversationStatus, type ConversationSummary, failureKind } from "../api/contract";
import { useApi } from "../api/context";
import { action, type Action } from "./actions";
import { ASSISTANT_CHOICES } from "./data";
import type { AssistantChatModel, ConversationRow, Loading, ThreadEntry } from "./models";
import type { Notify } from "./notify";
import type { StatusDescriptor } from "./status";
import { t } from "../i18n";

/** How often an open conversation is read while the assistant works. */
const TURN_POLL_MS = 2000;

const CONVERSATION_STATUS: Readonly<Record<ConversationStatus, StatusDescriptor>> = {
  working: { kind: "progress", label: t("assistant.working") },
  waiting: { kind: "pending", label: t("assistant.waiting") },
  idle: { kind: "ok", label: t("common.done") },
  failed: { kind: "error", label: t("common.stopped") },
};

const PROPOSAL_STATUS = {
  pending: { kind: "pending", label: t("assistant.waiting") },
  applied: { kind: "ok", label: t("assistant.applied") },
  rejected: { kind: "off", label: t("assistant.rejected") },
  failed: { kind: "error", label: t("common.failed") },
} as const satisfies Readonly<Record<string, StatusDescriptor>>;

function threadEntries(conversation: AssistantConversation, decide: (proposalId: string, decision: "apply" | "reject") => void, deciding: string | null): readonly ThreadEntry[] {
  return conversation.entries.map((entry: ConversationEntry, index): ThreadEntry => {
    const id = `${conversation.id}:${index}`;
    if (entry.kind === "owner" || entry.kind === "assistant") return { kind: entry.kind, id, text: entry.text };
    if (entry.kind === "read") return { kind: "read", id, title: entry.title, status: entry.ok ? { kind: "ok", label: t("assistant.read") } : { kind: "error", label: t("assistant.readFailed") } };
    const { proposal } = entry;
    const open = proposal.status === "pending" && conversation.status === "waiting";
    const busy = deciding === proposal.id;
    return {
      kind: "proposal", id, title: proposal.title, destructive: proposal.destructive,
      detail: JSON.stringify(proposal.arguments, null, 2),
      status: PROPOSAL_STATUS[proposal.status], result: proposal.result,
      apply: open ? action(`assistant.apply.${proposal.id}`, t("assistant.apply"), () => decide(proposal.id, "apply"), { icon: "check", busy, disabled: deciding !== null, hint: t("assistant.runChangeAs") }) : null,
      reject: open ? action(`assistant.reject.${proposal.id}`, t("assistant.reject"), () => decide(proposal.id, "reject"), { icon: "close", disabled: deciding !== null }) : null,
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
        if (live) setList({ status: "error", error: cause instanceof Error ? cause.message : t("assistant.conversationsCouldNotRead"), kind: failureKind(cause), retry: action("assistant.list.retry", t("common.tryAgain"), () => setListRevision((value) => value + 1)) });
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
        if (reading.current === mine) setConversation({ status: "error", error: cause instanceof Error ? cause.message : t("assistant.conversationCouldNotRead"), kind: failureKind(cause), retry: action("assistant.retry", t("common.tryAgain"), () => load(conversationId)) });
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
      .catch((error: unknown) => fail(error, t("assistant.proposalCouldNotDecided")))
      .finally(() => setDeciding(null));
  };

  if (!offered) return null;

  const ready = conversation?.status === "ready" ? conversation.value : null;
  const busy = ready !== null && (ready.status === "working" || ready.status === "waiting");
  const text = draft.trim();
  const send: Action = action("assistant.send", t("assistant.send"), () => {
    if (text === "" || busy || sending) return;
    setSending(true);
    (current === null ? api.startConversation(model, text) : api.sendMessage(current, model, text))
      .then((value) => { setDraft(""); shownConversation(value); })
      .catch((error: unknown) => fail(error, t("assistant.messageCouldNotSent")))
      .finally(() => setSending(false));
  }, {
    icon: "send", busy: sending, disabled: text === "" || busy || sending,
    hint: busy ? t("assistant.assistantWorkingWaitsDecision") : undefined,
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
    status: ready === null ? { kind: "progress", label: t("assistant.reading") } : CONVERSATION_STATUS[ready.status],
    entries: conversation.status === "ready" ? { status: "ready", value: threadEntries(conversation.value, decide, deciding) } : conversation,
    note: ready?.note ?? null,
    working: ready?.status === "working",
  };

  return {
    open: action("assistant.show", t("common.assistant"), () => setShown(true), { icon: "bolt" }),
    shown,
    close: action("assistant.close", t("common.close"), () => setShown(false)),
    conversations: rows,
    thread,
    startNew: action("assistant.new", t("assistant.newConversation"), () => { reading.current += 1; setCurrent(null); setConversation(null); }, { icon: "add" }),
    choices: ASSISTANT_CHOICES,
    model,
    setModel,
    draft,
    setDraft,
    send,
  };
}
