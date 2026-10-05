// The messages the bridge itself posts into the chat, in the assistant's
// voice, as opposed to the ones the model writes. The notices the platform
// sends on its own account, signed Cerase, are in platform-notice.ts.
//
// Each is written in the language of the conversation and in the register of
// the assistant beside it: to the person reading the chat both come from the
// same colleague, so they have to sound like one.
//
// The rules they follow, and the reason each is here:
//   - no raw path, no id, no internal name. The assistant's own output-hygiene
//     contract forbids those, and a notice that breaks it teaches the reader
//     that paths are normal in this chat. A file is named by its NAME.
//   - no emoji. The house style leaves emoji to the user. One symbol is the
//     exception, by the operator's decision: the speech balloon Google Chat
//     shows while an answer is being written, chosen over a sentence saying
//     so. It reads the same in every language and is never part of a notice.
//   - say whether the thing is permanent. "I could not attach it" and "this
//     channel cannot carry attachments" call for different next moves.
//
// Italian is the fallback for a conversation whose language was never
// determined, because the appliance ships Italian-first.

import type { SupportedLang } from "./turn-meta.js";

type Localised = Record<Exclude<SupportedLang, "unknown">, string>;

const pick = (texts: Localised, lang: SupportedLang): string => (lang === "unknown" ? texts.it : texts[lang]);

/** The file was found but the channel refused the upload. */
export function attachmentFailedNotice(fileName: string, lang: SupportedLang): string {
  return pick(
    {
      it: `Non sono riuscita ad allegare ${fileName}. Il file è pronto: se vuoi riprovo subito.`,
      en: `I could not attach ${fileName}. The file is ready, so I can try again right away if you want.`,
      es: `No he podido adjuntar ${fileName}. El archivo está listo: si quieres, lo intento de nuevo.`,
      fr: `Je n'ai pas réussi à joindre ${fileName}. Le fichier est prêt : je peux réessayer tout de suite.`,
    },
    lang,
  );
}

/** The file could not be read out of the workspace at all. */
export function attachmentUnreadableNotice(fileName: string, lang: SupportedLang): string {
  return pick(
    {
      it: `Non sono riuscita a recuperare ${fileName} per allegarlo. Dimmi pure se vuoi che lo rifaccia.`,
      en: `I could not retrieve ${fileName} to attach it. Tell me if you would like me to redo it.`,
      es: `No he podido recuperar ${fileName} para adjuntarlo. Dime si quieres que lo rehaga.`,
      fr: `Je n'ai pas réussi à récupérer ${fileName} pour le joindre. Dis-moi si tu veux que je le refasse.`,
    },
    lang,
  );
}

/** The channel itself carries no attachments; retrying will never help. */
export function attachmentsUnsupportedNotice(fileName: string, lang: SupportedLang): string {
  return pick(
    {
      it: `Su questo canale non posso mandare allegati, quindi ${fileName} resta da parte. Se preferisci te ne incollo qui il contenuto.`,
      en: `This channel cannot carry attachments, so ${fileName} stays on my side. I can paste its contents here instead if you prefer.`,
      es: `Este canal no admite archivos adjuntos, así que ${fileName} se queda aquí conmigo. Si prefieres, pego su contenido en el chat.`,
      fr: `Ce canal n'accepte pas les pièces jointes, donc ${fileName} reste de mon côté. Je peux coller son contenu ici si tu préfères.`,
    },
    lang,
  );
}

/** A size in MB with one decimal, in the reader's own number format. */
function megabytes(sizeBytes: number, lang: SupportedLang): string {
  const value = (sizeBytes / (1024 * 1024)).toFixed(1);
  return lang === "en"
    ? `${value} MB`
    : lang === "fr"
      ? `${value.replace(".", ",")} Mo`
      : `${value.replace(".", ",")} MB`;
}

/**
 * Uploads the user sent that were refused for exceeding the size cap.
 *
 * Each file is named with its size, and the cap reported is the EFFECTIVE
 * per-channel one, so the reader sees how far over the file was and the
 * ceiling that actually bound rather than the console's limit. It ends with
 * the three ways to send the same thing within the limit.
 */
