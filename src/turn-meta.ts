// Tracks the per-`(agent, user)` last-turn timestamp and produces the
// `[turn_meta: gap=…, lang=…, now=…]` block the bridge prepends to each
// `session/prompt`. The agent reads it by the rules in the baseline prompt,
// cerase-core's control-plane/config/defaults/agents-baseline.md.

export type SupportedLang = "it" | "en" | "es" | "fr" | "unknown";

// Sub-second/minute/hour/day formatter. Designed to be terse so the
// agent's prompt-prefix cache hits more often.
export function formatGap(prevAt: number | undefined, now: number): string {
  if (prevAt === undefined) return "first";
  const deltaSec = Math.max(0, Math.floor((now - prevAt) / 1000));
  if (deltaSec < 60) return `${deltaSec}s`;
  const deltaMin = Math.floor(deltaSec / 60);
  if (deltaMin < 60) return `${deltaMin}m`;
  const deltaH = Math.floor(deltaMin / 60);
  if (deltaH < 24) return `${deltaH}h`;
  const deltaD = Math.floor(deltaH / 24);
  return `${deltaD}d`;
}

// A language hint from the person's own words, not an NLP detector: enough to
// tell the assistant which language to answer in.
//
// Each list holds common words of one language. A word that appears in more
// than one list says nothing and is not counted, wherever it was written: «tu»
// is French and Italian, «la» is in three of them. A list that held it counted
// it for the language it happened to be filed under, and «Sì, ho cambiato idea:
// preparala tu.» reached an assistant tagged French.
const WORDS: Record<Exclude<SupportedLang, "unknown">, string[]> = {
  it: [
    "sì",
    "ho",
    "hai",
    "ha",
    "abbiamo",
    "avete",
    "hanno",
    "è",
    "e",
    "di",
    "che",
    "il",
    "lo",
    "gli",
    "una",
    "uno",
    "sono",
    "questo",
    "questa",
    "quello",
    "quella",
    "anche",
    "ma",
    "perché",
    "più",
    "già",
    "va",
    "bene",
    "grazie",
    "ciao",
    "per",
    "del",
    "della",
    "dei",
    "delle",
    "nel",
    "nella",
    "mi",
    "ti",
    "ci",
    "io",
    "noi",
    "voi",
    "puoi",
    "fare",
    "fai",
    "cosa",
    "quando",
    "dove",
    "allora",
    "poi",
    "adesso",
    "ora",
    "domani",
    "oggi",
    "ieri",
    "dopo",
    "aspetta",
    "giusto",
    "così",
    "attimo",
    "perfetto",
    "fatto",
    "aiutare",
    "riassumere",
    "domanda",
    "capito",
    "mandala",
    "mandalo",
    "preparala",
    "preparalo",
    "scrivi",
    "manda",
    "certo",
    "ecco",
  ],
  en: [
    "yes",
    "the",
    "and",
    "you",
    "your",
    "can",
    "what",
    "how",
    "with",
    "please",
    "help",
    "is",
    "are",
    "it",
    "this",
    "that",
    "these",
    "to",
    "of",
    "for",
    "i",
    "my",
    "we",
    "do",
    "does",
    "send",
    "will",
    "would",
    "could",
    "now",
    "today",
    "tomorrow",
    "thanks",
    "thank",
    "fine",
    "wait",
    "go",
    "ahead",
    "sure",
    "write",
    "hello",
    "hi",
    "summarise",
    "summarize",
    "difference",
    "between",
    "files",
    "question",
    "two",
    "client",
  ],
  es: [
    "sí",
    "hola",
    "gracias",
    "por",
    "favor",
    "puedes",
    "ayudarme",
    "qué",
    "cómo",
    "el",
    "los",
    "las",
    "este",
    "esta",
    "es",
    "está",
    "y",
    "yo",
    "tú",
    "mañana",
    "hoy",
    "vale",
    "envío",
    "espera",
    "así",
    "para",
    "pero",
    "muy",
    "bueno",
    "claro",
    "también",
    "prepáralo",
    "mándalo",
  ],
  fr: [
    "oui",
    "bonjour",
    "merci",
    "je",
    "vous",
    "nous",
    "est",
    "et",
    "les",
    "le",
    "avec",
    "ce",
    "cette",
    "dans",
    "des",
    "du",
    "au",
    "pas",
    "ne",
    "qui",
    "c'est",
    "d'accord",
    "peux",
    "m'aider",
    "aider",
    "comment",
    "pour",
    "attends",
    "peu",
    "parfait",
    "envoie",
    "maintenant",
    "occupe",
    "voilà",
    "très",
  ],
};

