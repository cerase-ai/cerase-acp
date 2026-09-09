// Verifica per-richiesta della firma che Google Chat mette su ogni webhook.
//
// Senza questa verifica il listener e' un buco di impersonificazione, non un
// endpoint da proteggere meglio. Il gestore ricava il mittente da
// event.user.email nel corpo della richiesta: chiunque conosca l'URL puo'
// dichiararsi chiunque e farsi rispondere dall'assistente di quella persona,
// con la sua memoria, i suoi connettori e i suoi documenti.
//
// Tenere il listener raggiungibile solo attraverso la rotta Traefik non e' una
// mitigazione: Traefik e' cio' che lo espone. Finche' la rotta non esiste il
// listener e' irraggiungibile, e quello stato si legge facilmente come una
// difesa da chi sta per aggiungere la rotta.
//
// Cosa Google manda e cosa si controlla (docs: "Verify requests from Google
// Chat"): un JWT nell'header `Authorization: Bearer`, firmato da
// `chat@system.gserviceaccount.com`, con `aud` uguale al numero di progetto
// dell'app Chat. Si verificano firma, emittente, destinatario e scadenza — e si
// rifiuta tutto il resto, perche' una verifica che accetta cio' che non
// riconosce non e' una verifica.
import { OAuth2Client } from "google-auth-library";
import { makeLogger } from "./logger.js";

const logger = makeLogger("cerase-acp.workspace-chat.verify");

/** L'unico emittente accettato. Chat firma con questa identita' di sistema. */
export const EMITTENTE = "chat@system.gserviceaccount.com";

/** I certificati pubblici di quell'identita'. */
export const URL_CERTIFICATI = `https://www.googleapis.com/service_accounts/v1/metadata/x509/${encodeURIComponent(EMITTENTE)}`;

// Vita massima accettata per un token, in SECONDI: e' l'unita' che
// verifySignedJwtWithCertsAsync vuole, e sbagliarla non da' errore. Passando
// millisecondi il limite diventa quarantun giorni e il controllo sulla scadenza
// troppo lontana smette di controllare, restando verde. Un JWT di Chat vive
// pochi minuti; un'ora e' gia' larga.
//
// Questo non e' il controllo che rifiuta un token scaduto: quello lo fa la
// libreria con 300 secondi di tolleranza sull'orologio, che e' giusto tenere,
// perche' due macchine che non concordano sull'ora non sono un attacco.
const VITA_MASSIMA_SEC = 60 * 60;

export class RichiestaNonVerificata extends Error {}

type Certificati = Record<string, string>;

let cache: { certificati: Certificati; scadenza: number } | undefined;

/** Solo per i test: svuota la cache dei certificati. */
export function svuotaCache(): void {
  cache = undefined;
}

/**
 * Solo per i test: mette in cache dei certificati, cosi' un test che esercita
 * il listener non deve raggiungere Google.
 *
 * Sta qui invece di un parametro iniettabile sul gestore HTTP perche' un punto
 * di iniezione sulla verifica e' un modo per disattivarla: questo riempie una
 * cache che esiste comunque, e non cambia cosa viene controllato.
 */
export function seminaCache(certificati: Certificati, durataMs = 60_000, ora: () => number = Date.now): void {
  cache = { certificati, scadenza: ora() + durataMs };
}

/**
 * I certificati di Google, con la cache che la risposta stessa dichiara.
 *
 * Google ruota queste chiavi. Scaricarle a ogni richiesta rende il canale
 * dipendente da una rete che puo' non rispondere; tenerle per sempre significa
 * rifiutare richieste valide il giorno della rotazione. Il `max-age` della
 * risposta e' la durata che Google dichiara, quindi e' quella che si usa.
 */
export async function certificati(recupera: typeof fetch = fetch, ora: () => number = Date.now): Promise<Certificati> {
  if (cache && cache.scadenza > ora()) return cache.certificati;
  const resp = await recupera(URL_CERTIFICATI);
  if (!resp.ok) {
    throw new RichiestaNonVerificata(
      `certificati di Google non recuperabili (HTTP ${resp.status}): senza di essi nessuna richiesta puo' essere verificata, quindi nessuna viene accettata`,
    );
  }
  const certificati = (await resp.json()) as Certificati;
  const controllo = resp.headers.get("cache-control") ?? "";
  const maxAge = /max-age=(\d+)/.exec(controllo);
  // Senza `max-age` un'ora: abbastanza da non martellare, poco da seguire una
  // rotazione. Mai "per sempre".
  const durata = (maxAge ? Number(maxAge[1]) : 3600) * 1000;
  cache = { certificati, scadenza: ora() + durata };
  return certificati;
}

/**
 * Verifica l'header `Authorization` di una richiesta di Chat.
 *
 * Alza `RichiestaNonVerificata` su qualunque cosa non sia un token valido,
 * firmato da Chat, destinato a QUESTA app e non scaduto. Non restituisce mai
 * "non lo so": un dubbio e' un rifiuto.
 */
export async function verifica(
  header: string | undefined,
  audience: string,
  opzioni: { recupera?: typeof fetch; ora?: () => number; client?: OAuth2Client } = {},
): Promise<{ emittente: string; destinatario: string }> {
  if (!audience) {
    throw new RichiestaNonVerificata(
      "nessun audience configurato: senza il numero di progetto non c'e' niente contro cui verificare il token",
    );
  }
  const grezzo = (header ?? "").trim();
  const m = /^Bearer\s+(\S+)$/i.exec(grezzo);
  if (!m?.[1]) {
    throw new RichiestaNonVerificata(
      grezzo ? "header Authorization presente ma non e' `Bearer <token>`" : "header Authorization assente",
    );
  }
  const client = opzioni.client ?? new OAuth2Client();
  const certs = await certificati(opzioni.recupera ?? fetch, opzioni.ora ?? Date.now);
  let ticket: Awaited<ReturnType<OAuth2Client["verifySignedJwtWithCertsAsync"]>>;
  try {
    ticket = await client.verifySignedJwtWithCertsAsync(m[1], certs, audience, [EMITTENTE], VITA_MASSIMA_SEC);
  } catch (err) {
    // Il messaggio della libreria dice gia' quale controllo e' fallito (firma,
    // destinatario, emittente, scadenza) e va riportato: un rifiuto senza
    // ragione manda chi configura a indovinare.
    throw new RichiestaNonVerificata(`token rifiutato: ${(err as Error).message}`);
  }
  const payload = ticket.getPayload();
  if (!payload) throw new RichiestaNonVerificata("token senza payload");
  return { emittente: payload.iss ?? "", destinatario: String(payload.aud ?? "") };
}

/** Come `verifica`, ma logga il rifiuto e restituisce un booleano. */
export async function accettabile(
  header: string | undefined,
  audience: string,
  agentId: string,
  opzioni: Parameters<typeof verifica>[2] = {},
): Promise<boolean> {
  try {
    await verifica(header, audience, opzioni);
    return true;
  } catch (err) {
    logger.warn({ agentId, motivo: (err as Error).message }, "richiesta webhook rifiutata");
    return false;
  }
}
