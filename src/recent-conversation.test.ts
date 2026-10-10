import { describe, expect, it } from "vitest";
import { isBridgePrompt } from "./bridge-prompt.js";
import { fetchRecentConversation, recentConversationNote } from "./recent-conversation.js";

// A new conversation is told how the person's previous one ended. On radicalhr
// on 2 October a reply the assistant had written for approval was in one
// conversation and the person's «manda pure» reached a new one, which held
// nothing of it. Every name here is invented.

const OPTS = { controlPlaneUrl: "http://cp:8000", internalSecret: "s3cret" };

function answering(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("the end of the previous conversation", () => {
  it("is read from the control-plane with the bearer, person and assistant turns only", async () => {
    let seen = "";
    let bearer = "";
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen = String(url);
      bearer = String((init?.headers as Record<string, string>)?.Authorization ?? "");
      return new Response(
        JSON.stringify({
          conversation: {
            ended_at: "2026-10-10 15:29 Europe/Rome",
            turns: [
              { role: "person", text: "Rispondi a Clelia che confermiamo giovedì" },
              { role: "assistant", text: "Ecco la risposta: «Gentile Clelia, confermiamo giovedì…». La mando?" },
              { role: "tool", text: "ignored" },
              { role: "person", text: "   " },
            ],
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const recent = await fetchRecentConversation("agent-3", { ...OPTS, fetchImpl });

    expect(seen).toBe("http://cp:8000/api/internal/recent-conversation/agent-3");
    expect(bearer).toBe("Bearer s3cret");
    expect(recent?.turns.map((t) => t.role)).toEqual(["person", "assistant"]);
  });

  it("is nothing when there is none, and a failed request throws rather than saying there is none", async () => {
    expect(
      await fetchRecentConversation("a", { ...OPTS, fetchImpl: answering({ conversation: null }) }),
    ).toBeUndefined();
    await expect(fetchRecentConversation("a", { ...OPTS, fetchImpl: answering({}, 500) })).rejects.toThrow();
  });

  it("is told as a prompt of the bridge's own, with the messages and what to do with them", () => {
    const note = recentConversationNote({
      endedAt: "2026-10-10 15:29 Europe/Rome",
      turns: [
        { role: "person", text: "Rispondi a Clelia" },
        { role: "assistant", text: "Ecco la risposta. La mando?" },
      ],
    });

    expect(isBridgePrompt(note)).toBe(true);
    expect(note.split("\n")[0]).toBe("[conversation_result: new]");
    expect(note).toContain("ended at 2026-10-10 15:29 Europe/Rome");
    expect(note).toContain("The person: Rispondi a Clelia");
    expect(note).toContain("You: Ecco la risposta. La mando?");
    expect(note).toContain("nothing in it was sent, saved or approved unless it says so");
  });
});
