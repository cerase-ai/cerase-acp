import type * as acp from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { decidePermissionOutcome } from "./permission-policy.js";

const mkReq = (opts: { kind: string; optionId: string; name?: string }[]): acp.RequestPermissionRequest =>
  ({
    sessionId: "ses_test",
    toolCall: {
      toolCallId: "tc_test",
      title: "test",
      kind: "read",
      status: "pending",
    } as unknown as acp.ToolCall,
    options: opts.map((o) => ({
      kind: o.kind as acp.PermissionOptionKind,
      optionId: o.optionId,
      name: o.name ?? o.kind,
    })),
  }) as unknown as acp.RequestPermissionRequest;

describe("decidePermissionOutcome", () => {
  it("prefers allow_always when offered", () => {
    const req = mkReq([
      { kind: "reject_once", optionId: "r1" },
      { kind: "allow_once", optionId: "a1" },
      { kind: "allow_always", optionId: "a2" },
    ]);
    const outcome = decidePermissionOutcome(req);
    expect(outcome).toEqual({ outcome: "selected", optionId: "a2" });
  });

  it("falls back to allow_once when allow_always missing", () => {
    const req = mkReq([
      { kind: "reject_once", optionId: "r1" },
      { kind: "allow_once", optionId: "a1" },
    ]);
    const outcome = decidePermissionOutcome(req);
    expect(outcome).toEqual({ outcome: "selected", optionId: "a1" });
  });

  it("returns cancelled when only reject options offered (defensive)", () => {
    const req = mkReq([
      { kind: "reject_once", optionId: "r1" },
      { kind: "reject_always", optionId: "r2" },
    ]);
    expect(decidePermissionOutcome(req)).toEqual({ outcome: "cancelled" });
  });

  it("returns cancelled when options list is empty", () => {
    const req = mkReq([]);
    expect(decidePermissionOutcome(req)).toEqual({ outcome: "cancelled" });
  });

  it("ignores options of unknown kind", () => {
    const req = mkReq([
      { kind: "unknown_future_kind", optionId: "x" },
      { kind: "allow_once", optionId: "a1" },
    ]);
    expect(decidePermissionOutcome(req)).toEqual({ outcome: "selected", optionId: "a1" });
  });
});
