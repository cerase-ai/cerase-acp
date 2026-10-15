import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MARKER_HOLD_MS, StreamBuffer } from "./stream-buffer.js";

describe("StreamBuffer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("flushes when a sentence boundary is hit AND >= sentenceMinChars accumulated", () => {
    const out: string[] = [];
    const buf = new StreamBuffer({
      onFlush: (s) => out.push(s),
      sentenceMinChars: 20,
      maxChars: 1800,
      idleMs: 500,
    });
    // First chunk: short — no sentence boundary, no flush yet.
    buf.push("hello there. ");
    expect(out).toEqual([]);
    // Add more so total >= 20 then hit a sentence end. The piece is held back
    // for the words after it, which may be the marker of a file it introduces.
    buf.push("this is a longer chunk. ");
    expect(out).toEqual([]);
    buf.push("and this sends it.");
    expect(out).toEqual(["hello there. this is a longer chunk."]);
  });

  it("does NOT flush on a sentence boundary if below sentenceMinChars", () => {
    const out: string[] = [];
    const buf = new StreamBuffer({
      onFlush: (s) => out.push(s),
      sentenceMinChars: 50,
      maxChars: 1800,
      idleMs: 500,
    });
    buf.push("ok. ");
    expect(out).toEqual([]);
    // Force-flush via end() so the remainder lands somewhere observable.
    buf.end();
    expect(out).toEqual(["ok."]);
  });

  it("flushes when buffer exceeds maxChars regardless of boundary", () => {
    const out: string[] = [];
    const buf = new StreamBuffer({
      onFlush: (s) => out.push(s),
      sentenceMinChars: 1_000_000, // disable boundary-based flush
      maxChars: 50,
      idleMs: 500,
    });
    buf.push("x".repeat(60));
    expect(out.length).toBe(1);
    expect(out[0]!.length).toBe(60);
  });

  it("flushes on idle timer after the last push", () => {
    const out: string[] = [];
    const buf = new StreamBuffer({
      onFlush: (s) => out.push(s),
      sentenceMinChars: 1_000_000,
      maxChars: 10_000,
      idleMs: 500,
    });
    buf.push("partial sentence without terminator");
    expect(out).toEqual([]);
    vi.advanceTimersByTime(499);
    expect(out).toEqual([]);
    vi.advanceTimersByTime(2);
    expect(out).toEqual(["partial sentence without terminator"]);
  });

  it("end() flushes any remaining text", () => {
    const out: string[] = [];
    const buf = new StreamBuffer({
      onFlush: (s) => out.push(s),
      sentenceMinChars: 1_000_000,
      maxChars: 10_000,
      idleMs: 500,
    });
    buf.push("trailing without period");
    buf.end();
    expect(out).toEqual(["trailing without period"]);
  });

  it("discard() drops what is buffered, cancels the idle flush and takes nothing more", () => {
    const out: string[] = [];
    const held: string[] = [];
    const buf = new StreamBuffer({
      onFlush: (s) => out.push(s),
      onHeld: (s) => held.push(s),
      holdFrom: (piece) => piece.indexOf("HOLD"),
      sentenceMinChars: 1_000_000,
      idleMs: 20,
    });
    buf.push("not sent yet, and then HOLD this");
    buf.discard();
    buf.push("pushed after");
    buf.end();
    vi.advanceTimersByTime(100);
    expect(out).toEqual([]);
    expect(held).toEqual([]);
  });

  it("end() is a no-op when the buffer is empty", () => {
    const out: string[] = [];
    const buf = new StreamBuffer({
      onFlush: (s) => out.push(s),
      sentenceMinChars: 20,
      maxChars: 1800,
      idleMs: 500,
    });
    buf.end();
    expect(out).toEqual([]);
  });

  it("recognises ., !, ?, newline as sentence boundaries", () => {
    for (const terminator of [".", "!", "?", "\n"]) {
      const out: string[] = [];
      const buf = new StreamBuffer({
        onFlush: (s) => out.push(s),
        sentenceMinChars: 5,
        maxChars: 1800,
        idleMs: 500,
      });
      buf.push(`this is enough${terminator} `);
      // Held for the next words, then sent when they are prose.
      expect(out).toEqual([]);
      buf.push("and this sends it.");
      expect(out.length).toBe(1);
    }
  });

  describe("a buffer that keeps messages whole", () => {
    function whole(holdFrom?: (piece: string) => number) {
      const out: string[] = [];
      const kept: string[] = [];
      const buf = new StreamBuffer({
        onFlush: (s) => out.push(s),
        onHeld: (s) => kept.push(s),
        holdFrom,
        wholeMessages: true,
      });
      return { buf, out, kept };
    }

    it("sends nothing on a sentence end, on the size cap or on the idle timer, and everything at end()", () => {
      const { buf, out } = whole();
      const answer = `${"Prima frase della risposta, abbastanza lunga da contare. ".repeat(40)}Ultima frase.`;
      for (let i = 0; i < answer.length; i += 50) buf.push(answer.slice(i, i + 50));
      vi.advanceTimersByTime(60_000);
      expect(answer.length).toBeGreaterThan(2000);
      expect(out).toEqual([]);
      buf.end();
      expect(out).toEqual([answer]);
    });

    it("sends what it holds on flush(), and what comes after on the next flush()", () => {
      const { buf, out } = whole();
      buf.push("Un attimo, controllo la tua agenda.");
      buf.flush();
      expect(out).toEqual(["Un attimo, controllo la tua agenda."]);
      buf.flush();
      expect(out).toHaveLength(1);
      buf.push("Domani hai due riunioni.");
      buf.end();
      expect(out).toEqual(["Un attimo, controllo la tua agenda.", "Domani hai due riunioni."]);
    });

    it("judges a flush for a hold, and keeps the held text for release()", () => {
      const { buf, out, kept } = whole((piece) => {
        const m = /^HOLD$/m.exec(piece);
        return m ? m.index : -1;
      });
      buf.push("before the hold.\nHOLD\nkept.");
      buf.flush();
      expect(out).toEqual(["before the hold."]);
      buf.flush();
      expect(kept).toEqual([]);
      buf.release();
      expect(kept).toEqual(["HOLD\nkept."]);
    });
  });

  it("flush() on a streaming buffer sends a partial sentence before its idle timer", () => {
    const out: string[] = [];
    const buf = new StreamBuffer({ onFlush: (s) => out.push(s), idleMs: 500 });
    buf.push("partial sentence without terminator");
    buf.flush();
    expect(out).toEqual(["partial sentence without terminator"]);
    vi.advanceTimersByTime(1000);
    expect(out).toHaveLength(1);
  });

  describe("a hold", () => {
    // Stands in for the caller's rule: hold from the first line reading HOLD.
    const holdFrom = (piece: string) => {
      const m = /^HOLD$/m.exec(piece);
      return m ? m.index : -1;
    };

    function held() {
      const out: string[] = [];
      const kept: string[] = [];
      const buf = new StreamBuffer({
        onFlush: (s) => out.push(s),
        onHeld: (s) => kept.push(s),
        holdFrom,
        sentenceMinChars: 20,
        maxChars: 1800,
        idleMs: 500,
      });
      return { buf, out, kept };
    }

    it("flushes what comes before it and keeps the rest, pieces joined as they were pushed", () => {
      const { buf, out, kept } = held();
      buf.push("this part goes out as usual.\nHOLD\nfirst line.\n");
      buf.push("\n  second line, indented.\n");
      expect(out).toEqual(["this part goes out as usual."]);
      expect(kept).toEqual([]);
      buf.end();
      // The blank line and the indent between the two pushes survive: a line
      // start is what the caller's judgement reads.
      expect(kept).toEqual(["HOLD\nfirst line.\n\n  second line, indented."]);
      expect(out).toEqual(["this part goes out as usual."]);
    });

    it("is not ended by the size cap or the idle timer", () => {
      const { buf, out, kept } = held();
      buf.push("HOLD\nsomething to keep.\n");
      buf.push("x".repeat(2000));
      vi.advanceTimersByTime(5_000);
      expect(out).toEqual([]);
      expect(kept).toEqual([]);
      buf.end();
      expect(kept).toHaveLength(1);
      expect(kept[0]).toMatch(/^HOLD\nsomething to keep\.\nx{2000}$/);
    });

    it("hands the held text over on release() and then streams as before", () => {
      const { buf, out, kept } = held();
      buf.push("HOLD\nkept until released.\n");
      buf.release();
      expect(kept).toEqual(["HOLD\nkept until released."]);
      buf.push("after the release this flushes normally. ");
      // Held for the next words, as every sentence is now.
      expect(out).toEqual([]);
      buf.push("E questa la fa uscire.");
      expect(out).toEqual(["after the release this flushes normally."]);
      buf.end();
      expect(kept).toHaveLength(1);
    });

    it("judges the last piece at end() too", () => {
      const { buf, out, kept } = held();
      buf.push("short\nHOLD");
      buf.end();
      expect(out).toEqual(["short"]);
      expect(kept).toEqual(["HOLD"]);
    });

    it("hands held text to onFlush when no onHeld is given", () => {
      const out: string[] = [];
      const buf = new StreamBuffer({ onFlush: (s) => out.push(s), holdFrom, sentenceMinChars: 20 });
      buf.push("HOLD\nall of this is one piece.\n");
      buf.push("and so is this.\n");
      buf.end();
      expect(out).toEqual(["HOLD\nall of this is one piece.\nand so is this."]);
    });
  });
});

