import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const DEFAULT_PANEL_SIZE = 3;
const MAX_PANEL_SIZE = 4;
const START_TIMEOUT_MS = 60_000;
const SHELL_READY_TIMEOUT_MS = 30_000;
const SHELL_READY_RETRY_MS = 500;
const ANSWER_TIMEOUT_MS = 10 * 60_000;
const MAX_RESULT_CHARS = 24_000;

type Persona = { id: string; label: string; prompt: string };
type PresetName = "general" | "research" | "decision" | "creative" | "code";
type Preset = {
  description: string;
  personas: readonly Persona[];
  systemPrompt?: string;
  tools?: string;
};

const GENERIC_SYSTEM_PROMPT = `You are a capable general-purpose assistant participating in an independent panel. Answer the user's task directly, accurately, and concisely. Follow the assigned persona as an analytical lens rather than as a theatrical character. State important assumptions, distinguish facts from uncertainty, and do not delegate to other agents. Use tools only when they materially improve the answer; never modify files.`;

const PRESETS: Record<PresetName, Preset> = {
  general: {
    description: "Balanced, domain-neutral analysis (default; read-only tools)",
    systemPrompt: GENERIC_SYSTEM_PROMPT,
    tools: "read,grep,find,ls",
    personas: [
      { id: "analyst", label: "Systematic analyst", prompt: "Decompose the question, clarify assumptions, and reason carefully from first principles and available evidence." },
      { id: "skeptic", label: "Adversarial skeptic", prompt: "Challenge assumptions, test claims with counterexamples, and surface uncertainty, blind spots, and failure modes." },
      { id: "pragmatist", label: "Pragmatist", prompt: "Focus on useful conclusions, concrete trade-offs, feasibility, and actions proportionate to the situation." },
      { id: "explorer", label: "Alternative-path explorer", prompt: "Seek overlooked interpretations, unconventional possibilities, and productive reframings without sacrificing rigor." },
    ],
  },
  research: {
    description: "Evidence quality, competing explanations, and synthesis (read-only tools)",
    systemPrompt: `${GENERIC_SYSTEM_PROMPT}\nPrioritize evidence quality, source limitations, and competing explanations. Do not claim to have verified information you could not access.`,
    tools: "read,grep,find,ls",
    personas: [
      { id: "investigator", label: "Evidence investigator", prompt: "Identify the evidence needed, examine available material, and separate observations from inference." },
      { id: "methodologist", label: "Methodologist", prompt: "Evaluate definitions, measurement, causal reasoning, sampling, and the strength of the method behind each claim." },
      { id: "skeptic", label: "Research skeptic", prompt: "Search for confounders, contrary evidence, alternative explanations, and unjustified certainty." },
      { id: "synthesist", label: "Research synthesist", prompt: "Integrate the strongest supported points, map disagreements, and identify what remains unknown." },
    ],
  },
  decision: {
    description: "Options, stakeholders, risks, and decision criteria (no tools)",
    systemPrompt: `${GENERIC_SYSTEM_PROMPT}\nHelp evaluate a decision without pretending that one perspective or value system is universally correct.`,
    personas: [
      { id: "strategist", label: "Decision strategist", prompt: "Define objectives and criteria, compare options, and examine second-order and long-term consequences." },
      { id: "risk", label: "Risk analyst", prompt: "Focus on downside, reversibility, uncertainty, mitigations, and signals that should trigger a change of course." },
      { id: "stakeholder", label: "Stakeholder advocate", prompt: "Examine who benefits, who bears costs, incentives, fairness, and perspectives absent from the framing." },
      { id: "contrarian", label: "Constructive contrarian", prompt: "Challenge the option that initially seems obvious and develop the strongest credible alternative." },
    ],
  },
  creative: {
    description: "Divergent ideas plus audience and craft critique (no tools)",
    systemPrompt: `${GENERIC_SYSTEM_PROMPT}\nGenerate distinctive ideas rather than minor variations. Be imaginative while remaining responsive to the user's constraints.`,
    personas: [
      { id: "divergent", label: "Divergent ideator", prompt: "Generate multiple substantially different directions and explore the conceptual space broadly." },
      { id: "audience", label: "Audience advocate", prompt: "Evaluate emotional resonance, clarity, memorability, accessibility, and likely audience reactions." },
      { id: "craft", label: "Craft editor", prompt: "Improve structure, language, coherence, specificity, and execution while preserving the strongest core idea." },
      { id: "wildcard", label: "Wild-card creator", prompt: "Offer a surprising but defensible direction that breaks the most limiting assumption in the brief." },
    ],
  },
  code: {
    description: "Software architecture, delivery, and correctness (normal Pi tools and project context)",
    personas: [
      { id: "architect", label: "Systems architect", prompt: "Emphasize structure, interfaces, invariants, scalability, and long-term maintainability. Identify hidden coupling and propose coherent designs." },
      { id: "skeptic", label: "Adversarial skeptic", prompt: "Challenge assumptions, search for counterexamples and failure modes, and distinguish evidence from speculation." },
      { id: "pragmatist", label: "Delivery pragmatist", prompt: "Favor simple, testable, incremental solutions. Evaluate implementation cost, operational burden, and what is necessary now." },
      { id: "reviewer", label: "Correctness reviewer", prompt: "Look for bugs, edge cases, security and reliability problems, missing tests, and ambiguous requirements. Rank findings by impact." },
    ],
  },
};