export function oversizeUploadNotice(
  files: Array<{ name: string; sizeBytes: number }>,
  capMb: number,
  lang: SupportedLang,
): string {
  if (files.length === 1) {
    const [file] = files;
    const name = `«${file!.name}»`;
    const size = megabytes(file!.sizeBytes, lang);
    return pick(
      {
        it: `${name} pesa ${size} e il limite è ${capMb} MB, quindi non l'ho ricevuto. Mandamelo più leggero, diviso in parti o esportato in PDF e lo guardo subito.`,
        en: `${name} is ${size} and the limit is ${capMb} MB, so it did not reach me. Send it smaller, split into parts or exported to PDF and I will look at it right away.`,
        es: `${name} pesa ${size} y el límite es de ${capMb} MB, así que no me ha llegado. Mándamelo más ligero, dividido en partes o exportado a PDF y lo miro enseguida.`,
        fr: `${name} fait ${size} et la limite est de ${capMb} Mo, donc il ne m'est pas parvenu. Envoie-le plus léger, découpé en plusieurs parties ou exporté en PDF et je le regarde tout de suite.`,
      },
      lang,
    );
  }
  const listed = files.map((f) => `«${f.name}» (${megabytes(f.sizeBytes, lang)})`).join(", ");
  return pick(
    {
      it: `${listed} superano il limite di ${capMb} MB, quindi non li ho ricevuti. Mandameli più leggeri, divisi in parti o esportati in PDF e li guardo subito.`,
      en: `${listed} are over the ${capMb} MB limit, so they did not reach me. Send them smaller, split into parts or exported to PDF and I will look at them right away.`,
      es: `${listed} superan el límite de ${capMb} MB, así que no me han llegado. Mándamelos más ligeros, divididos en partes o exportados a PDF y los miro enseguida.`,
      fr: `${listed} dépassent la limite de ${capMb} Mo, donc ils ne me sont pas parvenus. Envoie-les plus légers, découpés en plusieurs parties ou exportés en PDF et je les regarde tout de suite.`,
    },
    lang,
  );
}

/** A chunk of the reply the channel refused through every retry. */
export function deliveryFailureNotice(lang: SupportedLang): string {
  return pick(
    {
      it: "Una parte della risposta non è arrivata: il canale l'ha rifiutata. Chiedimi di ripeterla e te la rimando.",
      en: "Part of the reply did not get through: the channel refused it. Ask me to repeat it and I will send it again.",
      es: "Una parte de la respuesta no ha llegado: el canal la ha rechazado. Pídeme que la repita y te la reenvío.",
      fr: "Une partie de la réponse n'est pas passée : le canal l'a refusée. Demande-moi de la répéter et je te la renvoie.",
    },
    lang,
  );
}

/**
 * A message that waited for the assistant to come back from a restart, and
 * waited past the bound. The person is told it was not taken, and that the
 * cause passes: sending it again in a few minutes is what works.
 */
export function restartOutlastedNotice(lang: SupportedLang): string {
  return pick(
    {
      it: "Mi sto riavviando e non sono riuscita a prendere in carico il tuo messaggio. Rimandamelo tra qualche minuto.",
      en: "I am restarting and could not take on your message. Send it to me again in a few minutes.",
      es: "Me estoy reiniciando y no he podido atender tu mensaje. Vuelve a enviármelo dentro de unos minutos.",
      fr: "Je suis en train de redémarrer et je n'ai pas pu prendre en charge ton message. Renvoie-le-moi dans quelques minutes.",
    },
    lang,
  );
}

/**
 * Messages the person sent while the bridge was restarting, kept for the next
 * bridge, which came up too long after them to act on them now. They are not
 * handled, because an instruction left that long ago may be one the person no
 * longer wants carried out; sending them again is what works. `count` says
 * whether the person is told about one message or several.
 */
export function keptMessagesExpiredNotice(lang: SupportedLang, count: number): string {
  return count === 1
    ? pick(
        {
          it: "Mi hai scritto mentre mi stavo riavviando e il riavvio è durato troppo perché me ne occupi adesso. Se ti serve ancora, rimandami il messaggio.",
          en: "You wrote to me while I was restarting, and the restart took too long for me to take your message on now. If you still need it, send it to me again.",
          es: "Me escribiste mientras me estaba reiniciando y el reinicio ha durado demasiado para que me ocupe de tu mensaje ahora. Si todavía lo necesitas, vuelve a enviármelo.",
          fr: "Tu m'as écrit pendant que je redémarrais, et le redémarrage a duré trop longtemps pour que je m'occupe de ton message maintenant. Si tu en as encore besoin, renvoie-le-moi.",
        },
        lang,
      )
    : pick(
        {
          it: "Mi hai scritto mentre mi stavo riavviando e il riavvio è durato troppo perché me ne occupi adesso. Se ti servono ancora, rimandami i messaggi.",
          en: "You wrote to me while I was restarting, and the restart took too long for me to take your messages on now. If you still need them, send them to me again.",
          es: "Me escribiste mientras me estaba reiniciando y el reinicio ha durado demasiado para que me ocupe de tus mensajes ahora. Si todavía los necesitas, vuelve a enviármelos.",
          fr: "Tu m'as écrit pendant que je redémarrais, et le redémarrage a duré trop longtemps pour que je m'occupe de tes messages maintenant. Si tu en as encore besoin, renvoie-les-moi.",
        },
        lang,
      );
}