// A reply that names a file ends on its attach marker, and the marker holds a
// dot, the one before the file's extension. No flush may cut there, and no
// flush may split the sentence before the marker from the marker: the two leave
// as one piece, so the file always follows the words that introduce it.
describe("StreamBuffer and the attach marker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const SENTENCE =
    "Ho preparato il riepilogo di ottobre, con le ore per progetto, le note del cliente e le scadenze del mese, ";
  const HEAD = `${SENTENCE}${SENTENCE}come mi avevi chiesto per la riunione di lunedì.`;
  const MARKER = "[[attach: outputs/riepilogo-ottobre.pdf]]";

  /** Every piece holds as many `[[` as `]]`: no marker was cut in two. */
  const whole = (pieces: string[]) => {
    for (const p of pieces) expect(p.split("[[").length).toBe(p.split("]]").length);
  };

  it("cuts before a marker that arrives open, not at the dot of its extension", () => {
    expect(HEAD.length).toBeGreaterThan(200);
    const out: string[] = [];
    const buf = new StreamBuffer({ onFlush: (s) => out.push(s) });
    buf.push(`${HEAD} [[attach: outputs/riepilogo-ottobre.`);
    buf.push("pdf]]");
    buf.end();
    whole(out);
    // The sentence and the marker are one piece: no cut, and no split between
    // the words and the file they introduce.
    expect(out).toEqual([`${HEAD} ${MARKER}`]);
  });

  it("does not cut at a dot inside a marker that is already closed", () => {
    const out: string[] = [];
    const buf = new StreamBuffer({ onFlush: (s) => out.push(s) });
    buf.push(`${HEAD} ${MARKER} e la versione modificabile`);
    buf.end();
    whole(out);
    expect(out).toEqual([`${HEAD} ${MARKER} e la versione modificabile`]);
  });

  it("keeps a marker still being written out of the idle flush, and sends it whole once it closes", () => {
    const out: string[] = [];
    const buf = new StreamBuffer({ onFlush: (s) => out.push(s), idleMs: 500 });
    buf.push("Eccolo: [[attach: outputs/riepilogo-otto");
    vi.advanceTimersByTime(600);
    // The words before the open marker wait for the marker's tail, so the two
    // can leave as one piece.
    expect(out).toEqual([]);
    buf.push("bre.pdf]]");
    buf.end();
    whole(out);
    expect(out).toEqual([`Eccolo: ${MARKER}`]);
  });

  it("keeps a marker still being written out of the size cap", () => {
    const out: string[] = [];
    const buf = new StreamBuffer({ onFlush: (s) => out.push(s), sentenceMinChars: 1_000_000, maxChars: 300 });
    const words = "parola ".repeat(50).trimEnd();
    buf.push(`${words} [[attach: outputs/riepilogo-ottobre.`);
    buf.push("pdf]]");
    buf.end();
    whole(out);
    expect(out).toEqual([words, MARKER]);
  });

  it("sends the whole reply when its only sentence end is inside the marker", () => {
    const out: string[] = [];
    const buf = new StreamBuffer({ onFlush: (s) => out.push(s), idleMs: 500 });
    const words = `${"ecco il file che mi hai chiesto con tutti i dettagli del mese ".repeat(4)}eccolo:`;
    buf.push(`${words} [[attach: outputs/riepilogo-ottobre.`);
    buf.push("pdf]]");
    vi.advanceTimersByTime(600);
    whole(out);
    expect(out).toEqual([`${words} ${MARKER}`]);
  });

  it("lets a [[ that never closes on its line stream as text", () => {
    const out: string[] = [];
    const buf = new StreamBuffer({ onFlush: (s) => out.push(s), sentenceMinChars: 20 });
    buf.push("Scrivo [[ come simbolo.\nE la frase dopo arriva da sola.\n");
    buf.end();
    expect(out).toEqual(["Scrivo [[ come simbolo.\nE la frase dopo arriva da sola."]);
  });
});