const PRESET_NAMES = Object.keys(PRESETS) as PresetName[];

type ExecResult = { stdout: string; stderr: string; code: number | null };
type PaneRect = { width: number; height: number };

class HerdrCommandError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "HerdrCommandError";
  }
}

function parseArguments(args: string): {
  count: number;
  presetName: PresetName;
  keepPanes: boolean;
  prompt: string;
} {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  let count = DEFAULT_PANEL_SIZE;
  let countSet = false;
  let presetName: PresetName = "general";
  let keepPanes = false;
  const promptTokens: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "--preset") {
      const value = tokens[++i] as PresetName | undefined;
      if (!value || !PRESET_NAMES.includes(value)) throw new Error(`Unknown preset: ${value ?? "(missing)"}`);
      presetName = value;
    } else if (token.startsWith("--preset=")) {
      const value = token.slice("--preset=".length) as PresetName;
      if (!PRESET_NAMES.includes(value)) throw new Error(`Unknown preset: ${value}`);
      presetName = value;
    } else if (token === "--keep-panes") {
      keepPanes = true;
    } else if (/^\d+$/.test(token) && promptTokens.length === 0 && !countSet) {
      count = Number(token);
      countSet = true;
    } else {
      promptTokens.push(token);
    }
  }

  return { count, presetName, keepPanes, prompt: promptTokens.join(" ").trim() };
}

function childPrompt(preset: Preset, persona: Persona): string {
  const personaInstruction = `Your assigned panel lens: ${persona.label}. ${persona.prompt}`;
  return preset.systemPrompt
    ? `${preset.systemPrompt}\n\n${personaInstruction}`
    : `${personaInstruction}\n\nYou are one member of an independent review panel. Answer the user's task directly and do not delegate it to other agents.`;
}

function childPiArgs(preset: Preset, promptPath: string, model: string, thinking: string): string[] {
  const args = ["--model", model, "--thinking", thinking];
  if (preset.systemPrompt) {
    // Pi treats an existing path as prompt-file input. Passing only the path also
    // avoids Herdr rejecting multiline text that cannot be encoded safely by the target shell.
    args.push("--system-prompt", promptPath, "--no-context-files", "--no-skills");
    if (preset.tools) args.push("--tools", preset.tools);
    else args.push("--no-tools");
  } else {
    args.push("--append-system-prompt", promptPath);
  }
  return args;
}

function parseJson(result: ExecResult, operation: string): any {
  if (result.code !== 0) {
    const raw = (result.stderr || result.stdout).trim();
    try {
      const payload = JSON.parse(raw);
      throw new HerdrCommandError(
        `${operation} failed: ${payload?.error?.message ?? raw}`,
        payload?.error?.code,
      );
    } catch (error) {
      if (error instanceof HerdrCommandError) throw error;
      throw new HerdrCommandError(`${operation} failed: ${raw || `exit ${result.code}`}`);
    }
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`${operation} returned invalid JSON: ${result.stdout.slice(0, 500)}`);
  }
}

