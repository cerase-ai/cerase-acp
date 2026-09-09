// Il listener del webhook, esercitato mandandogli richieste vere.
//
// I tre test che esistevano prima provavano tutti la stessa guardia d'avvio:
// errore se manca l'audience, prosegue se c'e', gli altri canali partono lo
// stesso. Nessuno riceveva un evento, nessuno rispondeva, nessuno verificava a
// quale agente finiva. Il canale poteva essere rotto in ogni modo tranne uno, e
// la suite restava verde.
process.env.WORKSPACE_CHAT_PORT = "0";

import { createSign, generateKeyPairSync } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatAdapter } from "./chat-adapter.js";
import { createChatAdapter } from "./chat-adapter.js";
import type { AgentConfig } from "./config.js";
import type { Dispatcher } from "./dispatcher.js";
import { EMITTENTE, seminaCache, svuotaCache } from "./workspace-chat-verify.js";

const KID = "chiave-di-prova";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = publicKey.export({ type: "spki", format: "pem" }).toString();

function b64(o: unknown) {
  return Buffer.from(JSON.stringify(o)).toString("base64url");
}

function token(aud: string, iss = EMITTENTE): string {
  const adesso = Math.floor(Date.now() / 1000);
  const testa = b64({ alg: "RS256", typ: "JWT", kid: KID });
  const corpo = b64({ aud, iss, iat: adesso - 10, exp: adesso + 300 });
  const f = createSign("RSA-SHA256");
  f.update(`${testa}.${corpo}`);
  return `${testa}.${corpo}.${f.sign(privateKey).toString("base64url")}`;
}

function agente(id: string, audience: string): AgentConfig {
  return {
    id,
    channel: "workspace_chat",
    workspace_chat_credentials_path: `/var/cerase/workspace-chat-creds/${id}.json`,
    workspace_chat_verification_audience: audience,
    allowed_users: ["ops@example.test"],
    cwd: "/home/agent/cerase/workspace",
    spawn: { command: "docker", args: [] },
  } as unknown as AgentConfig;
}

function evento(email = "ops@example.test", text = "ciao") {
  return { type: "MESSAGE", user: { email }, message: { text } };
}

describe("workspace-chat: il listener risponde a richieste vere", () => {
  const ricevute: { agentId: string; userId: string; text: string }[] = [];
  const dispatcher = {
    handleMessage: vi.fn(async (agentId: string, userId: string, text: string) => {
      ricevute.push({ agentId, userId, text });
    }),
    sendSystemMessage: vi.fn(async () => undefined),
  } as unknown as Dispatcher;

  let adattatori: ChatAdapter[] = [];
  let porta = 0;

  beforeEach(async () => {
    ricevute.length = 0;
    vi.clearAllMocks();
    svuotaCache();
    seminaCache({ [KID]: PEM });
    // Due agenti sullo stesso listener, con due audience diverse: e' la
    // configurazione in cui un errore di verifica per-agente si vede.
    for (const [id, aud] of [
      ["agente-uno", "111111111111"],
      ["agente-due", "222222222222"],
    ] as const) {
      const a = await createChatAdapter(agente(id, aud), dispatcher);
      await a.start();
      adattatori.push(a);
    }
    porta = portaDelListener();
  });

  afterEach(async () => {
    for (const a of adattatori) await a.stop().catch(() => undefined);
    adattatori = [];
    svuotaCache();
  });

  function portaDelListener(): number {
    // Il server e' interno al modulo e non viene esportato; si trova fra gli
    // handle attivi del processo. Va cercato per `listening`, non per "il primo
    // che ha una porta": fra gli handle ci sono anche i socket client delle
    // fetch precedenti, e uno di quelli da una porta chiusa.
    const handles = (process as unknown as { _getActiveHandles(): unknown[] })._getActiveHandles();
    for (const h of handles) {
      const s = h as { listening?: boolean; address?: () => AddressInfo | string | null };
      if (s.listening !== true || typeof s.address !== "function") continue;
      const addr = s.address();
      if (addr && typeof addr === "object" && "port" in addr && addr.port > 0) return addr.port;
    }
    throw new Error("listener non trovato fra gli handle attivi");
  }

  async function posta(percorso: string, corpo: unknown, authorization?: string) {
    return fetch(`http://127.0.0.1:${porta}${percorso}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
      body: JSON.stringify(corpo),
    });
  }

  it("un evento firmato arriva all'agente giusto", async () => {
    const r = await posta("/agente-uno/event", evento(), `Bearer ${token("111111111111")}`);
    expect(r.status).toBe(200);
    expect(ricevute).toEqual([{ agentId: "agente-uno", userId: "ops@example.test", text: "ciao" }]);
  });

  // Il caso per cui la verifica esiste: senza credenziali, il corpo decide chi
  // sei. Prima di questo commit sarebbe passato, e l'assistente avrebbe
  // risposto come la persona nominata nel corpo.
  it("senza Authorization il dispatcher non viene mai raggiunto", async () => {
    const r = await posta("/agente-uno/event", evento("capo@example.test"));
    expect(r.status).toBe(401);
    expect(ricevute).toEqual([]);
  });

  it("una firma per un'altra app non passa", async () => {
    const r = await posta("/agente-uno/event", evento(), `Bearer ${token("999999999999")}`);
    expect(r.status).toBe(401);
    expect(ricevute).toEqual([]);
  });

  // L'audience e' PER AGENTE. Con una sola variabile di modulo il token del
  // secondo agente avrebbe aperto anche il primo, e i due agenti sono due
  // organizzazioni diverse.
  it("il token di un agente non apre la rotta di un altro", async () => {
    const r = await posta("/agente-uno/event", evento(), `Bearer ${token("222222222222")}`);
    expect(r.status).toBe(401);
    expect(ricevute).toEqual([]);

    const suo = await posta("/agente-due/event", evento(), `Bearer ${token("222222222222")}`);
    expect(suo.status).toBe(200);
    expect(ricevute).toEqual([{ agentId: "agente-due", userId: "ops@example.test", text: "ciao" }]);
  });

  it("un agente che non esiste da 404, non 401", async () => {
    const r = await posta("/agente-inesistente/event", evento(), `Bearer ${token("111111111111")}`);
    expect(r.status).toBe(404);
    expect(ricevute).toEqual([]);
  });

  it("una GET sulla stessa rotta non fa niente", async () => {
    const r = await fetch(`http://127.0.0.1:${porta}/agente-uno/event`);
    expect(r.status).toBe(404);
    expect(ricevute).toEqual([]);
  });
});
