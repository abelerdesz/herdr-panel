# Herdr Panel for Pi

Run several independent Pi agents in parallel Herdr panes, give each agent a different analytical persona, and ask the parent Pi session to synthesize their answers.

The extension is useful for ordinary conversation and research as well as software work. Child agents inherit the parent session's current model and thinking level.

## Requirements

- [Pi](https://pi.dev)
- [Herdr](https://herdr.dev)
- Pi running inside a Herdr-managed pane (`HERDR_ENV=1`)
- The Herdr Pi integration installed and working

Check the integration with:

```bash
herdr integration status
```

## Installation

Put the extension in Pi's global extension directory:

```text
~/.pi/agent/extensions/herdr-panel/
├── index.ts
└── README.md
```

Then start Pi or run:

```text
/reload
```

Pi extensions execute with the user's full system permissions. Review `index.ts` before installing it from an untrusted source.

## Usage

The default panel has three agents and uses the `general` preset:

```text
/herdr-panel Explain whether moral luck is a coherent concept
```

Choose two to four agents by placing the panel size before the prompt:

```text
/herdr-panel 4 Compare the strongest arguments for and against universal basic income
```

Select a preset with `--preset` or `--preset=<name>`:

```text
/herdr-panel --preset research Evaluate the evidence for this claim
/herdr-panel 4 --preset decision Should I rent or buy in this situation?
/herdr-panel --preset=creative Develop distinct campaign directions for this brief
/herdr-panel --preset code Review the authentication architecture in this repository
```

Quotes are not required around prompts entered as Pi slash commands.

List all presets and their personas:

```text
/herdr-panel-presets
```

`/herdr-panel-personas` remains as a compatibility alias that points to the preset command.

## Presets

### `general` (default)

A domain-neutral panel for explanation, analysis, planning, debate, and everyday questions.

Personas:

1. Systematic analyst
2. Adversarial skeptic
3. Pragmatist
4. Alternative-path explorer

Children receive read-only file tools (`read`, `grep`, `find`, and `ls`). Project context files and skills are disabled.

### `research`

Examines evidence quality, methods, competing explanations, and uncertainty.

Personas:

1. Evidence investigator
2. Methodologist
3. Research skeptic
4. Research synthesist

Children receive the same read-only file tools as `general`. Project context files and skills are disabled. This preset does not itself provide web search; it can only use information in the prompt, model knowledge, and readable local files.

### `decision`

Compares options through objectives, risks, stakeholders, and alternatives.

Personas:

1. Decision strategist
2. Risk analyst
3. Stakeholder advocate
4. Constructive contrarian

Children run without tools or project context.

### `creative`

Generates divergent ideas and evaluates audience impact and execution.

Personas:

1. Divergent ideator
2. Audience advocate
3. Craft editor
4. Wild-card creator

Children run without tools or project context.

### `code`

Uses Pi's normal coding environment for repository-aware software analysis.

Personas:

1. Systems architect
2. Adversarial skeptic
3. Delivery pragmatist
4. Correctness reviewer

Children retain Pi's normal tools, skills, extensions, working directory, and project context.

## How it works

For each invocation, the extension:

1. Splits the current Herdr layout into two to four background panes without changing focus.
2. Starts a named Pi agent in each pane.
3. Passes the parent session's exact `provider/model` selection and thinking level to every child.
4. Configures each child with its preset and persona.
5. Submits the same user prompt to all children concurrently.
6. Waits for Herdr to report that each child has settled.
7. Reads each child's final answer from its Pi session, falling back to terminal output when necessary.
8. Sends the collected reports to the parent Pi session for synthesis.

The child panes remain open afterward so their sessions can be inspected or continued manually.

## Model and context behavior

Model inheritance happens when the command starts. For example, if the parent is using `openai-codex/gpt-5.6-sol` with `high` thinking, every child receives that same model and thinking level.

The children do **not** inherit the parent's conversation history. Each child gets an isolated session containing only its system instructions and the panel prompt. This avoids correlated answers caused by shared conversational context while retaining the same model.

The final synthesis happens in the parent session and therefore uses the parent's existing context.

## Limits and operational notes

- Panel size is limited to 2–4 agents.
- Agent startup timeout: 60 seconds.
- Answer timeout: 10 minutes.
- Each report is capped before synthesis to protect the parent context window.
- A panel makes one model run per child plus a parent synthesis run, so cost and rate-limit usage scale with panel size.
- The extension creates panes but does not close them automatically.
- If some agents fail, available reports are still synthesized. If all agents fail, the command reports an error.
- Read-only tools prevent Pi tool-based writes, but extensions execute with normal OS permissions. Only install trusted extensions.

## Development

After editing `index.ts`, reload Pi:

```text
/reload
```

Validate that Pi can load the extension without starting a panel:

```bash
pi --no-extensions \
  -e ~/.pi/agent/extensions/herdr-panel/index.ts \
  --list-models
```

A full test requires launching Pi inside Herdr and incurs model usage.

## Making it portable

This directory is suitable for its own Git repository:

```bash
cd ~/.pi/agent/extensions/herdr-panel
git init
git add index.ts README.md
git commit -m "Add Herdr persona panel extension for Pi"
```

Do not initialize a repository around the entire `~/.pi/agent` directory: it may contain credentials, sessions, settings, and machine-specific state.

For distribution as a Pi package, add a root `package.json` with a Pi extension manifest:

```json
{
  "name": "pi-herdr-panel",
  "version": "0.1.0",
  "private": true,
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./index.ts"]
  }
}
```

Users can then install the repository through Pi's package system or clone/symlink it into their extension directory.
