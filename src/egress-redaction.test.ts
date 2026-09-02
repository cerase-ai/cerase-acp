import { describe, expect, it } from "vitest";
import { isInternalSummaryBlock, redactEngineIdentifiers, stripToolCallArtifacts } from "./egress-redaction.js";

describe("M-CONNECTOR-CONNECT-AFFORDANCE-1 Stage 4: DSML tool-call leak scrub", () => {
  it("strips a spelled-out DSML tool_calls block, keeping the surrounding prose", () => {
    const text =
      "Provo a collegare Gmail.\n" +
      "<｜｜DSML｜｜tool_calls>\n" +
      '<｜｜DSML｜｜invoke name="cerase-gateway_call_recipe">\n' +
      '<｜｜DSML｜｜parameter name="args" string="false">{"recipe":"gmail.inbox"}</｜｜DSML｜｜parameter>\n' +
      '<｜｜DSML｜｜parameter name="recipe_name" string="true">account.connect</｜｜DSML｜｜parameter>\n' +
      "</｜｜DSML｜｜invoke>\n" +
      "</｜｜DSML｜｜tool_calls>\n" +
      "Fatto.";
    const out = stripToolCallArtifacts(text);
    expect(out).toContain("Provo a collegare Gmail.");
    expect(out).toContain("Fatto.");
    expect(out).not.toContain("DSML");
    expect(out).not.toContain("account.connect");
    expect(out).not.toContain("｜");
  });

  it("strips the exact leaked sample to nothing user-facing", () => {
    const leak =
      "<｜｜DSML｜｜tool_calls>\n" +
      '<｜｜DSML｜｜invoke name="cerase-gateway_call_recipe">\n' +
      '<｜｜DSML｜｜parameter name="args" string="false">{"recipe":"gmail.label","label":"default"}</｜｜DSML｜｜parameter>\n' +
      '<｜｜DSML｜｜parameter name="recipe_name" string="true">account.connect</｜｜DSML｜｜parameter>\n' +
      "</｜｜DSML｜｜invoke>\n" +
      "</｜｜DSML｜｜tool_calls>\n" +
      "<｜｜DSML｜｜tool_calls>\n" +
      '<｜｜DSML｜｜invoke name="read">\n' +
      '<｜｜DSML｜｜parameter name="filePath" string="true">/home/agent/x.js</｜｜DSML｜｜parameter>\n' +
      "</｜｜DSML｜｜invoke>\n" +
      "</｜｜DSML｜｜tool_calls>";
    expect(stripToolCallArtifacts(leak).trim()).toBe("");
  });

  it("strips an unclosed / truncated DSML block to the end", () => {
    const text = 'Ecco:\n<｜｜DSML｜｜tool_calls>\n<｜｜DSML｜｜invoke name="x">truncated';
    const out = stripToolCallArtifacts(text);
    expect(out.trim()).toBe("Ecco:");
    expect(out).not.toContain("DSML");
  });

  it("leaves normal prose unchanged (idempotent, no false positives)", () => {
    const text = "Ti ho inviato il link per collegare Gmail: aprilo e autorizza.";
    expect(stripToolCallArtifacts(text)).toBe(text);
  });
});

describe("M-AGENT-VOICE-1: egress engine-identity redaction", () => {
  it("never leaves the bare engine name in a reply", () => {
    expect(redactEngineIdentifiers("Giro su OpenCode.")).not.toMatch(/open\s*code/i);
    expect(redactEngineIdentifiers("I run on opencode")).not.toMatch(/open\s*code/i);
    expect(redactEngineIdentifiers("powered by Open Code")).not.toMatch(/open\s*code/i);
  });

  it("replaces the engine name with Cerase", () => {
    expect(redactEngineIdentifiers("Giro su OpenCode.")).toBe("Giro su Cerase.");
  });

  it("scrubs version + config-path + built-in identifiers", () => {
    expect(redactEngineIdentifiers("set OPENCODE_VERSION=1.15.13")).not.toContain("OPENCODE_VERSION");
    expect(redactEngineIdentifiers("edit .opencode/skills/x")).not.toContain(".opencode");
    expect(redactEngineIdentifiers("use the customize-opencode skill")).not.toContain("customize-opencode");
  });

  it("leaves ordinary replies untouched", () => {
    const reply = "Ciao Paolo, ho creato il task e te lo confermo.";
    expect(redactEngineIdentifiers(reply)).toBe(reply);
  });

  it("is idempotent and safe on empty input", () => {
    expect(redactEngineIdentifiers("")).toBe("");
    const once = redactEngineIdentifiers("on OpenCode");
    expect(redactEngineIdentifiers(once)).toBe(once);
  });
});

