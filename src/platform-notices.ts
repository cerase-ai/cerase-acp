// The messages the PLATFORM posts into the chat on its own account, as
// opposed to the ones the model writes.
//
// Two things were wrong with them wherever they were written inline. They were
// Italian regardless of the language the conversation was being held in, and
// they were written in a different register from the assistant beside them --
// an emoji and a parenthetical on one line, a raw workspace path on the next.
// To the person reading the chat both come from the same colleague, so they
// have to sound like one.
//
// The rules they follow, and the reason each is here:
//   - no raw path, no id, no internal name. The assistant's own output-hygiene
//     contract forbids those, and a notice that breaks it teaches the reader
//     that paths are normal in this chat. A file is named by its NAME.
//   - no emoji. The house style leaves emoji to the user.
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

/**
 * Uploads the user sent that were dropped for exceeding the size cap.
 *
 * The cap reported is the EFFECTIVE per-channel one, so the reader sees the
 * ceiling that actually bound rather than the global setting.
 */
export function oversizeUploadNotice(names: string[], capMb: number, lang: SupportedLang): string {
  const quoted = names.map((n) => `«${n}»`).join(", ");
  if (names.length === 1) {
    return pick(
      {
        it: `${quoted} supera il limite di ${capMb} MB, quindi non l'ho ricevuto. Se me lo mandi più leggero lo guardo subito.`,
        en: `${quoted} is over the ${capMb} MB limit, so it did not reach me. Send a lighter version and I will look at it right away.`,
        es: `${quoted} supera el límite de ${capMb} MB, así que no me ha llegado. Mándame una versión más ligera y lo miro enseguida.`,
        fr: `${quoted} dépasse la limite de ${capMb} Mo, donc il ne m'est pas parvenu. Envoie-m'en une version plus légère et je le regarde tout de suite.`,
      },
      lang,
    );
  }
  return pick(
    {
      it: `${quoted} superano il limite di ${capMb} MB, quindi non li ho ricevuti. Se me li mandi più leggeri li guardo subito.`,
      en: `${quoted} are over the ${capMb} MB limit, so they did not reach me. Send lighter versions and I will look at them right away.`,
      es: `${quoted} superan el límite de ${capMb} MB, así que no me han llegado. Mándame versiones más ligeras y las miro enseguida.`,
      fr: `${quoted} dépassent la limite de ${capMb} Mo, donc ils ne me sont pas parvenus. Envoie-m'en des versions plus légères et je les regarde tout de suite.`,
    },
    lang,
  );
}

/**
 * A chunk of the reply the channel refused even on the retry.
 *
 * This one used to carry the Italian and the English in a single string joined
 * by a slash, which is what a notice looks like when nobody can say which
 * language the reader is owed.
 */
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
 * The last segment of a workspace-relative path.
 *
 * A notice used to print the path the model had written, which put
 * `bozze/2026/preventivo-acme.md` in front of someone who has no filesystem to
 * resolve it against and contradicts the hygiene rule in the same breath as
 * apologising.
 */
export function displayFileName(relPath: string): string {
  const segments = relPath.split("/").filter((s) => s !== "");
  return segments[segments.length - 1] ?? relPath;
}
