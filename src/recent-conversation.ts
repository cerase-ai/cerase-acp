// What a new conversation is told about the person's previous one.
//
// On 2 October on radicalhr the assistant wrote a reply for the person to
// approve, and the person's «manda pure» reached a new conversation: a message
// from another surface goes to a session of its own, and the new one held
// nothing of the reply. The assistant searched its memory, its board and the
// mailbox, found nothing and asked what to send. The control-plane holds the
// assistant's conversations and reads the end of the last one from the slot;
// the bridge puts it in front of the first message of a new conversation, when
// the last one ended recently, as a prompt of its own the console does not show
// as the person's words.

import { bridgePromptLine } from "./bridge-prompt.js";

export interface RecentTurn {
  role: "person" | "assistant";
  text: string;
}

export interface RecentConversation {
  /** When the previous conversation's last message was written, as the organisation reads the clock. */
  endedAt: string;
  turns: RecentTurn[];
}

export interface RecentConversationOptions {
  controlPlaneUrl: string;
  internalSecret: string;
  fetchImpl?: typeof fetch;
}

/** The end of the assistant's previous conversation, or undefined when there is none to carry. Throws on a failed request. */
export async function fetchRecentConversation(
  agentId: string,
  opts: RecentConversationOptions,
): Promise<RecentConversation | undefined> {
  const f = opts.fetchImpl ?? fetch;
  const url = `${opts.controlPlaneUrl.replace(/\/$/, "")}/api/internal/recent-conversation/${encodeURIComponent(agentId)}`;
  const resp = await f(url, { headers: { Authorization: `Bearer ${opts.internalSecret}` } });
  if (!resp.ok) throw new Error(`recent-conversation: HTTP ${resp.status}`);
  const body = (await resp.json()) as {
    conversation?: { ended_at?: string; turns?: { role?: string; text?: string }[] } | null;
  };
  const c = body.conversation;
  if (!c || !Array.isArray(c.turns)) return undefined;
  const turns = c.turns
    .filter(
      (t) => (t.role === "person" || t.role === "assistant") && typeof t.text === "string" && t.text.trim() !== "",
    )
    .map((t) => ({ role: t.role as RecentTurn["role"], text: (t.text as string).trim() }));
  return turns.length > 0 ? { endedAt: String(c.ended_at ?? ""), turns } : undefined;
}

/** The note, in English like every prompt the platform writes to an assistant. */
export function recentConversationNote(recent: RecentConversation): string {
  const lines = recent.turns.map((t) => `${t.role === "person" ? "The person" : "You"}: ${t.text}`);
  return [
    bridgePromptLine("conversation", "new"),
    `This conversation is new. The person's previous conversation with you ended at ${recent.endedAt}, with these messages:`,
    lines.join("\n\n"),
    "If their message continues that conversation, carry on from where it stopped: what it left to do is still to do, and nothing in it was sent, saved or approved unless it says so. If it does not, answer it as it is.",
  ].join("\n\n");
}
