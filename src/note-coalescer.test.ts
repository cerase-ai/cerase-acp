import { describe, expect, it } from "vitest";
import type { DeliveryResult } from "./chat-adapter.js";
import { isPlatformNote, NoteCoalescer } from "./note-coalescer.js";

// Outcomes of approvals arrive one decision at a time, each as a platform note
// that starts a turn. Five decisions taken while the assistant was answering
// the first used to be five turns, each repeating what was still waiting; the
// notes that arrive while a turn of the same conversation runs now reach the
// assistant together, in one turn.

const note = (n: number) => `[platform_note sig=000000000000000${n}: esito ${n}]\n\nNota della piattaforma: corpo ${n}`;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * A dispatcher stand-in. Every turn it is handed stays running until the test
 * finishes it, and `turnsRunning` answers from those turns, the way the real
 * dispatcher answers from the handleMessage calls it is running.
 */
function fakeTurns() {
  const handled: Array<{ agentId: string; userId: string; text: string; done: Deferred<DeliveryResult> }> = [];
  const running = new Map<string, Set<Promise<DeliveryResult>>>();
  const turns = {
    handleMessage(agentId: string, userId: string, text: string): Promise<DeliveryResult> {
      const done = deferred<DeliveryResult>();
      handled.push({ agentId, userId, text, done });
      const key = `${agentId}:${userId}`;
      const set = running.get(key) ?? new Set();
      running.set(key, set);
      set.add(done.promise);
      const forget = () => set.delete(done.promise);
      done.promise.then(forget, forget);
      return done.promise;
    },
    turnsRunning(agentId: string, userId: string): Promise<void> | null {
      const set = running.get(`${agentId}:${userId}`);
      if (!set || set.size === 0) return null;
      return Promise.allSettled([...set]).then(() => undefined);
    },
  };
  return { turns, handled };
}

/** The handle that ends the `index`th turn the fake was handed. */
function ended(handled: Array<{ done: Deferred<DeliveryResult> }>, index: number): Deferred<DeliveryResult> {
  const turn = handled[index];
  if (!turn) throw new Error(`no turn ${index} was started`);
  return turn.done;
}

/** Let every settled promise run its callbacks. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("NoteCoalescer", () => {
  it("recognises a platform note by the line the platform opens it with, and nothing else", () => {
    expect(isPlatformNote(note(1))).toBe(true);
    expect(isPlatformNote("ciao, mi riassumi la posta?")).toBe(false);
    expect(isPlatformNote(" [platform_note sig=0000000000000001: x]")).toBe(false);
  });

  it("runs a note at once when no turn of the conversation is running", async () => {
    const { turns, handled } = fakeTurns();
    const coalescer = new NoteCoalescer(turns);

    void coalescer.submit("a1", "u1", note(1));

    expect(handled.map((h) => h.text)).toEqual([note(1)]);
  });

  it("gives the notes that arrive while a turn runs one turn, in the order they came", async () => {
    const { turns, handled } = fakeTurns();
    const coalescer = new NoteCoalescer(turns);

    void coalescer.submit("a1", "u1", note(1));
    void coalescer.submit("a1", "u1", note(2));
    void coalescer.submit("a1", "u1", note(3));
    await flush();
    expect(handled).toHaveLength(1);

    ended(handled, 0).resolve({ ok: true });
    await flush();

    expect(handled.map((h) => h.text)).toEqual([note(1), `${note(2)}\n\n${note(3)}`]);
  });

  it("opens the next batch for a note that arrives once the batch's turn has started", async () => {
    const { turns, handled } = fakeTurns();
    const coalescer = new NoteCoalescer(turns);

    void coalescer.submit("a1", "u1", note(1));
    void coalescer.submit("a1", "u1", note(2));
    ended(handled, 0).resolve({ ok: true });
    await flush();
    void coalescer.submit("a1", "u1", note(3));
    void coalescer.submit("a1", "u1", note(4));
    await flush();
    expect(handled.map((h) => h.text)).toEqual([note(1), note(2)]);

    ended(handled, 1).resolve({ ok: true });
    await flush();

    expect(handled.map((h) => h.text)).toEqual([note(1), note(2), `${note(3)}\n\n${note(4)}`]);
  });

  it("waits only for the turns already running, never for one that has not started", async () => {
    // A person's message that arrives after the batch opened goes ahead on its
    // own; the batch is not held back for it.
    const { turns, handled } = fakeTurns();
    const coalescer = new NoteCoalescer(turns);

    void turns.handleMessage("a1", "u1", "prima domanda");
    void coalescer.submit("a1", "u1", note(1));
    void turns.handleMessage("a1", "u1", "seconda domanda");
    ended(handled, 0).resolve({ ok: true });
    await flush();

    expect(handled.map((h) => h.text)).toEqual(["prima domanda", "seconda domanda", note(1)]);
  });

  it("never holds back a message that is not a platform note", async () => {
    const { turns, handled } = fakeTurns();
    const coalescer = new NoteCoalescer(turns);

    void coalescer.submit("a1", "u1", note(1));
    void coalescer.submit("a1", "u1", "un messaggio programmato");
    void coalescer.submit("a1", "u1", "un altro");

    expect(handled.map((h) => h.text)).toEqual([note(1), "un messaggio programmato", "un altro"]);
  });

  it("keeps each conversation's notes to itself", async () => {
    const { turns, handled } = fakeTurns();
    const coalescer = new NoteCoalescer(turns);

    void coalescer.submit("a1", "u1", note(1));
    void coalescer.submit("a1", "u2", note(2));
    void coalescer.submit("a2", "u1", note(3));

    expect(handled.map((h) => [h.agentId, h.userId, h.text])).toEqual([
      ["a1", "u1", note(1)],
      ["a1", "u2", note(2)],
      ["a2", "u1", note(3)],
    ]);
  });

  it("still runs the batch when the turn it waited for failed", async () => {
    const { turns, handled } = fakeTurns();
    const coalescer = new NoteCoalescer(turns);

    const first = coalescer.submit("a1", "u1", note(1));
    void coalescer.submit("a1", "u1", note(2));
    ended(handled, 0).reject(new Error("the turn crashed"));
    await expect(first).rejects.toThrow("the turn crashed");
    await flush();

    expect(handled.map((h) => h.text)).toEqual([note(1), note(2)]);
  });

  it("answers every note in a batch with the batch's outcome", async () => {
    const { turns, handled } = fakeTurns();
    const coalescer = new NoteCoalescer(turns);

    void coalescer.submit("a1", "u1", note(1));
    const second = coalescer.submit("a1", "u1", note(2));
    const third = coalescer.submit("a1", "u1", note(3));
    ended(handled, 0).resolve({ ok: true });
    await flush();
    const failure = { ok: false as const, error: new Error("delivery failed") };
    ended(handled, 1).resolve(failure);

    await expect(second).resolves.toBe(failure);
    await expect(third).resolves.toBe(failure);
  });

  it("runs every note at once with a dispatcher that cannot say whether a turn is running", async () => {
    const handled: string[] = [];
    const coalescer = new NoteCoalescer({
      handleMessage: async (_a: string, _u: string, text: string) => {
        handled.push(text);
        return { ok: true };
      },
    });

    await coalescer.submit("a1", "u1", note(1));
    await coalescer.submit("a1", "u1", note(2));

    expect(handled).toEqual([note(1), note(2)]);
  });
});
