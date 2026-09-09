// La verifica della firma che Google Chat mette su ogni webhook.
//
// Senza di essa il listener non e' un endpoint da proteggere meglio: e' un buco
// di impersonificazione. Il gestore ricava il mittente da event.user.email nel
// corpo, quindi chiunque raggiunga l'URL puo' dichiararsi chiunque e farsi
// rispondere dall'assistente di quella persona, con la sua memoria e i suoi
// connettori.
//
// Questi casi provano il RIFIUTO, non la configurazione. Il controllo che
// esisteva prima guardava che un valore fosse scritto in `agents.yaml`, ed era
// verde mentre nessuna richiesta veniva verificata.
import { createSign, generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";

import { EMITTENTE, RichiestaNonVerificata, svuotaCache, verifica } from "./workspace-chat-verify.js";

const AUDIENCE = "123456789012";
const KID = "chiave-di-prova";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM_PUBBLICA = publicKey.export({ type: "spki", format: "pem" }).toString();

function b64(o: unknown): string {
  return Buffer.from(JSON.stringify(o)).toString("base64url");
}

/** Un JWT firmato come lo firma Chat, con i pezzi che il caso vuole cambiare. */
function token(
  opts: { aud?: string; iss?: string; exp?: number; iat?: number; kid?: string; firmaSbagliata?: boolean } = {},
): string {
  const adesso = Math.floor(Date.now() / 1000);
  const testa = b64({ alg: "RS256", typ: "JWT", kid: opts.kid ?? KID });
  const corpo = b64({
    aud: opts.aud ?? AUDIENCE,
    iss: opts.iss ?? EMITTENTE,
    iat: opts.iat ?? adesso - 10,
    exp: opts.exp ?? adesso + 300,
  });
  const firmatore = createSign("RSA-SHA256");
  firmatore.update(`${testa}.${corpo}`);
  const firma = firmatore.sign(privateKey).toString("base64url");
  return `${testa}.${corpo}.${opts.firmaSbagliata ? `AAAA${firma.slice(4)}` : firma}`;
}

/** I certificati di Google, serviti da una finta rete. */
function rete(certificati: Record<string, string> = { [KID]: PEM_PUBBLICA }, headers: Record<string, string> = {}) {
  let chiamate = 0;
  const recupera = (async () => {
    chiamate += 1;
    return {
      ok: true,
      status: 200,
      json: async () => certificati,
      headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    };
  }) as unknown as typeof fetch;
  return { recupera, quante: () => chiamate };
}

describe("workspace-chat: verifica della richiesta", () => {
  beforeEach(() => svuotaCache());

  it("un token firmato da Chat, per questa app e non scaduto, passa", async () => {
    const { recupera } = rete();
    const esito = await verifica(`Bearer ${token()}`, AUDIENCE, { recupera });
    expect(esito.emittente).toBe(EMITTENTE);
    expect(esito.destinatario).toBe(AUDIENCE);
  });

  // Il caso che il buco rendeva possibile: nessuna credenziale, e il corpo
  // decide chi sei.
  it("senza header Authorization rifiuta", async () => {
    const { recupera } = rete();
    await expect(verifica(undefined, AUDIENCE, { recupera })).rejects.toThrow(RichiestaNonVerificata);
    await expect(verifica("", AUDIENCE, { recupera })).rejects.toThrow(/assente/);
  });

  it("un header che non e' `Bearer <token>` rifiuta", async () => {
    const { recupera } = rete();
    await expect(verifica("Basic aGE6aGE=", AUDIENCE, { recupera })).rejects.toThrow(/non e' .Bearer/);
  });

  it("una firma manomessa rifiuta", async () => {
    const { recupera } = rete();
    await expect(verifica(`Bearer ${token({ firmaSbagliata: true })}`, AUDIENCE, { recupera })).rejects.toThrow(
      RichiestaNonVerificata,
    );
  });

  // Un token vero, firmato da Google, ma emesso per l'app Chat di qualcun
  // altro. Senza il controllo dell'audience basterebbe avere una propria app.
  it("un token destinato a un'altra app rifiuta", async () => {
    const { recupera } = rete();
    await expect(verifica(`Bearer ${token({ aud: "999999999999" })}`, AUDIENCE, { recupera })).rejects.toThrow(
      RichiestaNonVerificata,
    );
  });

  it("un token firmato da un'altra identita' di Google rifiuta", async () => {
    const { recupera } = rete();
    await expect(
      verifica(`Bearer ${token({ iss: "qualcunaltro@system.gserviceaccount.com" })}`, AUDIENCE, { recupera }),
    ).rejects.toThrow(RichiestaNonVerificata);
  });

  // Oltre i 300 secondi di tolleranza sull'orologio che la libreria concede. Un
  // token scaduto da un minuto viene accettato, ed e' giusto: due macchine che
  // non concordano sull'ora non sono un attacco.
  it("un token scaduto oltre la tolleranza d'orologio rifiuta", async () => {
    const adesso = Math.floor(Date.now() / 1000);
    const { recupera } = rete();
    await expect(
      verifica(`Bearer ${token({ iat: adesso - 3000, exp: adesso - 600 })}`, AUDIENCE, { recupera }),
    ).rejects.toThrow(RichiestaNonVerificata);
  });

  // maxExpiry va passato in SECONDI: in millisecondi il limite diventa
  // quarantun giorni. Non da' errore, non rompe niente, e il controllo sulla
  // scadenza troppo lontana smette di controllare restando verde, cosi' un
  // token con un anno di vita passerebbe.
  it("un token con una vita assurda rifiuta, o il limite non e' un limite", async () => {
    const adesso = Math.floor(Date.now() / 1000);
    const { recupera } = rete();
    await expect(
      verifica(`Bearer ${token({ iat: adesso - 10, exp: adesso + 86400 * 30 })}`, AUDIENCE, { recupera }),
    ).rejects.toThrow(RichiestaNonVerificata);
  });

  it("una chiave che non e' fra quelle pubblicate da Google rifiuta", async () => {
    const { recupera } = rete();
    await expect(verifica(`Bearer ${token({ kid: "chiave-inventata" })}`, AUDIENCE, { recupera })).rejects.toThrow(
      RichiestaNonVerificata,
    );
  });

  // Senza audience non c'e' niente contro cui verificare: e' un rifiuto, non un
  // "salta il controllo". E' la porta da cui il difetto e' entrato la prima
  // volta — un valore atteso, mai usato.
  it("senza audience configurata rifiuta, invece di lasciar passare", async () => {
    const { recupera } = rete();
    await expect(verifica(`Bearer ${token()}`, "", { recupera })).rejects.toThrow(/nessun audience/);
  });

  it("se i certificati di Google non si recuperano, nessuna richiesta passa", async () => {
    const recupera = (async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
      headers: { get: () => null },
    })) as unknown as typeof fetch;
    await expect(verifica(`Bearer ${token()}`, AUDIENCE, { recupera })).rejects.toThrow(/non recuperabili/);
  });

  // Google ruota le chiavi: tenerle per sempre rifiuta richieste valide il
  // giorno della rotazione, riscaricarle a ogni richiesta lega il canale a una
  // rete che puo' non rispondere. La durata la dichiara la risposta.
  it("i certificati si tengono per il tempo che Google dichiara, e non oltre", async () => {
    let orologio = 1_000_000;
    const { recupera, quante } = rete({ [KID]: PEM_PUBBLICA }, { "cache-control": "public, max-age=100" });
    const ora = () => orologio;
    await verifica(`Bearer ${token()}`, AUDIENCE, { recupera, ora });
    await verifica(`Bearer ${token()}`, AUDIENCE, { recupera, ora });
    expect(quante()).toBe(1);
    orologio += 101_000;
    await verifica(`Bearer ${token()}`, AUDIENCE, { recupera, ora });
    expect(quante()).toBe(2);
  });
});
