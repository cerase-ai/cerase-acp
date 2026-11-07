// The hosts a person names in a message are handed to the control-plane before
// the turn runs, so the assistant can open the page they asked about. The
// extraction is deliberately conservative: an email address is a mailbox, not
// a page, and a file name is a file, not a host.

import { describe, expect, it, vi } from "vitest";
import type { BridgeConfig } from "./config.js";
import { Dispatcher, type DispatcherDeps } from "./dispatcher.js";
import { grantReachableHosts, hostsNamedIn } from "./reachable-hosts.js";
import type { SessionManager, SessionUpdateHandler } from "./session-manager.js";
import { TurnMetaTracker } from "./turn-meta.js";

describe("hostsNamedIn", () => {
  it("takes the host out of a full URL, lower-cased", () => {
    expect(hostsNamedIn("leggi https://Example.com/pagina?x=1")).toEqual(["example.com"]);
  });

  it("takes a host written without a scheme, path and all", () => {
    expect(hostsNamedIn("guarda www.example.it/prezzi e docs.example.org")).toEqual([
      "www.example.it",
      "docs.example.org",
    ]);
  });

  it("drops the port a URL carries", () => {
    expect(hostsNamedIn("http://example.com:8080/a")).toEqual(["example.com"]);
  });

  it("lower-cases, removes duplicates, and keeps the order the hosts appear in", () => {
    expect(hostsNamedIn("prima Docs.Example.org poi https://Example.com e di nuovo example.com")).toEqual([
      "docs.example.org",
      "example.com",
    ]);
  });

  it("does not take the domain of an email address for a page", () => {
    expect(hostsNamedIn("scrivi a mario@example.com")).toEqual([]);
  });

  it("does not take a file name with a document extension for a host", () => {
    expect(hostsNamedIn("il file report.pdf e la bozza.docx")).toEqual([]);

    const extensions = [
      "pdf",
      "docx",
      "doc",
      "xlsx",
      "xls",
      "pptx",
      "ppt",
      "csv",
      "txt",
      "md",
      "png",
      "jpg",
      "jpeg",
      "gif",
      "zip",
      "mp3",
      "mp4",
      "wav",
      "html",
      "htm",
      "json",
      "xml",
    ];
    for (const extension of extensions) {
      expect(hostsNamedIn(`allega report.${extension}`)).toEqual([]);
    }
  });

  it("does take the host of a URL that ends in a document extension", () => {
    expect(hostsNamedIn("apri https://example.com/report.pdf")).toEqual(["example.com"]);
    expect(hostsNamedIn("apri http://example.com/report.pdf")).toEqual(["example.com"]);
  });

  it("does not read ordinary prose or a decimal number as a host", () => {
    expect(hostsNamedIn("ciao come stai.")).toEqual([]);
    expect(hostsNamedIn("1.5 milioni")).toEqual([]);
  });

  it("returns at most twenty hosts", () => {
    const hosts = Array.from({ length: 25 }, (_, i) => `host${i}.example.com`);
    expect(hostsNamedIn(hosts.join(" "))).toEqual(hosts.slice(0, 20));
  });
});

const OPTS = {
  controlPlaneUrl: "http://cerase-control-plane:8000/",
  internalSecret: "bearer-from-agents-yaml",
  bridgeSecret: "bridge-secret",
};