const LANGS = ["it", "en", "es", "fr"] as const;

// Each word, to the one language it belongs to; a word of two lists, to none.
const OWNER: Map<string, Exclude<SupportedLang, "unknown">> = (() => {
  const seen = new Map<string, Set<string>>();
  for (const lang of LANGS) {
    for (const word of WORDS[lang]) {
      const langs = seen.get(word) ?? new Set<string>();
      langs.add(lang);
      seen.set(word, langs);
    }
  }
  const owner = new Map<string, Exclude<SupportedLang, "unknown">>();
  for (const [word, langs] of seen) {
    if (langs.size === 1) owner.set(word, [...langs][0] as Exclude<SupportedLang, "unknown">);
  }
  return owner;
})();

/** The words of a text, each also split at its apostrophes: «l'ho» is «l'ho», «l» and «ho». */
function words(text: string): string[] {
  const out: string[] = [];
  for (const token of text
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .match(/[\p{L}']+/gu) ?? []) {
    const word = token.replace(/^'+|'+$/g, "");
    if (!word) continue;
    out.push(word);
    if (word.includes("'")) out.push(...word.split("'").filter(Boolean));
  }
  return out;
}

/** The language a text's words point to, how many of them point there, and how many more than to any other. */
export function languageEvidence(raw: string): { lang: SupportedLang; hits: number; margin: number } {
  const text = personWords(raw);
  if (!text || text.length < 2) return { lang: "unknown", hits: 0, margin: 0 };
  const counts: Record<string, number> = { it: 0, en: 0, es: 0, fr: 0 };
  for (const word of words(text)) {
    const lang = OWNER.get(word);
    if (lang) counts[lang] = (counts[lang] ?? 0) + 1;
  }
  const ranked = [...LANGS].sort((a, b) => (counts[b] ?? 0) - (counts[a] ?? 0));
  const top = ranked[0] ?? "it";
  const best = counts[top] ?? 0;
  const margin = best - (counts[ranked[1] ?? "en"] ?? 0);
  return { lang: best > 0 && margin > 0 ? top : "unknown", hits: best, margin };
}

// A message whose words point to another language than the conversation's by
// fewer than this many is too weak to move the conversation: «Hello», «Merci».
const SWITCH_HITS = 2;

// The block of uploaded files the adapters put in front of a message: file
// paths, not the person's words. A voice message is that block and nothing
// else, and «files» is one of the English words below, so on guidance on 10
// October two Italian voice messages were tagged `lang=en`.
const UPLOADED_FILES = /^\[Uploaded files: [^\]\n]*\]\s*$/gm;

/** The words of a message the person wrote, without what the bridge added to it. */
export function personWords(text: string): string {
  return (text ?? "").replace(UPLOADED_FILES, "").trim();
}

export function detectLanguage(raw: string): SupportedLang {
  return languageEvidence(raw).lang;
}

export function makeTurnMetaBlock(parts: { gap: string; lang: SupportedLang; now?: string }): string {
  // The clock is OPTIONAL and appended last, both on purpose. Optional because
  // a control-plane that cannot be reached must not cost the turn a clock it
  // never had; last because the block is a suffix and everything before it is
  // what the assistant has been reading since the first version.
  const clock = parts.now ? `, now=${parts.now}` : "";
  return `[turn_meta: gap=${parts.gap}, lang=${parts.lang}${clock}]\n\n`;
}

interface TurnState {
  lastAt: number;
  // The language hint already computed for the meta block, kept so the
  // notices the bridge writes by itself can be written in it too.
  lastLang: SupportedLang;
}

const key = (agentId: string, userId: string) => `${agentId}:${userId}`;

/**
 * Asked for the pair's last turn when this process has never seen them.
 *
 * Returns the epoch ms of their previous turn, or undefined for "no extra
 * information" -- which covers both a pair that has genuinely never spoken and
 * a lookup that failed. The caller cannot tell those apart and must not: the
 * only safe reading of both is the one the tracker already had.
 */
export type LastTurnResolver = (agentId: string, userId: string) => Promise<number | undefined>;

export class TurnMetaTracker {
  private state = new Map<string, TurnState>();

  /**
   * Computes the meta block for `text` and records this turn's
   * timestamp for the (agent, user) key. The recording happens AFTER
   * the gap is computed so the prefix reflects the gap-since-previous,
   * not gap=0.
   */
  prefix(agentId: string, userId: string, text: string, now: number = Date.now()): string {
    const k = key(agentId, userId);
    const prev = this.state.get(k);
    const gap = formatGap(prev?.lastAt, now);
    const lang = this.turnLanguage(k, text);
    this.record(k, now, lang);
    return makeTurnMetaBlock({ gap, lang });
  }

  /**
   * The language a turn is tagged with: its own words', and for a turn whose
   * words do not say — a voice message, a file, «ok» — or say too little to move
   * the conversation — «Hello» in an Italian one — the language this person last
   * wrote in, then the organisation's. A turn tagged with a language the person
   * did not write in is answered in it.
   */
  private turnLanguage(k: string, text: string, fallback?: SupportedLang): SupportedLang {
    const evidence = languageEvidence(text);
    const last = this.state.get(k)?.lastLang;
    const known = last !== undefined && last !== "unknown" ? last : undefined;
    // A short message with weak evidence keeps the conversation's language.
    if (
      evidence.lang !== "unknown" &&
      (known === undefined || evidence.lang === known || evidence.hits >= SWITCH_HITS)
    ) {
      return evidence.lang;
    }
    if (known !== undefined) return known;
    if (evidence.lang !== "unknown") return evidence.lang;
    return fallback ?? "unknown";
  }

  /**
   * The same block, with the two things this process cannot know on its own.
   *
   * The resolver is consulted ONLY when there is no in-process state for the
   * pair. That is the restart case and nothing else: a running bridge answers
   * from its Map as before, so a busy hour costs no lookups at all.
   *
   * A resolver that throws is treated as having answered nothing, and the gap
   * falls back to what the Map knew. It must never be allowed to fail a turn --
   * the clock is a courtesy and the gap is a hint, and neither is worth a
   * conversation.
   */
  async prefixWithContext(
    agentId: string,
    userId: string,
    text: string,
    opts: { resolveLastTurn?: LastTurnResolver; clock?: string; now?: number; fallbackLang?: SupportedLang } = {},
  ): Promise<string> {
    const now = opts.now ?? Date.now();
    const k = key(agentId, userId);
    let prevAt = this.state.get(k)?.lastAt;

    if (prevAt === undefined && opts.resolveLastTurn) {
      try {
        const seeded = await opts.resolveLastTurn(agentId, userId);
        // Ignore a timestamp in the future: a clock skew between two machines
        // would otherwise render a negative gap as `0s`, which reads as "you
        // just wrote" to someone who has been away for a week.
        if (seeded !== undefined && seeded <= now) prevAt = seeded;
      } catch {
        // Nothing. See the contract above.
      }
    }

    const gap = formatGap(prevAt, now);
    const lang = this.turnLanguage(k, text, opts.fallbackLang);
    this.record(k, now, lang);

    return makeTurnMetaBlock({ gap, lang, now: opts.clock });
  }

  /**
   * The language the PLATFORM should write to this pair in.
   *
   * The block handed to the model carries this turn's detection, which is
   * "unknown" for anything short ("ok", "grazie", a bare link). A notice the
   * bridge posts by itself cannot fall back to Italian on those turns without
   * switching language mid-conversation, so the LAST KNOWN answer is kept and
   * a per-turn "unknown" never overwrites it.
   */
  languageFor(agentId: string, userId: string): SupportedLang {
    return this.state.get(key(agentId, userId))?.lastLang ?? "unknown";
  }

  private record(k: string, now: number, lang: SupportedLang): void {
    const previous = this.state.get(k)?.lastLang;
    this.state.set(k, {
      lastAt: now,
      lastLang: lang === "unknown" ? (previous ?? "unknown") : lang,
    });
  }
}