async function herdr(pi: ExtensionAPI, args: string[], timeout?: number): Promise<any> {
  const result = (await pi.exec("herdr", args, { timeout })) as ExecResult;
  return parseJson(result, `herdr ${args.slice(0, 2).join(" ")}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startAgentWhenShellReady(
  pi: ExtensionAPI,
  args: string[],
): Promise<any> {
  const deadline = Date.now() + SHELL_READY_TIMEOUT_MS;
  while (true) {
    try {
      return await herdr(pi, args, START_TIMEOUT_MS + 10_000);
    } catch (error) {
      if (!(error instanceof HerdrCommandError) || error.code !== "agent_pane_busy" || Date.now() >= deadline) {
        throw error;
      }
      await sleep(SHELL_READY_RETRY_MS);
    }
  }
}

function paneIdFromSplit(response: any): string {
  const id = response?.result?.pane?.pane_id;
  if (typeof id !== "string") throw new Error("Herdr split response did not contain a pane ID");
  return id;
}

function paneRects(response: any): Map<string, PaneRect> {
  const panes = response?.result?.layout?.panes;
  if (!Array.isArray(panes)) return new Map();
  return new Map(
    panes
      .filter((pane: any) => typeof pane?.pane_id === "string" && pane?.rect)
      .map((pane: any) => [pane.pane_id, { width: pane.rect.width, height: pane.rect.height }]),
  );
}

function extractSessionPath(response: any): string | undefined {
  const session = response?.result?.agent?.agent_session;
  return session?.kind === "path" && typeof session?.value === "string" ? session.value : undefined;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("\n");
}

async function lastAssistantText(sessionPath: string): Promise<string> {
  const source = await readFile(sessionPath, "utf8");
  const entries = source
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return undefined;
      }
    });

  for (let i = entries.length - 1; i >= 0; i--) {
    const message = entries[i]?.type === "message" ? entries[i].message : undefined;
    if (message?.role !== "assistant") continue;
    const text = textFromContent(message.content).trim();
    if (text) return text;
  }
  return "";
}

function cap(text: string): string {
  return text.length <= MAX_RESULT_CHARS
    ? text
    : `${text.slice(0, MAX_RESULT_CHARS)}\n\n[Result truncated by herdr-panel]`;
}

async function fallbackTerminalText(pi: ExtensionAPI, agentName: string): Promise<string> {
  const response = await herdr(pi, [
    "agent",
    "read",
    agentName,
    "--source",
    "recent-unwrapped",
    "--lines",
    "200",
    "--format",
    "text",
  ]);
  const candidates = [
    response?.result?.output,
    response?.result?.text,
    response?.result?.content,
    response?.result?.snapshot?.text,
  ];
  return candidates.find((value) => typeof value === "string") ?? JSON.stringify(response.result);
}

async function collectAnswer(pi: ExtensionAPI, agentName: string): Promise<string> {
  const info = await herdr(pi, ["agent", "get", agentName]);
  const sessionPath = extractSessionPath(info);
  if (sessionPath) {
    try {
      const answer = await lastAssistantText(sessionPath);
      if (answer) return answer;
    } catch {
      // Fall back to terminal output when the session is unavailable or not yet flushed.
    }
  }
  return fallbackTerminalText(pi, agentName);
}

function synthesisPrompt(
  originalPrompt: string,
  model: string,
  presetName: PresetName,
  results: Array<{ persona: Persona; agentName: string; answer: string }>,
): string {
  const reports = results
    .map(
      ({ persona, agentName, answer }) =>
        `## ${persona.label} (${agentName})\n\n${cap(answer) || "(no answer captured)"}`,
    )
    .join("\n\n---\n\n");

  return [
    `The Herdr ${presetName} panel answered the same prompt in parallel using ${model} with distinct personas.`,
    "Synthesize their reports into one direct answer to my original prompt. Preserve important disagreements instead of forcing consensus, remove duplication, and mention which persona raised a point only when attribution is useful.",
    `\nOriginal prompt:\n${originalPrompt}`,
    `\nPanel reports:\n\n${reports}`,
  ].join("\n");
}