// The sentence that introduces a file ends on its full stop, and the marker for
// the file arrives in the pushes after it. A boundary flush that went out at the
// full stop would leave the marker alone in the next piece, and the file would
// follow the words with no sentence to introduce it. The piece a flush would
// send is held for the next words instead, so that a marker can join the
// sentence it belongs to.
describe("StreamBuffer and the sentence before a marker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const MARKER = "[[attach: outputs/prova.pdf]]";
  const PARAGRAPH =
    "Ho preparato il riepilogo di ottobre con le ore per progetto, le note del cliente e le scadenze del mese, " +
    "e l'ho ricontrollato voce per voce prima della riunione di lunedì, così da poter rispondere a ogni domanda " +
    "del team con i numeri aggiornati e le differenze rispetto al mese scorso, e adesso te lo mando come allegato.";

  it("sends the last sentence and its marker as one piece when the model streams them in separate pushes", () => {
    const out: string[] = [];
    const buf = new StreamBuffer({ onFlush: (s) => out.push(s) });
    // A few words a push, the way a model streams: the full stop and the marker
    // fall in different pushes, which is where the file used to lose its words.
    for (const part of `${PARAGRAPH} ${MARKER}`.match(/\S+\s*/g) ?? []) buf.push(part);
    buf.end();
    expect(out).toEqual([`${PARAGRAPH} ${MARKER}`]);
  });

  it("flushes a held sentence as soon as the next words are prose, not a marker", () => {
    const out: string[] = [];
    const buf = new StreamBuffer({ onFlush: (s) => out.push(s), sentenceMinChars: 20, idleMs: 500 });
    buf.push("Questa è una frase abbastanza lunga. ");
    // Held for the next words, which may be the marker of the file it names.
    expect(out).toEqual([]);
    buf.push("E poi arriva dell'altro testo, senza alcun allegato.");
    expect(out).toEqual(["Questa è una frase abbastanza lunga."]);
  });

  it("flushes a held sentence when the ceiling passes with nothing new", () => {
    const out: string[] = [];
    const buf = new StreamBuffer({ onFlush: (s) => out.push(s), sentenceMinChars: 20, idleMs: 500 });
    buf.push("Questa è una frase abbastanza lunga. ");
    expect(out).toEqual([]);
    // The idle timer no longer sends it: the hold ceiling does, and no later.
    vi.advanceTimersByTime(MARKER_HOLD_MS - 1);
    expect(out).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(out).toEqual(["Questa è una frase abbastanza lunga."]);
  });
});

