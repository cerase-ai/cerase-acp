// Tracks the per-`(agent, user)` last-turn timestamp and produces the
// `[turn_meta: gap=…, lang=…]` block the bridge prepends to each
// `session/prompt`. The agent reads this per the system-prompt rules
// in cerase/agent-runtime/agent/srv/AGENTS.md.

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

// Tiny stopword-based language hint. Not a serious NLP detector — just
// enough to give the agent's system prompt a starting bias so it
// replies in the user's language by default. The agent itself does
// the heavy lifting on language tracking (M2 system-prompt rules).
const STOPWORDS: Record<Exclude<SupportedLang, "unknown">, RegExp> = {
  it: /\b(?:ciao|non|che|il|la|sono|come|cosa|grazie|per|con|del|della|puoi|mi|hai|fa|fare|aiutare|riassumere|domanda)\b/i,
  en: /\b(?:hello|the|and|you|can|what|how|with|please|help|summarise|summarize|difference|between|files|document|question)\b/i,
  es: /\b(?:hola|gracias|por|favor|puedes|ayudarme|qué|cómo|el|la|los|las|con|este|esta|documento)\b/i,
  fr: /\b(?:bonjour|merci|peux|tu|m'aider|aider|le|la|les|avec|ce|cette|document|comment|pour)\b/i,
};

export function detectLanguage(text: string): SupportedLang {
  if (!text || text.length < 4) return "unknown";
  let best: SupportedLang = "unknown";
  let bestHits = 0;
  for (const lang of ["it", "en", "es", "fr"] as const) {
    const hits = (text.match(new RegExp(STOPWORDS[lang], "gi")) ?? []).length;
    if (hits > bestHits) {
      best = lang;
      bestHits = hits;
    }
  }
  return bestHits > 0 ? best : "unknown";
}

export function makeTurnMetaBlock(parts: { gap: string; lang: SupportedLang }): string {
  return `[turn_meta: gap=${parts.gap}, lang=${parts.lang}]\n\n`;
}

interface TurnState {
  lastAt: number;
}

const key = (agentId: string, userId: string) => `${agentId}:${userId}`;

export class TurnMetaTracker {
  private state = new Map<string, TurnState>();

  /**
   * True once prefix() has recorded at least one turn for the
   * (agent, user) pair. M-LEGAL-1 keys the one-time AI-transparency
   * disclosure on this, so first-ness has a single source of truth.
   */
  hasSeen(agentId: string, userId: string): boolean {
    return this.state.has(key(agentId, userId));
  }

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
    const lang = detectLanguage(text);
    this.state.set(k, { lastAt: now });
    return makeTurnMetaBlock({ gap, lang });
  }
}