async function createPanel(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID) {
    ctx.ui.notify("herdr-panel requires Pi to be running inside a Herdr pane", "error");
    return;
  }

  let parsed: ReturnType<typeof parseArguments>;
  try {
    parsed = parseArguments(args);
  } catch (error) {
    ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    return;
  }
  const { count, presetName, keepPanes, prompt } = parsed;
  const preset = PRESETS[presetName];
  if (!prompt) {
    ctx.ui.notify("Usage: /herdr-panel [2-4] [--preset <name>] [--keep-panes] <prompt>", "warning");
    return;
  }
  if (!Number.isInteger(count) || count < 2 || count > MAX_PANEL_SIZE) {
    ctx.ui.notify(`Panel size must be between 2 and ${MAX_PANEL_SIZE}`, "error");
    return;
  }
  if (!ctx.model) {
    ctx.ui.notify("No active Pi model is available to inherit", "error");
    return;
  }

  await ctx.waitForIdle();

  const rootPane = process.env.HERDR_PANE_ID;
  const model = `${ctx.model.provider}/${ctx.model.id}`;
  const thinking = ctx.thinkingLevel;
  const suffix = Date.now().toString(36).slice(-5);
  const selected = preset.personas.slice(0, count);
  const paneIds: string[] = [];
  const closedPaneIds = new Set<string>();
  let promptDir: string | undefined;

  ctx.ui.setStatus("herdr-panel", `creating ${count} agents…`);
  try {
    for (let i = 0; i < count; i++) {
      // Fill a small grid instead of repeatedly splitting the newest (and smallest) pane.
      const target = i < 2 ? rootPane : paneIds[i - 2];
      const layout = await herdr(pi, ["pane", "layout", "--pane", target]);
      const rect = paneRects(layout).get(target);
      const direction = rect && rect.width >= 90 && rect.width >= rect.height * 2 ? "right" : "down";
      const split = await herdr(pi, [
        "pane",
        "split",
        "--pane",
        target,
        "--direction",
        direction,
        "--cwd",
        ctx.cwd,
        "--no-focus",
      ]);
      const paneId = paneIdFromSplit(split);
      paneIds.push(paneId);
    }

    promptDir = await mkdtemp(join(tmpdir(), "herdr-panel-"));
    const agents = await Promise.all(
      selected.map(async (persona, index) => {
        const promptPath = join(promptDir!, `${persona.id}.md`);
        await writeFile(promptPath, childPrompt(preset, persona), { encoding: "utf8", mode: 0o600 });
        return {
          persona,
          promptPath,
          paneId: paneIds[index],
          agentName: `panel-${persona.id}-${suffix}`,
        };
      }),
    );

    ctx.ui.setStatus("herdr-panel", `starting ${count} × ${ctx.model.id}…`);
    await Promise.all(
      agents.map(({ promptPath, paneId, agentName }) =>
        startAgentWhenShellReady(
          pi,
          [
            "agent",
            "start",
            agentName,
            "--kind",
            "pi",
            "--pane",
            paneId,
            "--timeout",
            String(START_TIMEOUT_MS),
            "--",
            ...childPiArgs(preset, promptPath, model, thinking),
          ],
        ),
      ),
    );

    let finishedCount = 0;
    const updateProgress = () => {
      const workingCount = count - finishedCount;
      ctx.ui.setStatus(
        "herdr-panel",
        workingCount > 0
          ? `${workingCount} agent${workingCount === 1 ? "" : "s"} working · ${finishedCount}/${count} finished`
          : `${finishedCount}/${count} agents finished`,
      );
    };
    updateProgress();

    const settled = await Promise.allSettled(
      agents.map(async ({ persona, agentName, paneId }) => {
        try {
          await herdr(
            pi,
            ["agent", "prompt", agentName, prompt, "--wait", "--timeout", String(ANSWER_TIMEOUT_MS)],
            ANSWER_TIMEOUT_MS + 10_000,
          );
          return { persona, agentName, answer: await collectAnswer(pi, agentName) };
        } finally {
          finishedCount += 1;
          updateProgress();
          if (!keepPanes) {
            try {
              await herdr(pi, ["pane", "close", paneId]);
              closedPaneIds.add(paneId);
            } catch {
              // A user may already have closed the pane; outer cleanup gets one final chance.
            }
          }
        }
      }),
    );

    const results = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    const failed = agents.filter((_, index) => settled[index].status === "rejected");
    if (results.length === 0) {
      throw new Error(`All panel agents failed to settle: ${failed.map((agent) => agent.agentName).join(", ")}`);
    }

    if (failed.length > 0) {
      ctx.ui.notify(`Panel completed with ${failed.length} failed agent(s): ${failed.map((a) => a.agentName).join(", ")}`, "warning");
    }

    const paneMessage = keepPanes ? "; child panes remain open" : "; child panes closed";
    ctx.ui.notify(`Collected ${results.length}/${count} panel reports${paneMessage}`, "info");
    pi.sendUserMessage(synthesisPrompt(prompt, model, presetName, results));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`herdr-panel failed: ${message}`, "error");
  } finally {
    if (!keepPanes) {
      await Promise.allSettled(
        paneIds
          .filter((paneId) => !closedPaneIds.has(paneId))
          .map(async (paneId) => {
            await herdr(pi, ["pane", "close", paneId]);
            closedPaneIds.add(paneId);
          }),
      );
    }
    if (promptDir) await rm(promptDir, { recursive: true, force: true }).catch(() => undefined);
    ctx.ui.setStatus("herdr-panel", undefined);
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("herdr-panel", {
    description: "Run a general, research, decision, creative, or code persona panel in Herdr panes",
    handler: async (args, ctx) => createPanel(args, ctx, pi),
  });

  pi.registerCommand("herdr-panel-presets", {
    description: "List /herdr-panel presets and personas",
    handler: async (_args, ctx) => {
      const summary = PRESET_NAMES.map((name) => {
        const preset = PRESETS[name];
        return `${name}: ${preset.description}\n  ${preset.personas.map((persona) => persona.label).join(", ")}`;
      }).join("\n\n");
      ctx.ui.notify(summary, "info");
    },
  });

  pi.registerCommand("herdr-panel-personas", {
    description: "Alias for /herdr-panel-presets",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Use /herdr-panel-presets to list all presets and personas", "info");
    },
  });
}
