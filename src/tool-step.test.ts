// The call that asks the control-plane for the sentence of a step, against a
// fetch that records what it is handed and answers what the test says.

import { describe, expect, it } from "vitest";
import { fetchToolStep } from "./tool-step.js";

interface Seen {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeFetch(answer: () => Response | Promise<Response>, seen: Seen[]): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    seen.push({
      url: String(url),
      method: init?.method,
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(String(init?.body)),
    });
    return answer();
  }) as typeof fetch;
}

const OPTS = { controlPlaneUrl: "http://cerase-control-plane:8000/", internalSecret: "bearer-from-agents-yaml" };
const STEP = {
  tool: "cerase-gateway_call_recipe",
  input: { recipe_name: "google-workspace.getGoogleSheetContent", args: { spreadsheetId: "abc", range: "A1:Z9" } },
  lang: "it" as const,
};

describe("the sentence of a step", () => {
  it("is asked with POST /api/internal/tool-step/{agent}, the bearer, and the tool, its input and the language", async () => {
    const seen: Seen[] = [];
    const sentence = await fetchToolStep("agent 1", STEP, {
      ...OPTS,
      fetchImpl: fakeFetch(() => Response.json({ sentence: "Sto leggendo un foglio Google…" }), seen),
    });
    expect(sentence).toBe("Sto leggendo un foglio Google…");
    expect(seen).toEqual([
      {
        url: "http://cerase-control-plane:8000/api/internal/tool-step/agent%201",
        method: "POST",
        headers: {
          Authorization: "Bearer bearer-from-agents-yaml",
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: {
          tool: "cerase-gateway_call_recipe",
          input: {
            recipe_name: "google-workspace.getGoogleSheetContent",
            args: { spreadsheetId: "abc", range: "A1:Z9" },
          },
          lang: "it",
        },
      },
    ]);
  });

  it("is refused, so the caller says its own, on an error status, an answer without a sentence, or no answer in time", async () => {
    const seen: Seen[] = [];
    await expect(
      fetchToolStep("agent-1", STEP, { ...OPTS, fetchImpl: fakeFetch(() => new Response("", { status: 500 }), seen) }),
    ).rejects.toThrow(/HTTP 500/);
    await expect(
      fetchToolStep("agent-1", STEP, { ...OPTS, fetchImpl: fakeFetch(() => Response.json({ sentence: "  " }), seen) }),
    ).rejects.toThrow(/no sentence/);
    await expect(
      fetchToolStep("agent-1", STEP, { ...OPTS, fetchImpl: fakeFetch(() => Response.json({ text: "x" }), seen) }),
    ).rejects.toThrow(/no sentence/);

    const silent = (async (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as unknown as typeof fetch;
    await expect(fetchToolStep("agent-1", STEP, { ...OPTS, fetchImpl: silent, timeoutMs: 20 })).rejects.toThrow();
  });

  it("is cut to a line's length when the catalogue answers with more", async () => {
    const seen: Seen[] = [];
    const sentence = await fetchToolStep("agent-1", STEP, {
      ...OPTS,
      fetchImpl: fakeFetch(() => Response.json({ sentence: "Sto leggendo ".repeat(100) }), seen),
    });
    expect(sentence.length).toBe(300);
    expect(sentence.endsWith("…")).toBe(true);
  });
});
