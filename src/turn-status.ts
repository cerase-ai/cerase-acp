// The status line of one turn: when it appears, which step it names, and when
// it goes. The channel keeps the message (ChatAdapter.statusLine); this decides
// what happens to it, the same way on every channel.
//
// A person writing to an assistant otherwise hears nothing until the answer,
// however many tools the assistant runs on the way. The bridge sees every tool
// call, so it can say which step is under way whatever the model writes:
//
//   - A turn whose tools all finish within STATUS_AFTER_MS shows nothing.
//   - When a tool has run that long and the turn has no status yet, the status
//     is posted, with the sentence for that tool.
//   - Each tool started after that edits the same message in place, at most
//     once every STATUS_EDIT_EVERY_MS; when steps come faster, the latest one
//     is shown and the ones between are skipped. A step whose input arrives
//     after its start is edited again once the input is known, because the
//     sentence for a recipe depends on which recipe it is.
//   - The turn's end, after its last follow-up, takes it down.
//
// The text is only ever a sentence about the step: the catalogue's, or the
// bridge's plain one when the catalogue cannot answer. What the assistant
// writes never goes into it, and its text, intermediate or final, neither
// creates the status, nor removes it, nor moves it.
//
// ACP reports a tool in two kinds of update: `tool_call` when it starts, whose
// `title` is the tool's name and whose `rawInput` may still be empty, then
// `tool_call_update`s carrying the full input and finally `completed` or
// `failed`, with a `title` of the runtime's own. The name from the start is
// kept, because it is the name the catalogue knows the tool by.

import type { StatusLine } from "./chat-adapter.js";
import { makeLogger } from "./logger.js";
import type { SessionUpdateHandler } from "./session-manager.js";

const logger = makeLogger("cerase-acp.turn-status");

/** How long a tool runs before the turn's status line is posted. */
export const STATUS_AFTER_MS = 4_000;

/** The least time between two edits of a turn's status line. */
export const STATUS_EDIT_EVERY_MS = 1_500;

type Update = Parameters<SessionUpdateHandler>[0];

type ToolInput = Record<string, unknown>;

interface Tool {
  name: string;
  input: ToolInput;
  running: boolean;
  timer?: NodeJS.Timeout;
}

export interface TurnStatusOptions {
  line: StatusLine;
  /**
   * The sentence for a step, from the catalogue. Absent, or rejecting, the
   * line says `fallback`.
   */
  sentence?: (tool: string, input: ToolInput) => Promise<string>;
  /** The bridge's own plain sentence, in the conversation's language. */
  fallback: string;
  /** What every log line of this turn's status carries. */
  context: Record<string, unknown>;
  showAfterMs?: number;
  editEveryMs?: number;
}

export class TurnStatus {
  private readonly tools = new Map<string, Tool>();
  // The tool the line names, or is about to.
  private step: string | undefined;
  // Whether a tool has run long enough for the line to be put up.
  private shown = false;
  private closed = false;
  // What the line says now, so a step with the same sentence costs no edit.
  private text: string | undefined;
  private lastEditAt = Number.NEGATIVE_INFINITY;
  private editTimer: NodeJS.Timeout | undefined;
  private rendering = false;
  private stale = false;
  private warned = false;

  constructor(private readonly opts: TurnStatusOptions) {}

  /** Read one session update of the turn; anything but a tool call is ignored. */
  observe(update: Update): void {
    if (this.closed) return;
    if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") return;
    const u = update as { toolCallId?: string; title?: string | null; status?: string | null; rawInput?: unknown };
    if (!u.toolCallId) return;
    const id = u.toolCallId;
    const input = isToolInput(u.rawInput) ? u.rawInput : undefined;
    const ended = u.status === "completed" || u.status === "failed";
    let tool = this.tools.get(id);
    if (!tool) {
      if (update.sessionUpdate !== "tool_call") return;
      tool = { name: u.title ?? "", input: input ?? {}, running: !ended };
      this.tools.set(id, tool);
      if (!tool.running) return;
      this.step = id;
      if (this.shown) {
        this.refresh();
      } else {
        tool.timer = setTimeout(() => this.ranLong(id), this.opts.showAfterMs ?? STATUS_AFTER_MS);
        tool.timer.unref?.();
      }
      return;
    }
    if (input !== undefined && JSON.stringify(input) !== JSON.stringify(tool.input)) {
      tool.input = input;
      if (this.shown && this.step === id && tool.running && !ended) this.refresh();
    }
    if (ended) {
      tool.running = false;
      clearTimeout(tool.timer);
    }
  }

  /**
   * End the turn's status: no step is shown from now on, and the line is taken
   * down when it was put up. Never rejects.
   */
  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    clearTimeout(this.editTimer);
    for (const tool of this.tools.values()) clearTimeout(tool.timer);
    if (!this.shown) return Promise.resolve();
    return this.opts.line.close().catch((err: unknown) => {
      logger.warn({ ...this.opts.context, err }, "the status line could not be closed");
    });
  }

  private ranLong(id: string): void {
    const tool = this.tools.get(id);
    if (this.closed || this.shown || !tool?.running) return;
    this.shown = true;
    this.step = id;
    this.refresh();
  }

  /** Show the current step now, or as soon as the edit interval allows. */
  private refresh(): void {
    if (this.closed) return;
    if (this.rendering) {
      this.stale = true;
      return;
    }
    if (this.editTimer) return;
    const wait = this.lastEditAt + (this.opts.editEveryMs ?? STATUS_EDIT_EVERY_MS) - Date.now();
    if (wait > 0) {
      this.editTimer = setTimeout(() => {
        this.editTimer = undefined;
        this.render();
      }, wait);
      this.editTimer.unref?.();
      return;
    }
    this.render();
  }

  private render(): void {
    const tool = this.step === undefined ? undefined : this.tools.get(this.step);
    if (this.closed || !tool) return;
    this.rendering = true;
    this.stale = false;
    void (async () => {
      const text = await this.sentenceFor(tool);
      if (this.closed || text === this.text) return;
      this.text = text;
      this.lastEditAt = Date.now();
      await this.opts.line.show(text);
    })()
      .catch((err: unknown) => {
        logger.warn({ ...this.opts.context, err }, "the status line could not be shown");
      })
      .finally(() => {
        this.rendering = false;
        if (this.stale) this.refresh();
      });
  }

  private async sentenceFor(tool: Tool): Promise<string> {
    if (!this.opts.sentence) return this.opts.fallback;
    try {
      return await this.opts.sentence(tool.name, tool.input);
    } catch (err) {
      // Once per turn: a catalogue that is down fails every step alike.
      if (!this.warned) {
        this.warned = true;
        logger.warn(
          { ...this.opts.context, tool: tool.name, reason: err instanceof Error ? err.message : String(err) },
          "no sentence from the catalogue for this step; the status line says the plain one",
        );
      }
      return this.opts.fallback;
    }
  }
}

function isToolInput(value: unknown): value is ToolInput {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