// A sentence can end just before a closing mark that arrives in a later push:
// the bracket of a parenthetical, a quotation mark, a markdown emphasis run. The
// sentence and the mark must leave as one piece, or the person receives the
// closing mark alone as a message of its own. For markdown the damage is worse:
// the emphasis opens in one message and closes in the next, so neither renders.
describe("StreamBuffer and the punctuation that closes a sentence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const FIRST =
    "Ho ricontrollato con calma tutta la tua richiesta e posso confermarti che la modifica è già presente nel ramo di lavoro principale, così non serve rifare nulla da capo e possiamo procedere insieme senza altri intoppi.";
  const SECOND =
    "(Se invece il modo in cui l'ho impostata non ti torna, oppure preferisci un'altra strada per arrivare allo stesso risultato, oppure vuoi che te la mostri prima di andare avanti, dimmelo e la rilancio da lì.";

  /** No piece is made of nothing but punctuation and whitespace. */
  const nonePunctuationOnly = (pieces: string[]) => {
    for (const p of pieces) expect(p).not.toMatch(/^[\s\p{P}\p{S}]+$/u);
  };

  it("sends the sentence and the bracket that closes it as one piece", () => {
    expect(FIRST.length).toBeGreaterThan(200);
    expect(SECOND.length).toBeGreaterThan(200);
    const out: string[] = [];
    const buf = new StreamBuffer({ onFlush: (s) => out.push(s) });
    for (const part of `${FIRST} ${SECOND}`.match(/\S+\s*/g) ?? []) buf.push(part);
    buf.push(")");
    buf.end();
    nonePunctuationOnly(out);
    expect(out).toEqual([FIRST, `${SECOND})`]);
  });

  it("keeps a closer pushed alone with the sentence it closes, then streams on", () => {
    const out: string[] = [];
    const buf = new StreamBuffer({ onFlush: (s) => out.push(s) });
    buf.push(SECOND);
    buf.push(")");
    buf.push(" E poi continuo con il resto.");
    expect(out).toEqual([`${SECOND})`]);
  });

  it("keeps a closer arriving in the same push as the full stop", () => {
    const out: string[] = [];
    const buf = new StreamBuffer({ onFlush: (s) => out.push(s) });
    buf.push(`${SECOND})`);
    buf.push(" E poi continuo con il resto.");
    expect(out).toEqual([`${SECOND})`]);
  });

  it("keeps several closers across pushes with the sentence", () => {
    const out: string[] = [];
    const buf = new StreamBuffer({ onFlush: (s) => out.push(s) });
    buf.push(SECOND);
    buf.push("»");
    buf.push(")");
    buf.end();
    nonePunctuationOnly(out);
    expect(out).toEqual([`${SECOND}»)`]);
  });

  it("keeps a markdown emphasis run that closes after the full stop", () => {
    const out: string[] = [];
    const buf = new StreamBuffer({ onFlush: (s) => out.push(s) });
    buf.push(`**${SECOND}`);
    buf.push("**");
    buf.end();
    nonePunctuationOnly(out);
    expect(out).toEqual([`**${SECOND}**`]);
  });

  it("still sends a sentence held for a closer when the ceiling passes", () => {
    const out: string[] = [];
    const buf = new StreamBuffer({ onFlush: (s) => out.push(s) });
    buf.push(SECOND);
    buf.push(")");
    vi.advanceTimersByTime(MARKER_HOLD_MS);
    expect(out).toEqual([`${SECOND})`]);
  });

  it("flushes a sentence followed by prose as before", () => {
    const out: string[] = [];
    const buf = new StreamBuffer({ onFlush: (s) => out.push(s) });
    buf.push(SECOND);
    buf.push(" E poi continuo con il resto.");
    expect(out).toEqual([SECOND]);
  });

  it("keeps an opening quote after a space with the next sentence", () => {
    const out: string[] = [];
    const buf = new StreamBuffer({ onFlush: (s) => out.push(s) });
    buf.push(SECOND);
    buf.push(' "Ciao", mi ha detto.');
    expect(out).toEqual([SECOND]);
  });

  it("treats punctuation after a line break as the next line", () => {
    const out: string[] = [];
    const buf = new StreamBuffer({ onFlush: (s) => out.push(s) });
    buf.push(`${FIRST}\n`);
    buf.push("* una voce di elenco");
    expect(out).toEqual([FIRST]);
  });
});