/**
 * An answer the assistant was still working on when an update stopped the
 * bridge, after the bridge had waited as long as it waits for one. The request
 * is not sent again on the person's behalf, because the assistant may already
 * have acted on part of it; writing it again reaches the same conversation.
 */
export function updateInterruptedNotice(lang: SupportedLang): string {
  return pick(
    {
      it: "Un aggiornamento ha interrotto la risposta che ti stavo preparando. Scrivimi di nuovo la richiesta, per favore.",
      en: "An update interrupted the answer I was preparing for you. Please write your request to me again.",
      es: "Una actualización ha interrumpido la respuesta que te estaba preparando. Escríbeme de nuevo tu petición, por favor.",
      fr: "Une mise à jour a interrompu la réponse que je te préparais. Écris-moi de nouveau ta demande, s'il te plaît.",
    },
    lang,
  );
}

/**
 * The conversation grew past what the assistant can summarise, and a new one
 * was started in its place. `fromSummary` says whether the new one starts from
 * a summary of the old one or from nothing, because the person should know how
 * much of what they said earlier they may need to say again.
 */
export function startedOverNotice(lang: SupportedLang, fromSummary: boolean): string {
  return fromSummary
    ? pick(
        {
          it: "La nostra conversazione era diventata troppo lunga per continuare, quindi ne ho iniziata una nuova partendo da un riassunto di quella precedente. Se mi manca un dettaglio che ti serve, ripetimelo.",
          en: "Our conversation had grown too long to continue, so I started a new one from a summary of the previous one. If I am missing a detail you need, tell me again.",
          es: "Nuestra conversación se había vuelto demasiado larga para continuar, así que he empezado una nueva a partir de un resumen de la anterior. Si me falta algún detalle que necesitas, repítemelo.",
          fr: "Notre conversation était devenue trop longue pour continuer, alors j'en ai commencé une nouvelle à partir d'un résumé de la précédente. S'il me manque un détail dont tu as besoin, redis-le-moi.",
        },
        lang,
      )
    : pick(
        {
          it: "La nostra conversazione era diventata troppo lunga per continuare, quindi ne ho iniziata una nuova e di quella precedente non ho un riassunto. Se ti serve qualcosa di cui abbiamo parlato, ripetimelo.",
          en: "Our conversation had grown too long to continue, so I started a new one, and I have no summary of the previous one. If you need something we talked about, tell me again.",
          es: "Nuestra conversación se había vuelto demasiado larga para continuar, así que he empezado una nueva y no tengo un resumen de la anterior. Si necesitas algo de lo que hablamos, repítemelo.",
          fr: "Notre conversation était devenue trop longue pour continuer, alors j'en ai commencé une nouvelle et je n'ai pas de résumé de la précédente. Si tu as besoin de quelque chose dont nous avons parlé, redis-le-moi.",
        },
        lang,
      );
}

/**
 * A message to the assistant written in a group space rather than a direct
 * message. The answer would be read by everyone in the space, and an assistant
 * answers with its own user's memory and connectors, so it answers nowhere but
 * a direct message.
 */
export function directMessagesOnlyNotice(lang: SupportedLang): string {
  return pick(
    {
      it: "Rispondo solo nei messaggi diretti: scrivimi lì.",
      en: "I only answer in direct messages: write to me there.",
      es: "Solo respondo en mensajes directos: escríbeme allí.",
      fr: "Je ne réponds qu'en messages directs : écris-moi là-bas.",
    },
    lang,
  );
}

/**
 * The line a Google Chat conversation shows while its answer is being written:
 * a single speech balloon, U+1F4AC, the same in every language. Chat gives an
 * app neither a read receipt nor a typing indicator, so the app posts this on
 * receipt and rewrites it to WRITING_ENDED_NOTICE once the answer is on its
 * way. Every way a turn ends rewrites it, so a balloon still standing is a turn
 * still running, or an edit Google refused, which is logged.
 */
export const WRITING_NOTICE = "\u{1F4AC}";

/**
 * What the writing line says once the turn it announced has ended: a single
 * horizontal ellipsis, the same in every language. The line stays where it was
 * posted, above the answer, which arrives as a message of its own.
 */
export const WRITING_ENDED_NOTICE = "\u2026";

/**
 * The last segment of a workspace-relative path. A notice names a file by its
 * name: the person has no filesystem to resolve a path such as
 * `bozze/preventivo-acme.md` against.
 */
export function displayFileName(relPath: string): string {
  const segments = relPath.split("/").filter((s) => s !== "");
  return segments[segments.length - 1] ?? relPath;
}
