---
name: comparative-research
description: "Use when the user needs deep comparative research on competing options (e.g., Samsung vs. iPhone, two technologies, tools, or approaches) to make a fact-based decision. The skill runs subagent research collected in RESEARCH.md, collaborative refinement with the user, user assessment of every pro and con, and a council-reviewed verdict in RESULT.md, with all changes committed in a local-only git repository. All user-facing output (files, messages) is in Russian."
---

# Deep Comparative Research

Conduct deep comparative research on the options the user must choose between, and reach a decision based on facts.

- Record all research in `RESEARCH.md`. Record the final decision in `RESULT.md`.
- Fill `RESEARCH.md` iteratively and interactively: you and the user work on the same file together.
- The working directory must be a local-only git repository (see "Git rules").
- Example topic: choosing what to use, Samsung or iPhone. Expected outcome: an adopted, justified decision in favor of one side.

## Workflow stages

### Stage 1. Initial population

You MUST use subagents — researching both topics is a massive operation.

1. Before starting, launch one subagent to compile a topic outline: a thesis-style list of research subtopics to cover.
2. Launch one subagent per subtopic to research that subtopic in depth.
3. Once all subagents have finished, populate `RESEARCH.md` with the information they provided:
   - one section per option being compared;
   - in each section, write out the pros and the cons;
   - also record the nuances relevant to each option; nuances that apply equally to several options may be consolidated into a single shared section.
   - Include the assessment slot beside every pro and con from this initial population onward (format — see Stage 3).
   - Keep the content structured and compact.
4. Launch an "evidence auditor" subagent to verify all facts in `RESEARCH.md`.
5. If inconsistencies or problems are found, launch another subagent to find up-to-date, verified information and correct the file.
6. Make a git commit for the initial population, and a separate commit for the audit-driven corrections if any were made (see "Git rules" — every change is its own commit).

### Stage 2. Collaboration

Work on `RESEARCH.md` together with the user, iteratively and interactively. The user may ask questions about the file, request changes, or ask you to research specific questions further. Conduct the requested research, then update `RESEARCH.md`. Every change you make to the file is a git commit.

### Stage 3. Assessment

Once the file is formed with all the points, the user goes through every item and marks:

- next to each pro: `важно` / `не важно` — how much that pro matters to the user specifically;
- next to each con: `важно` / `терпимо` / `не важно` — how much that con affects the user.

Generate `RESEARCH.md` pre-formatted so the user can conveniently put an assessment next to every point: an empty checkbox/assessment slot beside every pros/cons bullet, e.g.:

```markdown
## <Option A>

### Pros
- [ ] <pro> — важно / не важно

### Cons
- [ ] <con> — важно / терпимо / не важно

## <Option B>

(same structure)

### Общие нюансы (optional)
- <nuance affecting both options>
```

(The example headers/words above are in Russian because the file is user-facing; option names and content are written in Russian too.)
(Per-option nuances live inside each option's section; only cross-option nuances go here.)

### Stage 4. Result

Based on the user's assessments, form a compact `RESULT.md` containing:

- a "portrait" of the user in the context of this problem: which points are important to the user and which are not;
- your reasoned evaluation and a verdict in favor of one option.

The verdict must be reviewed by a council: 3 subagents (a quorum) that evaluate the user's assessments independently. Run the council BEFORE writing `RESULT.md` — the result file is formed from the conclusions the council reaches, including any dissenting opinions. The quorum must reach a consensus verdict. If some council members disagree with the majority, record their minority opinions in `RESULT.md`: what exactly those members paid attention to and what influenced their final rating.

`RESULT.md` may be discussed with the user. The user may introduce corrections at this stage; accept them. After all corrections and discussions, re-form `RESULT.md` only when the user explicitly requests it. Never rewrite `RESULT.md` on your own initiative.

## Git rules

Follow this contract strictly at every stage.

- The directory in which you work with the `.md` files must be a local git repository not bound to a remote. If the current directory is not a git repository, initialize it yourself.
- Every change you make to files is one git commit, so the change history is tracked. The commit message contains a brief description of the changes, in Russian. Commit on behalf of the agent with an empty email and the name "Research agent", using exactly this command:
  `git -c user.email="" -c user.name="Research agent" commit -m "<msg>"`
- Before every attempt to modify files in the directory, check the state of the repository:
  - If the user made a commit, inspect the diff of that commit.
  - If the user made changes that sit staged or otherwise uncommitted, review the changes and propose that the user commits them — or offer to commit on the user's behalf. If the user agrees to a commit on their behalf, use a plain `git commit -m "<msg>"` (no identity overrides), so the commit is authored by the user's identity from their git config; note in the commit message that it was made on the user's behalf.
- Working with files while the git tree is dirty (there are uncommitted changes) is forbidden, unless the user explicitly allows it.

## Per-stage agent rules

1. Stage 1: always use subagents — one outline subagent first, then one subagent per subtopic, then an evidence auditor, and a correction subagent if the audit finds problems.
2. At every stage, strictly follow the git contract described in "Git rules".
3. The file you generate must be pre-formatted for the user's assessment: an assessment slot next to every pro and con.
4. The review of the user's assessments must be performed by a council: 3 subagents (quorum) with independent evaluation. The verdict must be a consensus, and minority opinions must be recorded in `RESULT.md`.