describe("M-AGENT-SUMMARY-LEAK-1: internal compaction-summary suppression", () => {
  // The actual leaked block: section headers + a masked PII token + paths.
  const summary = [
    "Anchored Summary",
    "The user asked for a story and a plan.",
    "Constraints & Preferences: write in Italian for <nome lfyo>.",
    "Active Tools & State: cerase-tasks idle.",
    "Next Actions: create the project, then the parts.",
    "Technical Notes: PDF render pending.",
    "Workspace Paths & Files: /root/cerase/workspace/story.md",
  ].join("\n\n");

  it("detects the full session-summary block", () => {
    expect(isInternalSummaryBlock(summary)).toBe(true);
  });

  it("detects the block by its title alone (format drift tolerance)", () => {
    expect(isInternalSummaryBlock("Anchored Summary\nshort state dump")).toBe(true);
  });

  it("detects a block missing the title but carrying >=3 section headers", () => {
    const noTitle = "Constraints & Preferences: x\nNext Actions: y\nTechnical Notes: z";
    expect(isInternalSummaryBlock(noTitle)).toBe(true);
  });

  it("never withholds an ordinary reply", () => {
    expect(isInternalSummaryBlock("Ciao Paolo, ho creato il task e te lo confermo.")).toBe(false);
    // A single casual section-like phrase is not enough.
    expect(isInternalSummaryBlock("Le prossime azioni (next actions) sono due.")).toBe(false);
  });

  it("a leaked summary must never reach the user with its PII token", () => {
    // The bug: this block was forwarded verbatim incl. <nome lfyo>. It must be
    // classified as internal (→ the bridge withholds it), so the token is dropped.
    expect(summary).toContain("<nome lfyo>");
    expect(isInternalSummaryBlock(summary)).toBe(true);
  });

  it("is safe on empty/whitespace input", () => {
    expect(isInternalSummaryBlock("")).toBe(false);
    expect(isInternalSummaryBlock("   \n  ")).toBe(false);
  });
});

