import { describe, expect, it } from "vitest";
import { advertisedModeIds, CERASE_SESSION_MODE, decideSessionMode } from "./session-mode.js";

// The payloads below are what a running slot answered `session/new` with,
// trimmed to the fields this module reads. Two slots of the same opencode
// build: one the control-plane had rendered, one still free. They are the
// evidence that a missing mode is a fact about the slot rather than noise,
// and they are kept verbatim so a change in what opencode sends breaks a
// test here instead of a session in production.
const RENDERED_SLOT = {
  sessionId: "ses_fe0cdd7a3ffeWzvUPt17uphE6D",
  configOptions: [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "cerase-litellm/spark",
      options: [{ value: "cerase-litellm/spark", name: "Cerase LiteLLM/spark" }],
    },
    {
      id: "mode",
      name: "Session Mode",
      category: "mode",
      type: "select",
      currentValue: "build",
      options: [
        {
          value: "build",
          name: "build",
          description: "The default agent. Executes tools based on configured permissions.",
        },
        { value: "cerase", name: "cerase", description: "Assistente Cerase" },
        { value: "plan", name: "plan", description: "Plan mode. Disallows all edit tools." },
      ],
    },
  ],
};

const FREE_SLOT = {
  sessionId: "ses_fe0cd9f2effeFjHHKi75t72W84",
  configOptions: [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "cerase-litellm/spark",
      options: [{ value: "cerase-litellm/spark", name: "Cerase LiteLLM/spark" }],
    },
    {
      id: "mode",
      name: "Session Mode",
      category: "mode",
      type: "select",
      currentValue: "build",
      options: [
        {
          value: "build",
          name: "build",
          description: "The default agent. Executes tools based on configured permissions.",
        },
        { value: "plan", name: "plan", description: "Plan mode. Disallows all edit tools." },
      ],
    },
  ],
};

describe("advertisedModeIds", () => {
  it("reads the mode selector out of a rendered slot's configOptions", () => {
    expect(advertisedModeIds(RENDERED_SLOT)).toEqual(["build", "cerase", "plan"]);
  });

  it("reads the same selector out of a free slot, which lists two modes", () => {
    expect(advertisedModeIds(FREE_SLOT)).toEqual(["build", "plan"]);
  });

  it("reads the spec's own modes object", () => {
    expect(
      advertisedModeIds({
        modes: {
          currentModeId: "build",
          availableModes: [
            { id: "build", name: "Build" },
            { id: "cerase", name: "Cerase" },
          ],
        },
      }),
    ).toEqual(["build", "cerase"]);
  });

  it("flattens a grouped select, which would otherwise read as no modes at all", () => {
    expect(
      advertisedModeIds({
        configOptions: [
          {
            id: "mode",
            category: "mode",
            type: "select",
            currentValue: "build",
            options: [
              { group: "standard", name: "Standard", options: [{ value: "build", name: "build" }] },
              { group: "custom", name: "Custom", options: [{ value: "cerase", name: "cerase" }] },
            ],
          },
        ],
      }),
    ).toEqual(["build", "cerase"]);
  });

  // The two answers a caller must be able to tell apart. An agent with an
  // empty mode list has a mode system and nothing usable in it; an agent that
  // never mentioned modes has said nothing at all, and treating the second as
  // the first refuses every session against an agent the protocol permits.
  it("answers undefined when nothing about modes was advertised", () => {
    expect(advertisedModeIds({ sessionId: "s" } as never)).toBeUndefined();
    expect(advertisedModeIds({})).toBeUndefined();
    expect(advertisedModeIds(undefined)).toBeUndefined();
  });

  it("answers undefined when configOptions carries no mode selector", () => {
    expect(
      advertisedModeIds({
        configOptions: [{ id: "model", category: "model", type: "select", currentValue: "x", options: [] }],
      }),
    ).toBeUndefined();
  });

  it("answers an empty list when the mode selector offers nothing", () => {
    expect(
      advertisedModeIds({
        configOptions: [{ id: "mode", category: "mode", type: "select", currentValue: "", options: [] }],
      }),
    ).toEqual([]);
  });
});

describe("decideSessionMode", () => {
  it("selects the mode a rendered slot advertises", () => {
    const d = decideSessionMode(RENDERED_SLOT);
    expect(d.outcome).toBe("select");
    expect(d.mode).toBe(CERASE_SESSION_MODE);
  });

  it("reports the mode absent, with what the slot does offer, on a free slot", () => {
    const d = decideSessionMode(FREE_SLOT);
    expect(d.outcome).toBe("absent");
    expect(d).toMatchObject({ mode: CERASE_SESSION_MODE, available: ["build", "plan"] });
  });

  it("reports the question unanswered when the agent advertised no modes", () => {
    expect(decideSessionMode({ sessionId: "s" } as never).outcome).toBe("unannounced");
  });
});