function recording(status: number) {
  const seen = { url: "", method: "", headers: {} as Record<string, string>, body: "" };
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    seen.url = url;
    seen.method = init?.method ?? "";
    seen.headers = (init?.headers as Record<string, string> | undefined) ?? {};
    seen.body = typeof init?.body === "string" ? init.body : "";
    return new Response(null, { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

describe("grantReachableHosts", () => {
  it("POSTs the hosts as JSON to the agent's reachable-hosts route", async () => {
    const { fetchImpl, seen } = recording(204);

    await grantReachableHosts("agent 1", ["example.com", "www.example.it"], { ...OPTS, fetchImpl });

    expect(seen.method).toBe("POST");
    expect(seen.url).toBe("http://cerase-control-plane:8000/api/internal/agents/agent%201/reachable-hosts");
    expect(seen.headers).toMatchObject({
      Authorization: "Bearer bearer-from-agents-yaml",
      "X-Cerase-Bridge-Secret": "bridge-secret",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(seen.body)).toEqual({ hosts: ["example.com", "www.example.it"] });
  });

  it("tolerates a trailing slash on the control-plane URL", async () => {
    const withSlash = recording(200);
    const withoutSlash = recording(200);

    await grantReachableHosts("agent 1", ["example.com"], { ...OPTS, fetchImpl: withSlash.fetchImpl });
    await grantReachableHosts("agent 1", ["example.com"], {
      ...OPTS,
      controlPlaneUrl: "http://cerase-control-plane:8000",
      fetchImpl: withoutSlash.fetchImpl,
    });

    expect(withSlash.seen.url).toBe("http://cerase-control-plane:8000/api/internal/agents/agent%201/reachable-hosts");
    expect(withoutSlash.seen.url).toBe(withSlash.seen.url);
  });

  it("never throws: a refusal and a network error both resolve", async () => {
    const refused = recording(500);
    await expect(
      grantReachableHosts("a", ["example.com"], { ...OPTS, fetchImpl: refused.fetchImpl }),
    ).resolves.toBeUndefined();

    const broken = (async () => {
      throw new Error("control-plane down");
    }) as unknown as typeof fetch;
    await expect(grantReachableHosts("a", ["example.com"], { ...OPTS, fetchImpl: broken })).resolves.toBeUndefined();
  });

  it("gives up after three seconds, through an AbortSignal on the fetch", async () => {
    let signal: AbortSignal | undefined;
    const startedAt = Date.now();
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }) as unknown as typeof fetch;

    await expect(grantReachableHosts("a", ["example.com"], { ...OPTS, fetchImpl })).resolves.toBeUndefined();

    expect(signal).toBeDefined();
    expect(signal?.aborted).toBe(true);
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(2_900);
    expect(elapsed).toBeLessThan(5_000);
  });
});

const config: BridgeConfig = {
  agents: [
    {
      id: "agent-1",
      channel: "discord",
      cwd: "/home/agent/cerase/workspace",
      mode: "cerase",
      bot_token: "irrelevant",
      allowed_users: ["111"],
      spawn: { command: "true", args: [] },
    },
  ],
  session: { idle_timeout_minutes: 60, max_concurrent: 16 },
};

interface Harness {
  dispatcher: Dispatcher;
  events: string[];
  grants: { agentId: string; hosts: string[] }[];
  prompts: string[];
}

/** A dispatcher whose turn answers at once, recording what it was handed. */
function harness(grant?: (agentId: string, hosts: string[]) => Promise<void>): Harness {
  const events: string[] = [];
  const grants: { agentId: string; hosts: string[] }[] = [];
  const prompts: string[] = [];
  const sessionManager = {
    prompt: async (
      _agentId: string,
      _userId: string,
      text: string,
      onUpdate?: (update: Parameters<SessionUpdateHandler>[0]) => void,
    ) => {
      prompts.push(text);
      events.push("prompt");
      onUpdate?.({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } });
      return { stopReason: "end_turn" };
    },
    holdTurn: () => () => {},
  } as unknown as SessionManager;
  const deps: DispatcherDeps = {
    config,
    sessionManager,
    turnMeta: new TurnMetaTracker(),
    resolveSendTarget: () => async () => ({ ok: true }),
    grantReachableHosts: async (agentId, hosts) => {
      grants.push({ agentId, hosts });
      events.push("grant");
      await grant?.(agentId, hosts);
    },
  };
  return { dispatcher: new Dispatcher(deps), events, grants, prompts };
}

describe("Dispatcher reachable hosts", () => {
  it("hands the person's hosts to the control-plane before the turn's prompt is sent", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness(async () => {
      await gate;
    });

    const turn = h.dispatcher.handleMessage("agent-1", "111", "guarda https://Example.com/a e www.example.it/prezzi");
    await vi.waitFor(() => expect(h.grants).toHaveLength(1));

    expect(h.grants).toEqual([{ agentId: "agent-1", hosts: ["example.com", "www.example.it"] }]);
    expect(h.prompts).toEqual([]);

    release();
    await expect(turn).resolves.toEqual({ ok: true });
    expect(h.prompts).toHaveLength(1);
    expect(h.events).toEqual(["grant", "prompt"]);
  });

  it("does not call it when the message names no host", async () => {
    const h = harness();

    await expect(
      h.dispatcher.handleMessage("agent-1", "111", "scrivi a mario@example.com e allega report.pdf"),
    ).resolves.toEqual({ ok: true });

    expect(h.grants).toEqual([]);
    expect(h.prompts).toHaveLength(1);
  });

  it("does not call it for a message that is not the person's", async () => {
    const h = harness();

    await expect(
      h.dispatcher.handleMessage("agent-1", "111", "leggi https://example.com", Date.now(), { byPerson: false }),
    ).resolves.toEqual({ ok: true });

    expect(h.grants).toEqual([]);
    expect(h.prompts).toHaveLength(1);
  });

  it("does not call it for a platform note, whatever byPerson says", async () => {
    const h = harness();
    const note = "[platform_note sig=abc123] apri https://example.com";

    await expect(h.dispatcher.handleMessage("agent-1", "111", note)).resolves.toEqual({ ok: true });
    await expect(h.dispatcher.handleMessage("agent-1", "111", note, Date.now(), { byPerson: true })).resolves.toEqual({
      ok: true,
    });
    await expect(h.dispatcher.handleMessage("agent-1", "111", note, Date.now(), { byPerson: false })).resolves.toEqual({
      ok: true,
    });

    expect(h.grants).toEqual([]);
    expect(h.prompts).toHaveLength(3);
  });

  it("does not stop the turn when the control-plane refuses the hosts", async () => {
    const h = harness(async () => {
      throw new Error("control-plane down");
    });

    await expect(h.dispatcher.handleMessage("agent-1", "111", "leggi https://example.com")).resolves.toEqual({
      ok: true,
    });

    expect(h.grants).toEqual([{ agentId: "agent-1", hosts: ["example.com"] }]);
    expect(h.prompts).toHaveLength(1);
  });
});