describe("M-EGRESS-HARDEN-1: provider self-identification + internal artifacts", () => {
  it("redacts a provider self-identification in Italian", () => {
    expect(redactEngineIdentifiers("Sono Claude, come posso aiutarti?")).toBe(
      "Sono un assistente Cerase, come posso aiutarti?",
    );
    expect(redactEngineIdentifiers("Giro su GPT-4.")).toBe("Giro su Cerase.");
    expect(redactEngineIdentifiers("Sono basato su Anthropic.")).toBe("Sono basato su Cerase.");
    expect(redactEngineIdentifiers("Uso il modello DeepSeek.")).toBe("Uso il modello Cerase.");
  });

  it("redacts a provider self-identification in English", () => {
    expect(redactEngineIdentifiers("I'm ChatGPT.")).not.toMatch(/chatgpt/i);
    expect(redactEngineIdentifiers("I'm ChatGPT.")).toContain("a Cerase assistant");
    expect(redactEngineIdentifiers("I run on OpenAI.")).toBe("I run on Cerase.");
    expect(redactEngineIdentifiers("powered by GPT-4o")).toBe("powered by Cerase");
  });

  it("redacts bare internal-infra strings", () => {
    expect(redactEngineIdentifiers("Controlla il .mcp.json del progetto")).not.toContain(".mcp.json");
    expect(redactEngineIdentifiers("Passa per LiteLLM")).not.toMatch(/litellm/i);
    expect(redactEngineIdentifiers("Uso `cerase-search.search` per cercare")).toContain("uno strumento");
    expect(redactEngineIdentifiers("Uso `cerase-search.search` per cercare")).not.toContain("cerase-search.search");
    expect(redactEngineIdentifiers("Chiamo `airtable-power.list_records`")).toContain("uno strumento");
  });

  // ── a delivered file is not a tool ─────────────────────────────────────
  //
  // The recipe rule matched any backticked hyphenated token with a dot, and the
  // shipped skills mandate exactly that shape for the files they produce. A
  // user who asked for a presentation was told, verbatim, "Ecco uno strumento".
  //
  // These nine are not invented: they are the names the shipped skills instruct
  // the assistant to use, taken from `docx`, `deck` and `skill-creator`. They
  // are regression cases, and the property test after them is what survives the
  // skills changing.
  const MANDATED_FILENAMES = [
    "report-q3.docx",
    "summary-q3.md",
    "q3-sales.xlsx",
    "presentation-brief.md",
    "q3-results-presentation.pdf",
    "q3-results-presentation.pptx",
    "web-design-brief.md",
    "web-design-wireframe.md",
    "pending-skill-abc.md",
  ];

  it("keeps every filename the shipped skills tell the assistant to produce", () => {
    for (const name of MANDATED_FILENAMES) {
      const reply = `Ecco \`${name}\` come richiesto.`;
      expect(redactEngineIdentifiers(reply)).toContain(name);
      expect(redactEngineIdentifiers(reply)).not.toContain("uno strumento");
    }
  });

  it("keeps a hyphenated filename for ANY document extension, not only the nine", () => {
    // The property rather than the samples: the skills can add a filename
    // tomorrow and it survives by construction. Extensions are the closed set,
    // which is why the exclusion is written on them and not on the hyphen.
    for (const ext of ["pdf", "docx", "xlsx", "pptx", "md", "csv", "png", "zip", "html"]) {
      const reply = `Trovi \`analisi-primo-trimestre.${ext}\` in allegato.`;
      expect(redactEngineIdentifiers(reply)).toContain(`analisi-primo-trimestre.${ext}`);
    }
  });

  it("still redacts a recipe reference, which is the whole point of the rule", () => {
    // The other half. Without it, "keep everything" would pass the tests above.
    for (const ref of ["cerase-search.search", "airtable-power.list_records", "cerase-media.transcribe"]) {
      const reply = `Chiamo \`${ref}\` adesso.`;
      expect(redactEngineIdentifiers(reply)).toContain("uno strumento");
      expect(redactEngineIdentifiers(reply)).not.toContain(ref);
    }
  });

  it("groups the extension alternation, or a recipe whose method STARTS with one escapes", () => {
    // `(?!pdf|docx|md`)` means "not pdf, not docx, not md-backtick" -- the
    // backtick binds to the last branch only, so the earlier branches match a
    // bare PREFIX. The exclusion then fires on any suffix beginning with an
    // extension, and a real recipe reference survives unredacted.
    //
    // Measured both ways rather than reasoned: the first version of this test
    // asserted the opposite consequence and passed against both spellings,
    // which is how a guard that cannot fail gets written.
    for (const ref of ["cerase-search.mdlist", "cerase-search.csvexport"]) {
      const reply = `Chiamo \`${ref}\` adesso.`;
      expect(redactEngineIdentifiers(reply)).toContain("uno strumento");
      expect(redactEngineIdentifiers(reply)).not.toContain(ref);
    }
  });

  // ── the sweep: every rule against ordinary business language ───────────
  //
  // The filename defect was one rule over-matching, so the other eight were
  // swept the same way -- by running legitimate sentences through them rather
  // than by reading them. These are the ones that come closest to a rule:
  // board language ("le tue task"), an Italian word that contains an English
  // one ("subagente" is a real job), English prose next to a pattern that
  // allows a space, and the phrasing the provider rules react to.
  //
  // A rule added later is swept by adding a sentence here, which is cheaper
  // than reasoning about a regex.
  it("leaves ordinary business language completely alone", () => {
    const corpus = [
      "Ho creato il task per il cliente e l'ho assegnato a Marco.",
      "Le tue task di oggi sono tre, tutte sulla board.",
      "Il subagente assicurativo ci ha mandato la polizza.",
      "Abbiamo aperto il codice sorgente del progetto.",
      "We can open source code from that repository.",
      "Ti allego `report-q3.docx` e `q3-sales.xlsx`.",
      "Il file si chiama `analisi-2026.pdf`, lo trovi in allegato.",
      "La ricetta della nonna prevede due uova.",
      "Ho parlato con Claude, il nostro fornitore, ieri mattina.",
      "Il documento `contratto-quadro.pdf` è pronto per la firma.",
      "Serve un tool per gestire le task del team.",
      "Il modello di contratto è quello standard.",
      "Il progetto è basato su un'idea di Anna.",
      "Trovi tutto in `presentation-brief.md` come da procedura.",
    ];
    for (const line of corpus) {
      expect(redactEngineIdentifiers(line)).toBe(line);
    }
  });

  it("does NOT redact a person named Claude (no self-id context)", () => {
    const reply = "Ho scritto a Claude ieri e mi ha risposto.";
    expect(redactEngineIdentifiers(reply)).toBe(reply);
  });

  it("does NOT redact a cooking recipe or a company mention", () => {
    const recipe = "Ti mando la ricetta della pasta alla carbonara.";
    expect(redactEngineIdentifiers(recipe)).toBe(recipe);
    const news = "OpenAI ha annunciato un nuovo modello la settimana scorsa.";
    expect(redactEngineIdentifiers(news)).toBe(news);
  });

  it("does NOT redact a backticked plain filename", () => {
    const reply = "Il file `report.md` è pronto nel workspace.";
    expect(redactEngineIdentifiers(reply)).toBe(reply);
  });

  it("is idempotent on the new patterns", () => {
    const once = redactEngineIdentifiers("Sono GPT e giro su LiteLLM.");
    expect(redactEngineIdentifiers(once)).toBe(once);
    expect(once).not.toMatch(/\bGPT\b/);
    expect(once).not.toMatch(/litellm/i);
  });
});

describe("M-ASSISTANT-MULTITASK-1: scrub the internal subagent/task primitive", () => {
  it("scrubs bare subagent / sub-agent jargon", () => {
    expect(redactEngineIdentifiers("Avvio un subagent per cercare.")).not.toMatch(/sub-?agent/i);
    expect(redactEngineIdentifiers("Avvio un subagent per cercare.")).toContain("lavoro in parallelo");
    expect(redactEngineIdentifiers("Delego a un sub-agent.")).not.toMatch(/sub-?agent/i);
  });

  it("scrubs the named engine primitive (task tool / task subagent / `task(...)`)", () => {
    expect(redactEngineIdentifiers("Uso il task tool per questo.")).not.toMatch(/task[\s-]?tool/i);
    expect(redactEngineIdentifiers("Lancio un task subagent.")).not.toMatch(/task[\s-]?subagent/i);
    expect(redactEngineIdentifiers("Chiamo `task(general)` adesso.")).not.toContain("`task(");
  });

  it("does NOT scrub the board word 'task' (legitimate user-facing noun)", () => {
    const board = "Ho creato il task e l'ho messo in Fatto.";
    expect(redactEngineIdentifiers(board)).toBe(board);
    const plural = "Ecco le tue task per oggi.";
    expect(redactEngineIdentifiers(plural)).toBe(plural);
  });

  it("is idempotent", () => {
    const once = redactEngineIdentifiers("Avvio un subagent e un task tool.");
    expect(redactEngineIdentifiers(once)).toBe(once);
  });
});

describe("the appliance's own summary sections", () => {
  // Verbatim shape of a block a real assistant put into a customer's chat when
  // asked to join a meeting and send an email. The detector held the engine's
  // section names while SlotWriter::compactionPrompt() had replaced them, so
  // the one form the product asks for was the one it could not recognise.
  const OURS = [
    "## Objective",
    "- L'utente ha chiesto di partecipare a una riunione e di prenderne appunti.",
    "",
    "## Important Details",
    '- La riunione è stata prenotata con titolo "Riunione".',
    "",
    "## Work State",
    "### Completed",
    "- Partecipazione alla riunione tramite il link fornito.",
    "### Blocked",
    "- Trascrizione non disponibile.",
    "",
    "## Next Move",
    "1. (none)",
    "",
    "## Relevant Files",
    "- (none)",
  ].join("\n");

  it("withholds the block the appliance's own prompt asks for", () => {
    expect(isInternalSummaryBlock(OURS)).toBe(true);
  });

  it("still needs corroboration — one section heading is not a summary", () => {
    expect(isInternalSummaryBlock("## Objective\n\nHo scritto a Marta come chiesto.")).toBe(false);
  });

  it("lets an ordinary reply through", () => {
    expect(
      isInternalSummaryBlock(
        "Ho partecipato alla riunione e ti ho mandato il riassunto per email. Fammi sapere se vuoi che aggiunga altro.",
      ),
    ).toBe(false);
  });
});
