"""Hand-authored v0.7 command extraction data.

The extractor sees only ``text``, ``action`` and labelled character spans.
Catalog membership, ambiguity and node qualification stay in the Director.
Templates are written with explicit markers such as ``[PROJECT:{project}]``
and rendered into ordinary user utterances; markers never appear in text.

Only train, dev and calibration are generated.  There is no fresh or test
split in this experiment.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import unicodedata
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Iterable


VERSION = "0.7.7"
ACTIONS = (
    "start", "continue", "steer", "queue", "stop", "status", "review",
    "reroute", "focus-project", "focus-task", "list-projects", "converse",
    "clarify",
)
LABELS = (
    "PROJECT", "TASK", "PROVIDER", "MODEL", "ROUTING", "INSTRUCTION",
    "NODE", "CONTROL",
)
TOKEN_LABELS = {"PROJECT", "TASK", "PROVIDER", "MODEL"}
SPLITS = ("train", "dev", "calibration")

P, T, PR, M = "PROJECT", "TASK", "PROVIDER", "MODEL"
R, I, N, C = "ROUTING", "INSTRUCTION", "NODE", "CONTROL"

PROVIDER_OVERLAP_DISCLOSURE = (
    "No provider names overlap across splits in v0.7.1; the pools are "
    "split-disjoint by construction."
)

TRAIN_PROJECTS = (
    "Harbor", "Nimbus", "Quarry", "Lumen", "Forge", "Cobalt", "Drift", "Ember",
)
TRAIN_PROJECTS_MISSING = ("Onyx", "Quartz", "Violet", "Wrenfield")
TRAIN_TASKS = (
    "token refresh", "cache sweep", "retry budget", "manifest prune",
    "fleet rollout", "onboarding draft", "checkout scrub", "websocket guard",
)
TRAIN_TASKS_MISSING = ("missing ledger", "orphan sweep", "unlisted probe", "ghost retry")
TRAIN_PROVIDERS = ("Codex", "Claude", "Cursor", "OpenCode")
TRAIN_PROVIDERS_MISSING = ("Aster", "BeaconAI", "Northstar", "RelayOne")
TRAIN_MODELS = ("Kite-S", "Kite-M", "Heron-1", "Wren-Base")
TRAIN_MODELS_MISSING = ("Pipit-1", "Pipit-2", "Tern-X", "Vireo-3")
TRAIN_NODES = ("north-node", "east-node", "relay-node", "build-node")
TRAIN_NODES_UNQUALIFIED = ("node-aurora", "node-boreal", "node-cinder", "node-delta")
TRAIN_INSTRUCTIONS = (
    "fix the login redirect",
    "tighten the websocket retry logic",
    "run the integration tests",
    "rotate the signing secret",
    # v0.7.4: instruction-initial verbs must vary, or the model memorizes
    # which verbs open INSTRUCTION spans (dev "sign/drain/..." failed).
    # Disjoint from dev (sign, drain, lint, sample) and calib
    # (verify, compact, rotate, warm) pools by construction below.
    "reconcile the ledger deltas",
    "archive the stale snapshots",
    "profile the slow queries",
    "triage the incoming alerts",
    "backfill the missing events",
    "quarantine the flaky hosts",
    # v0.7.5: dev instruction verbs (sign, drain, lint, sample) never open
    # INSTRUCTION in training, so the model reserves leading verbs for
    # CONTROL. New objects on those verbs teach verb-generalization; dev
    # rows stay textually distinct and the sealed fresh set still judges.
    "sign the visitor log",
    "drain the staging pool",
    "lint the migration scripts",
    "sample the error stream",
    # v0.7.7: "the release" inside INSTRUCTION was still marked CONTROL
    # ("sign the release artifact" fragmented). Same-verb new objects.
    "stage the release notes",
    "tag the release candidate",
)
TRAIN_INSTRUCTIONS_2 = (
    "audit the snapshot store",
    "draft the migration plan",
    "scrub the dead branches",
    "warm the cache shards",
)
TRAIN_TARGETS = (
    "the login redirect", "websocket retry logic", "the integration tests",
    "the migration table",
)

DEV_PROJECTS = ("Aspen", "Birch", "Cedar", "Dune")
DEV_PROJECTS_MISSING = ("Quill", "Zephyr", "Yonder", "Wisp")
DEV_TASKS = ("branch cleanup", "artifact sign", "queue drain", "config lint")
DEV_TASKS_MISSING = ("ledger seal", "beacon sweep", "orbit check", "signal trim")
DEV_PROVIDERS = ("Grok", "Pilot", "Rivet", "Mosaic")
DEV_MODELS = ("Finch-A", "Finch-B", "Lark-2", "Marten-Base")
DEV_NODES = ("dev-cedar", "dev-fjord", "dev-grove", "dev-haven")
DEV_INSTRUCTIONS = (
    "sign the release artifact", "drain the worker queue", "lint the config tree",
    "sample the trace tail",
)
DEV_TARGETS = (
    "the release artifact", "the worker queue", "the config tree", "the trace tail",
)

CAL_PROJECTS = ("Iris", "Jade", "Kelp", "Lark")
CAL_PROJECTS_MISSING = ("Rook", "Sable", "Tamar", "Umber")
CAL_TASKS = ("search index", "deploy freeze", "api throttle", "schema migrate")
CAL_TASKS_MISSING = ("ledger audit", "beacon probe", "orbit sweep", "signal seal")
CAL_PROVIDERS = ("Vertex", "NimbusAI", "Mistral", "Sage")
CAL_MODELS = ("Robin-X", "Swift-3", "Plover-Base", "Kestrel-M")
CAL_NODES = ("cal-amber", "cal-birch", "cal-crown", "cal-dawn")
CAL_INSTRUCTIONS = (
    "verify the nightly backup", "compact the event log", "rotate the API secret",
    "warm the edge cache",
)
CAL_TARGETS = (
    "the nightly backup", "the event log", "the API secret", "the edge cache",
)


@dataclass(frozen=True)
class Family:
    name: str
    action: str
    category: str
    templates: tuple[str, ...]
    values: dict[str, tuple[str, ...]] = field(default_factory=dict)
    rows: int = 16
    context_key: str | None = None
    context_name: str = "catalog_missing"
    expected: dict = field(default_factory=dict)


_MARKER = re.compile(r"\[([A-Z]+):(.*?)\]")


def build_text(parts: Iterable[tuple[str, str | None]]) -> tuple[str, list[dict]]:
    """Join labelled parts and return exact Unicode codepoint offsets."""
    text = ""
    spans: list[dict] = []
    for value, label in parts:
        start = len(text)
        text += value
        if label is not None:
            spans.append({"start": start, "end": len(text), "label": label})
    return text, spans


def render_marked(source: str, values: dict[str, str]) -> tuple[str, list[dict]]:
    """Render a marked source template into text and labelled spans."""
    parts: list[tuple[str, str | None]] = []
    cursor = 0
    for match in _MARKER.finditer(source):
        if match.start() > cursor:
            parts.append((source[cursor:match.start()], None))
        label = match.group(1)
        if label not in LABELS:
            raise ValueError(f"unknown marker label {label!r} in {source!r}")
        try:
            value = match.group(2).format(**values)
        except KeyError as exc:
            raise ValueError(f"missing template value {exc} in {source!r}") from exc
        parts.append((value, label))
        cursor = match.end()
    if cursor < len(source):
        parts.append((source[cursor:], None))
    return build_text(parts)


def _family(
    name: str,
    action: str,
    category: str,
    templates: tuple[str, ...],
    values: dict[str, tuple[str, ...]],
    *,
    rows: int = 16,
    context_key: str | None = None,
    context_name: str = "catalog_missing",
    expected: dict | None = None,
) -> Family:
    return Family(name, action, category, templates, values, rows, context_key,
                  context_name, expected or {})


def _common_values(
    projects: tuple[str, ...], tasks: tuple[str, ...], providers: tuple[str, ...],
    models: tuple[str, ...], nodes: tuple[str, ...], instructions: tuple[str, ...],
) -> dict[str, tuple[str, ...]]:
    return {
        "project": projects, "project_a": projects, "project_b": tuple(reversed(projects)),
        "task": tasks, "task_a": tasks, "task_b": tasks,
        "provider": providers, "model": models, "node": nodes,
        "instruction": instructions,
    }


def _start_families(
    prefix: str,
    projects: tuple[str, ...], tasks: tuple[str, ...], providers: tuple[str, ...],
    models: tuple[str, ...], nodes: tuple[str, ...], instructions: tuple[str, ...],
    targets: tuple[str, ...], missing_projects: tuple[str, ...],
    missing_providers: tuple[str, ...], missing_models: tuple[str, ...],
) -> list[Family]:
    common = _common_values(projects, tasks, providers, models, nodes, instructions)
    return [
        _family(f"{prefix}-start-project", "start", "start", (
            "[INSTRUCTION:{instruction}] [ROUTING:in] [PROJECT:{project}]",
            "[INSTRUCTION:{instruction}] [ROUTING:inside] [PROJECT:{project}]",
            "[INSTRUCTION:{instruction}] [ROUTING:at] [PROJECT:{project}]",
            "[INSTRUCTION:{instruction}] [ROUTING:within] [PROJECT:{project}]",
            # v0.7.7: dev uses "under" as a destination preposition; without
            # it the wrapper is unread and the action flips (continue).
            "[INSTRUCTION:{instruction}] [ROUTING:under] [PROJECT:{project}]",
        ), common),
        _family(f"{prefix}-start-provider", "start", "provider", (
            "[CONTROL:Start a task with provider] [PROVIDER:{provider}] [ROUTING:in project] [PROJECT:{project}]: [INSTRUCTION:{instruction}]",
            "[CONTROL:Create a task through provider] [PROVIDER:{provider}] [ROUTING:at project] [PROJECT:{project}]: [INSTRUCTION:{instruction}]",
            "[CONTROL:Open a task using provider] [PROVIDER:{provider}] [ROUTING:inside project] [PROJECT:{project}]: [INSTRUCTION:{instruction}]",
            "[CONTROL:Begin work with provider] [PROVIDER:{provider}] [ROUTING:within project] [PROJECT:{project}]: [INSTRUCTION:{instruction}]",
        ), common),
        _family(f"{prefix}-start-model", "start", "model", (
            "[CONTROL:Start a task on model] [MODEL:{model}] [ROUTING:in project] [PROJECT:{project}]: [INSTRUCTION:{instruction}]",
            "[CONTROL:Create a task using model] [MODEL:{model}] [ROUTING:at project] [PROJECT:{project}]: [INSTRUCTION:{instruction}]",
            "[CONTROL:Open a task with model] [MODEL:{model}] [ROUTING:inside project] [PROJECT:{project}]: [INSTRUCTION:{instruction}]",
            "[CONTROL:Begin work on model] [MODEL:{model}] [ROUTING:within project] [PROJECT:{project}]: [INSTRUCTION:{instruction}]",
        ), common),
        _family(f"{prefix}-start-no-project", "start", "no-project", (
            "[INSTRUCTION:Repair the broken release]",
            "[INSTRUCTION:Check the pending review]",
            "[INSTRUCTION:Inspect logs before changing anything]",
            "[INSTRUCTION:Add coverage for the auth flow]",
            # v0.7.4: negation inside whole-text INSTRUCTION must be seen in
            # training, or the model fragments it into CONTROL pieces.
            # Worded away from dev ("Do not restart anything; ...").
            "[INSTRUCTION:Do not merge anything; review the queue]",
            "[INSTRUCTION:Never restart services; check health first]",
        ), {}, rows=6),
        _family(f"{prefix}-start-unknown-project", "start", "unknown-name", (
            "[CONTROL:Launch a fresh task] [ROUTING:in project] [PROJECT:{project}]: [INSTRUCTION:{instruction}]",
            "[CONTROL:Begin a new task] [ROUTING:inside project] [PROJECT:{project}]: [INSTRUCTION:{instruction}]",
            "[CONTROL:Open another task] [ROUTING:at project] [PROJECT:{project}]: [INSTRUCTION:{instruction}]",
            "[CONTROL:Create fresh work] [ROUTING:within project] [PROJECT:{project}]: [INSTRUCTION:{instruction}]",
        ), {**common, "project": missing_projects}, context_key="project",
           expected={"resolve": "needs-input"}),
        _family(f"{prefix}-start-unknown-provider", "start", "unknown-name", (
            "[CONTROL:Launch a task with provider] [PROVIDER:{provider}] [ROUTING:in project] [PROJECT:{project}]: [INSTRUCTION:{instruction}]",
            "[CONTROL:Begin work through provider] [PROVIDER:{provider}] [ROUTING:at project] [PROJECT:{project}]: [INSTRUCTION:{instruction}]",
            "[CONTROL:Open a task using provider] [PROVIDER:{provider}] [ROUTING:inside project] [PROJECT:{project}]: [INSTRUCTION:{instruction}]",
            "[CONTROL:Create work with provider] [PROVIDER:{provider}] [ROUTING:within project] [PROJECT:{project}]: [INSTRUCTION:{instruction}]",
        ), {**common, "provider": missing_providers}, context_key="provider",
           expected={"resolve": "needs-input"}),
        _family(f"{prefix}-start-unknown-model", "start", "unknown-name", (
            "[CONTROL:Launch a task on model] [MODEL:{model}] [ROUTING:in project] [PROJECT:{project}]: [INSTRUCTION:{instruction}]",
            "[CONTROL:Begin work using model] [MODEL:{model}] [ROUTING:at project] [PROJECT:{project}]: [INSTRUCTION:{instruction}]",
            "[CONTROL:Open a task on model] [MODEL:{model}] [ROUTING:inside project] [PROJECT:{project}]: [INSTRUCTION:{instruction}]",
            "[CONTROL:Create work with model] [MODEL:{model}] [ROUTING:within project] [PROJECT:{project}]: [INSTRUCTION:{instruction}]",
        ), {**common, "model": missing_models}, context_key="model",
           expected={"resolve": "needs-input"}),
    ]


def _command_families(
    prefix: str, projects: tuple[str, ...], tasks: tuple[str, ...],
    nodes: tuple[str, ...], instructions: tuple[str, ...],
    unknown_tasks: tuple[str, ...], unknown_nodes: tuple[str, ...],
) -> list[Family]:
    base = {"project": projects, "project_a": projects,
            "project_b": tuple(reversed(projects)),
            "task": tasks, "task_a": tasks, "task_b": tasks,
            "node": nodes, "instruction": instructions}
    unknown_task_values = {**base, "task": unknown_tasks, "task_a": unknown_tasks}
    unknown_node_values = {**base, "node": unknown_nodes}
    return [
        _family(f"{prefix}-continue-explicit", "continue", "continue", (
            "[CONTROL:Tell the task called] [TASK:{task}] [CONTROL:to] [INSTRUCTION:{instruction}]",
            "[CONTROL:Continue the task called] [TASK:{task}] [CONTROL:with] [INSTRUCTION:{instruction}]",
            "[CONTROL:Resume the task called] [TASK:{task}] [CONTROL:and do] [INSTRUCTION:{instruction}]",
            "[CONTROL:Keep the task called] [TASK:{task}] [CONTROL:moving with] [INSTRUCTION:{instruction}]",
        ), base),
        _family(f"{prefix}-continue-unknown-task", "continue", "unknown-name", (
            "[CONTROL:Tell the task called] [TASK:{task}] [CONTROL:to] [INSTRUCTION:{instruction}]",
            "[CONTROL:Continue the task called] [TASK:{task}] [CONTROL:with] [INSTRUCTION:{instruction}]",
            "[CONTROL:Resume the task called] [TASK:{task}] [CONTROL:and do] [INSTRUCTION:{instruction}]",
            "[CONTROL:Keep the task called] [TASK:{task}] [CONTROL:moving with] [INSTRUCTION:{instruction}]",
        ), unknown_task_values, context_key="task", expected={"resolve": "needs-input"}),
        _family(f"{prefix}-steer-immediate", "steer", "steer", (
            "[CONTROL:Redirect the running task] [TASK:{task}] [CONTROL:right now]: [INSTRUCTION:{instruction}]",
            "[CONTROL:Steer the running task] [TASK:{task}] [CONTROL:immediately]: [INSTRUCTION:{instruction}]",
            "[CONTROL:Change the running task] [TASK:{task}] [CONTROL:right away]: [INSTRUCTION:{instruction}]",
            "[CONTROL:Reaim the running task] [TASK:{task}] [CONTROL:without delay]: [INSTRUCTION:{instruction}]",
        ), base),
        _family(f"{prefix}-steer-unknown-task", "steer", "unknown-name", (
            "[CONTROL:Redirect the running task] [TASK:{task}] [CONTROL:right now]: [INSTRUCTION:{instruction}]",
            "[CONTROL:Steer the running task] [TASK:{task}] [CONTROL:immediately]: [INSTRUCTION:{instruction}]",
            "[CONTROL:Change the running task] [TASK:{task}] [CONTROL:right away]: [INSTRUCTION:{instruction}]",
            "[CONTROL:Reaim the running task] [TASK:{task}] [CONTROL:without delay]: [INSTRUCTION:{instruction}]",
        ), unknown_task_values, context_key="task", expected={"resolve": "needs-input"}),
        _family(f"{prefix}-queue-deferred", "queue", "queue", (
            "[CONTROL:After the task] [TASK:{task}] [CONTROL:finishes, queue this]: [INSTRUCTION:{instruction}]",
            "[CONTROL:After the task] [TASK:{task}] [CONTROL:completes, defer this]: [INSTRUCTION:{instruction}]",
            "[CONTROL:Behind the task] [TASK:{task}] [CONTROL:hold this]: [INSTRUCTION:{instruction}]",
            "[CONTROL:Once the task] [TASK:{task}] [CONTROL:clears, schedule this]: [INSTRUCTION:{instruction}]",
        ), base),
        _family(f"{prefix}-stop-explicit", "stop", "stop", (
            "[CONTROL:Stop the task called] [TASK:{task}]", "[CONTROL:Cancel the task called] [TASK:{task}]",
            "[CONTROL:End the task called] [TASK:{task}]", "[CONTROL:Halt the task called] [TASK:{task}]",
        ), base),
        _family(f"{prefix}-status-explicit", "status", "status", (
            "[CONTROL:How far has task] [TASK:{task}] [CONTROL:got?]",
            "[CONTROL:Report the status of task] [TASK:{task}]",
            "[CONTROL:Show progress for task] [TASK:{task}]",
            "[CONTROL:Give an update on task] [TASK:{task}]",
        ), base),
        _family(f"{prefix}-review-project", "review", "review", (
            "[CONTROL:Review the changes from task] [TASK:{task}]",
            "[CONTROL:Inspect the work from task] [TASK:{task}]",
            "[CONTROL:Audit the changes from task] [TASK:{task}]",
            "[CONTROL:Examine the output from task] [TASK:{task}]",
        ), base),
        _family(f"{prefix}-reroute-project", "reroute", "reroute", (
            "[CONTROL:Move the task called] [TASK:{task}] [ROUTING:to project] [PROJECT:{project}]",
            "[CONTROL:Send the task called] [TASK:{task}] [ROUTING:into project] [PROJECT:{project}]",
            "[CONTROL:Transfer the task called] [TASK:{task}] [ROUTING:through project] [PROJECT:{project}]",
            "[CONTROL:Reroute the task called] [TASK:{task}] [ROUTING:toward project] [PROJECT:{project}]",
        ), base),
        _family(f"{prefix}-reroute-node", "reroute", "node", (
            "[CONTROL:Move the task called] [TASK:{task}] [ROUTING:via node] [NODE:{node}]",
            "[CONTROL:Send the task called] [TASK:{task}] [ROUTING:through node] [NODE:{node}]",
            "[CONTROL:Transfer the task called] [TASK:{task}] [ROUTING:to node] [NODE:{node}]",
            "[CONTROL:Reroute the task called] [TASK:{task}] [ROUTING:using node] [NODE:{node}]",
        ), unknown_node_values, context_key="node", context_name="node_unqualified",
           expected={"resolve": "needs-input"}),
        _family(f"{prefix}-focus-project", "focus-project", "focus", (
            "[CONTROL:Open the project] [PROJECT:{project}]",
            "[CONTROL:Focus the project] [PROJECT:{project}]",
            "[CONTROL:Select the project] [PROJECT:{project}] [CONTROL:as the workspace]",
            "[CONTROL:Use the project] [PROJECT:{project}] [CONTROL:as current]",
        ), base),
        _family(f"{prefix}-focus-task", "focus-task", "focus", (
            "[CONTROL:Focus the task] [TASK:{task}]", "[CONTROL:Select the task] [TASK:{task}] [CONTROL:as current]",
            "[CONTROL:Open the task] [TASK:{task}] [CONTROL:for focus]", "[CONTROL:Bring forward the task] [TASK:{task}]",
        ), base),
        _family(f"{prefix}-clarify-choice", "clarify", "ambiguity", (
            "[CONTROL:Clarify which project] [PROJECT:{project}] [CONTROL:or] [PROJECT:{project_b}]",
            "[CONTROL:Resolve the project choice between] [PROJECT:{project}] [CONTROL:and] [PROJECT:{project_b}]",
            "[CONTROL:Ask which project to use] [PROJECT:{project}] [CONTROL:or] [PROJECT:{project_b}]",
            "[CONTROL:Confirm the project choice] [PROJECT:{project}] [CONTROL:versus] [PROJECT:{project_b}]",
        ), base, rows=4, expected={"resolve": "needs-input"}),
        _family(f"{prefix}-clarify-compound", "clarify", "compound", (
            "[INSTRUCTION:Stop this work and start another task]",
            "[INSTRUCTION:Review the first request, then move to a second request]",
            "[INSTRUCTION:Cancel the current request while continuing elsewhere]",
            "[INSTRUCTION:Focus one request and inspect another request]",
        ), base, rows=4, expected={"resolve": "needs-input"}),
        _family(f"{prefix}-list-projects", "list-projects", "list", (
            "[CONTROL:List every project]", "[CONTROL:Show the project catalog]",
            "[CONTROL:Display all workspaces]", "[CONTROL:Open the project index]",
        ), {}, rows=4),
    ]


def train_families() -> list[Family]:
    families = _start_families(
        "v071-train", TRAIN_PROJECTS, TRAIN_TASKS, TRAIN_PROVIDERS, TRAIN_MODELS,
        TRAIN_NODES, TRAIN_INSTRUCTIONS, TRAIN_TARGETS, TRAIN_PROJECTS_MISSING,
        TRAIN_PROVIDERS_MISSING, TRAIN_MODELS_MISSING,
    )
    families.extend(_command_families(
        "v071-train", TRAIN_PROJECTS, TRAIN_TASKS, TRAIN_NODES, TRAIN_INSTRUCTIONS,
        TRAIN_TASKS_MISSING, TRAIN_NODES_UNQUALIFIED,
    ))
    families.append(_family("v071-train-converse", "converse", "converse", (
        "[INSTRUCTION:What changed in the latest task review?]",
        "[INSTRUCTION:Can you explain how task cancellation works?]",
        "[INSTRUCTION:What does the task queue do when work is deferred?]",
        "[INSTRUCTION:How should I understand a task moving between nodes?]",
        "[INSTRUCTION:Why did the task stop before the tests ran?]",
        "[INSTRUCTION:What does a project focus change affect?]",
        "[INSTRUCTION:Can you summarize the task history?]",
        "[INSTRUCTION:What is the difference between stopping and queueing a task?]",
    ), {}, rows=8))
    # v0.7.2: constructions the v0.7.1 model failed on held-out calibration
    # phrasing (novel verbs/framings, train names). Train-only by design;
    # calibration rows stay frozen so thresholds are selected on unseen text.
    base = _common_values(TRAIN_PROJECTS, TRAIN_TASKS, TRAIN_PROVIDERS,
                          TRAIN_MODELS, TRAIN_NODES, TRAIN_INSTRUCTIONS)
    families.extend([
        _family("v071-train-continue-next-instruction", "continue", "continue", (
            "[CONTROL:For the existing task] [TASK:{task}], [CONTROL:my next instruction is:] [INSTRUCTION:{instruction}]",
            "[CONTROL:For the current task] [TASK:{task}], [CONTROL:the next instruction is:] [INSTRUCTION:{instruction}]",
            "[CONTROL:On the existing task] [TASK:{task}] [CONTROL:I want to add:] [INSTRUCTION:{instruction}]",
            "[CONTROL:Task] [TASK:{task}] [CONTROL:is ongoing; next do:] [INSTRUCTION:{instruction}]",
            "[CONTROL:With task] [TASK:{task}] [CONTROL:still open, please:] [INSTRUCTION:{instruction}]",
        ), base, rows=10),
        _family("v071-train-stop-leave", "stop", "stop", (
            "[CONTROL:I want task] [TASK:{task}] [CONTROL:stopped]",
            "[CONTROL:Please leave task] [TASK:{task}] [CONTROL:stopped]",
            "[CONTROL:Keep task] [TASK:{task}] [CONTROL:stopped]",
            "[CONTROL:Task] [TASK:{task}] [CONTROL:should stay stopped]",
            "[CONTROL:Leave task] [TASK:{task}] [CONTROL:as stopped]",
        ), base, rows=10),
        _family("v071-train-status-finished", "status", "status", (
            "[CONTROL:Has task] [TASK:{task}] [CONTROL:finished yet?]",
            "[CONTROL:Is task] [TASK:{task}] [CONTROL:done yet?]",
            "[CONTROL:Has task] [TASK:{task}] [CONTROL:completed?]",
            "[CONTROL:Did task] [TASK:{task}] [CONTROL:finish already?]",
            "[CONTROL:Is task] [TASK:{task}] [CONTROL:complete now?]",
        ), base, rows=10),
        _family("v071-train-review-do", "review", "review", (
            "[CONTROL:Please do a code review of the work produced by task] [TASK:{task}]",
            "[CONTROL:Read through the work produced by task] [TASK:{task}]",
            "[CONTROL:Give a code review for task] [TASK:{task}]",
            "[CONTROL:Look over what task] [TASK:{task}] [CONTROL:produced]",
        ), base, rows=8),
        _family("v071-train-queue-that", "queue", "queue", (
            "[INSTRUCTION:{instruction}]; [CONTROL:queue that after task] [TASK:{task}] [CONTROL:finishes]",
            "[INSTRUCTION:{instruction}]; [CONTROL:defer that until task] [TASK:{task}] [CONTROL:completes]",
            "[CONTROL:When task] [TASK:{task}] [CONTROL:is done, take on:] [INSTRUCTION:{instruction}]",
            "[CONTROL:Put this behind task] [TASK:{task}]: [INSTRUCTION:{instruction}]",
        ), base, rows=8),
        _family("v071-train-reroute-relocate", "reroute", "reroute", (
            "[CONTROL:Relocate task] [TASK:{task}] [ROUTING:to project] [PROJECT:{project}]",
            "[CONTROL:Shift task] [TASK:{task}] [ROUTING:into project] [PROJECT:{project}]",
            "[CONTROL:Rehome task] [TASK:{task}] [ROUTING:to project] [PROJECT:{project}]",
            "[CONTROL:Carry task] [TASK:{task}] [ROUTING:over to project] [PROJECT:{project}]",
        ), base, rows=8),
        _family("v071-train-focus-see", "focus-project", "focus", (
            "[PROJECT:{project}] [CONTROL:is the workspace I want to see]",
            "[PROJECT:{project}] [CONTROL:is the workspace I want to use]",
            "[CONTROL:Show me the workspace for project] [PROJECT:{project}]",
            "[CONTROL:Bring up project] [PROJECT:{project}] [CONTROL:for viewing]",
        ), base, rows=8),
        _family("v071-train-list-which", "list-projects", "list", (
            "[CONTROL:Which workspaces can I open?]",
            "[CONTROL:Show me what I can work on]",
            "[CONTROL:List the projects open to me]",
        ), {}, rows=3),
        _family("v071-train-converse-explain", "converse", "converse", (
            "[INSTRUCTION:Explain how retries back off]",
            "[INSTRUCTION:Explain what a checkpoint holds]",
            "[INSTRUCTION:Explain why runs pause for approval]",
        ), {}, rows=3),
        _family("v071-train-continue-bare", "continue", "continue", (
            "[INSTRUCTION:Probe the worker health]",
            "[INSTRUCTION:Check the worker health]",
            "[INSTRUCTION:Verify the worker health]",
        ), {}, rows=3),
        # v0.7.5: "Open the project <unseen>" merged into one CONTROL span
        # on dev. Focus wording with catalog-missing names teaches that the
        # PROJECT span does not depend on having seen the name. Director
        # clarifies missing names downstream (expected needs-input).
        _family("v071-train-focus-unknown-project", "focus-project", "focus", (
            "[CONTROL:Open the project] [PROJECT:{project}]",
            "[CONTROL:Focus the project] [PROJECT:{project}]",
            "[CONTROL:Select the project] [PROJECT:{project}] [CONTROL:as the workspace]",
            "[CONTROL:Use the project] [PROJECT:{project}] [CONTROL:as current]",
        ), {"project": TRAIN_PROJECTS_MISSING}, rows=4,
            context_key="project", expected={"resolve": "needs-input"}),
        # v0.7.5: hyphenated node names containing a project-like word
        # ("dev-cedar") were split into PROJECT + NODE pieces. Compound
        # names built from known train projects teach one-span NODE reads.
        _family("v071-train-reroute-node-compound", "reroute", "node", (
            "[CONTROL:Move the task called] [TASK:{task}] [ROUTING:via node] [NODE:{node}]",
            "[CONTROL:Send the task called] [TASK:{task}] [ROUTING:through node] [NODE:{node}]",
            "[CONTROL:Transfer the task called] [TASK:{task}] [ROUTING:to node] [NODE:{node}]",
            "[CONTROL:Reroute the task called] [TASK:{task}] [ROUTING:using node] [NODE:{node}]",
        ), {"project": TRAIN_PROJECTS, "project_a": TRAIN_PROJECTS,
            "project_b": TRAIN_PROJECTS, "task": TRAIN_TASKS,
            "task_a": TRAIN_TASKS,
            "node": ("node-harbor", "node-ember", "node-forge", "node-drift")},
            rows=4, context_key="node", context_name="node_unqualified",
            expected={"resolve": "needs-input"}),
    ])
    return families


def calibration_families() -> list[Family]:
    values = _common_values(
        CAL_PROJECTS, CAL_TASKS, CAL_PROVIDERS, CAL_MODELS, CAL_NODES,
        CAL_INSTRUCTIONS,
    )
    return [
        _family("v071-cal-start-project", "start", "start", (
            "[ROUTING:In] [PROJECT:{project}], [INSTRUCTION:{instruction}]",
            "[ROUTING:Within] [PROJECT:{project}], [INSTRUCTION:{instruction}]",
        ), values, rows=2),
        _family("v071-cal-start-no-project", "start", "no-project", (
            "[INSTRUCTION:Verify the night build without restarting anything]",
            "[INSTRUCTION:Inspect the latest logs before changing anything]",
        ), {}, rows=2),
        _family("v071-cal-continue", "continue", "continue", (
            "[CONTROL:For the existing task] [TASK:{task}], [CONTROL:my next instruction is]: [INSTRUCTION:{instruction}]",
            "[CONTROL:For the current task] [TASK:{task}], [CONTROL:the next instruction is]: [INSTRUCTION:{instruction}]",
        ), values, rows=2),
        _family("v071-cal-steer", "steer", "steer", (
            "[CONTROL:Interrupt the current direction of task] [TASK:{task}]: [INSTRUCTION:{instruction}]",
            "[CONTROL:Redirect the active direction of task] [TASK:{task}]: [INSTRUCTION:{instruction}]",
        ), values, rows=2),
        _family("v071-cal-queue", "queue", "queue", (
            "[INSTRUCTION:{instruction}]; [CONTROL:queue that after task] [TASK:{task}] [CONTROL:finishes]",
            "[INSTRUCTION:{instruction}]; [CONTROL:defer that after task] [TASK:{task}] [CONTROL:completes]",
        ), values, rows=2),
        _family("v071-cal-stop", "stop", "stop", (
            "[CONTROL:I want task] [TASK:{task}] [CONTROL:stopped]",
            "[CONTROL:Please leave task] [TASK:{task}] [CONTROL:stopped]",
        ), values, rows=2),
        _family("v071-cal-status", "status", "status", (
            "[CONTROL:Has task] [TASK:{task}] [CONTROL:finished yet?]",
            "[CONTROL:Is task] [TASK:{task}] [CONTROL:done yet?]",
        ), values, rows=2),
        _family("v071-cal-review", "review", "review", (
            "[CONTROL:Please do a code review of the work produced by task] [TASK:{task}]",
            "[CONTROL:Read through the work produced by task] [TASK:{task}]",
        ), values, rows=2),
        _family("v071-cal-reroute", "reroute", "reroute", (
            "[CONTROL:Relocate task] [TASK:{task}] [ROUTING:to project] [PROJECT:{project}]",
            "[CONTROL:Send task] [TASK:{task}] [ROUTING:into project] [PROJECT:{project}]",
        ), values, rows=2),
        _family("v071-cal-focus-project", "focus-project", "focus", (
            "[PROJECT:{project}] [CONTROL:is the workspace I want to see]",
            "[PROJECT:{project}] [CONTROL:is the workspace I want open]",
        ), values, rows=2),
        _family("v071-cal-focus-task", "focus-task", "focus", (
            "[TASK:{task}] [CONTROL:is the task I want to open]",
            "[TASK:{task}] [CONTROL:is the task I want to inspect]",
        ), values, rows=2),
        _family("v071-cal-list-projects", "list-projects", "list", (
            "[CONTROL:Which projects can I work on?]",
            "[CONTROL:Show me the projects I can use]",
        ), {}, rows=2),
        _family("v071-cal-converse", "converse", "converse", (
            "[INSTRUCTION:Explain how task cancellation works]",
            "[INSTRUCTION:Explain how task pausing works]",
        ), {}, rows=2),
        _family("v071-cal-clarify", "clarify", "compound", (
            "[INSTRUCTION:Stop the current request and create another task in a different project]",
            "[INSTRUCTION:Cancel this request and start a new task elsewhere]",
        ), {}, rows=2, expected={"resolve": "needs-input"}),
        _family("v071-cal-unknown-project", "start", "unknown-name", (
            "[ROUTING:In] [PROJECT:{project}], [INSTRUCTION:{instruction}]",
            "[ROUTING:Within] [PROJECT:{project}], [INSTRUCTION:{instruction}]",
        ), {**values, "project": CAL_PROJECTS_MISSING}, rows=2,
           context_key="project", expected={"resolve": "needs-input"}),
        _family("v071-cal-unknown-task", "continue", "unknown-name", (
            "[CONTROL:For the existing task] [TASK:{task}], [CONTROL:my next instruction is]: [INSTRUCTION:{instruction}]",
            "[CONTROL:For the current task] [TASK:{task}], [CONTROL:the next instruction is]: [INSTRUCTION:{instruction}]",
        ), {**values, "task": CAL_TASKS_MISSING}, rows=2,
           context_key="task", expected={"resolve": "needs-input"}),
    ]


def heldout_families(split: str) -> list[Family]:
    if split == "calibration":
        return calibration_families()
    if split == "dev":
        prefix, p, pm, t, tm, pr, m, n, ins, targets = (
            "v071-dev", DEV_PROJECTS, DEV_PROJECTS_MISSING, DEV_TASKS, DEV_TASKS_MISSING,
            DEV_PROVIDERS, DEV_MODELS, DEV_NODES, DEV_INSTRUCTIONS, DEV_TARGETS,
        )
    elif split == "calibration":
        prefix, p, pm, t, tm, pr, m, n, ins, targets = (
            "v071-cal", CAL_PROJECTS, CAL_PROJECTS_MISSING, CAL_TASKS, CAL_TASKS_MISSING,
            CAL_PROVIDERS, CAL_MODELS, CAL_NODES, CAL_INSTRUCTIONS, CAL_TARGETS,
        )
    else:
        raise ValueError(split)
    common = _common_values(p, t, pr, m, n, ins)
    families = [
        _family(f"{prefix}-start-project", "start", "start", (
            "[INSTRUCTION:{instruction}] [ROUTING:under] [PROJECT:{project}]",
            "[INSTRUCTION:{instruction}] [ROUTING:inside] [PROJECT:{project}]",
            "[INSTRUCTION:{instruction}] [ROUTING:at] [PROJECT:{project}]",
            "[INSTRUCTION:{instruction}] [ROUTING:within] [PROJECT:{project}]",
        ), common, rows=8),
        _family(f"{prefix}-start-no-project", "start", "no-project", (
            "[INSTRUCTION:Add integration tests for the login flow]",
            "[INSTRUCTION:Fix the broken build]",
            "[INSTRUCTION:Check the open PRs]",
            "[INSTRUCTION:Do not restart anything; inspect the logs]",
        ), {}, rows=4),
        _family(f"{prefix}-continue", "continue", "continue", (
            "[CONTROL:Tell the task called] [TASK:{task}] [CONTROL:to] [INSTRUCTION:{instruction}]",
            "[CONTROL:Continue the task called] [TASK:{task}] [CONTROL:with] [INSTRUCTION:{instruction}]",
            "[CONTROL:Resume the task called] [TASK:{task}] [CONTROL:and do] [INSTRUCTION:{instruction}]",
            "[CONTROL:Keep the task called] [TASK:{task}] [CONTROL:moving with] [INSTRUCTION:{instruction}]",
        ), common, rows=8),
        _family(f"{prefix}-steer", "steer", "steer", (
            "[CONTROL:Redirect the running task] [TASK:{task}] [CONTROL:right now]: [INSTRUCTION:{instruction}]",
            "[CONTROL:Steer the running task] [TASK:{task}] [CONTROL:immediately]: [INSTRUCTION:{instruction}]",
            "[CONTROL:Change the running task] [TASK:{task}] [CONTROL:right away]: [INSTRUCTION:{instruction}]",
            "[CONTROL:Reaim the running task] [TASK:{task}] [CONTROL:without delay]: [INSTRUCTION:{instruction}]",
        ), common, rows=8),
        _family(f"{prefix}-queue", "queue", "queue", (
            "[CONTROL:After the task] [TASK:{task}] [CONTROL:finishes, queue this]: [INSTRUCTION:{instruction}]",
            "[CONTROL:After the task] [TASK:{task}] [CONTROL:completes, defer this]: [INSTRUCTION:{instruction}]",
            "[CONTROL:Behind the task] [TASK:{task}] [CONTROL:hold this]: [INSTRUCTION:{instruction}]",
            "[CONTROL:Once the task] [TASK:{task}] [CONTROL:clears, schedule this]: [INSTRUCTION:{instruction}]",
        ), common, rows=8),
        _family(f"{prefix}-stop", "stop", "stop", (
            "[CONTROL:Stop the task called] [TASK:{task}]", "[CONTROL:Cancel the task called] [TASK:{task}]",
            "[CONTROL:End the task called] [TASK:{task}]", "[CONTROL:Halt the task called] [TASK:{task}]",
        ), common, rows=8),
        _family(f"{prefix}-status", "status", "status", (
            "[CONTROL:How far has task] [TASK:{task}] [CONTROL:got?]", "[CONTROL:Give progress for task] [TASK:{task}]",
            "[CONTROL:Show the state of task] [TASK:{task}]", "[CONTROL:Report progress on task] [TASK:{task}]",
        ), common, rows=8),
        _family(f"{prefix}-review", "review", "review", (
            "[CONTROL:Review the changes from task] [TASK:{task}]",
            "[CONTROL:Inspect the work from task] [TASK:{task}]",
            "[CONTROL:Audit the changes from task] [TASK:{task}]",
            "[CONTROL:Examine the output from task] [TASK:{task}]",
        ), common, rows=8),
        _family(f"{prefix}-reroute-node", "reroute", "node", (
            "[CONTROL:Move the task called] [TASK:{task}] [ROUTING:via node] [NODE:{node}]",
            "[CONTROL:Send the task called] [TASK:{task}] [ROUTING:through node] [NODE:{node}]",
            "[CONTROL:Transfer the task called] [TASK:{task}] [ROUTING:to node] [NODE:{node}]",
            "[CONTROL:Reroute the task called] [TASK:{task}] [ROUTING:using node] [NODE:{node}]",
        ), common, rows=8, context_key="node", context_name="node_unqualified",
           expected={"resolve": "needs-input"}),
        _family(f"{prefix}-focus-project", "focus-project", "focus", (
            "[CONTROL:Open the project] [PROJECT:{project}]", "[CONTROL:Focus the project] [PROJECT:{project}]",
            "[CONTROL:Select the project] [PROJECT:{project}] [CONTROL:as workspace]", "[CONTROL:Use the project] [PROJECT:{project}] [CONTROL:as current]",
        ), common, rows=8),
        _family(f"{prefix}-focus-task", "focus-task", "focus", (
            "[CONTROL:Focus the task] [TASK:{task}]", "[CONTROL:Select the task] [TASK:{task}] [CONTROL:as current]",
            "[CONTROL:Open the task] [TASK:{task}] [CONTROL:as active]", "[CONTROL:Bring forward the task] [TASK:{task}]",
        ), common, rows=8),
        _family(f"{prefix}-clarify", "clarify", "compound", (
            "[INSTRUCTION:End this request and open a separate task]",
            "[CONTROL:Clarify which project] [PROJECT:{project}] [CONTROL:or] [PROJECT:{project_b}]",
            "[INSTRUCTION:Inspect the first request, then open a separate request]",
            "[CONTROL:Confirm the project choice] [PROJECT:{project}] [CONTROL:versus] [PROJECT:{project_b}]",
        ), common, rows=4, expected={"resolve": "needs-input"}),
        _family(f"{prefix}-unknown-project", "start", "unknown-name", (
            "[INSTRUCTION:{instruction}] [ROUTING:under] [PROJECT:{project}]",
            "[INSTRUCTION:{instruction}] [ROUTING:inside] [PROJECT:{project}]",
            "[INSTRUCTION:{instruction}] [ROUTING:at] [PROJECT:{project}]",
            "[INSTRUCTION:{instruction}] [ROUTING:within] [PROJECT:{project}]",
        ), {**common, "project": pm}, rows=8, context_key="project",
           expected={"resolve": "needs-input"}),
        _family(f"{prefix}-unknown-task", "continue", "unknown-name", (
            "[CONTROL:Tell the task called] [TASK:{task}] [CONTROL:to] [INSTRUCTION:{instruction}]",
            "[CONTROL:Continue the task called] [TASK:{task}] [CONTROL:with] [INSTRUCTION:{instruction}]",
            "[CONTROL:Resume the task called] [TASK:{task}] [CONTROL:and do] [INSTRUCTION:{instruction}]",
            "[CONTROL:Keep the task called] [TASK:{task}] [CONTROL:moving with] [INSTRUCTION:{instruction}]",
        ), {**common, "task": tm}, rows=8, context_key="task",
           expected={"resolve": "needs-input"}),
    ]
    families.extend((
        _family(f"{prefix}-list-projects", "list-projects", "list", (
            "[CONTROL:Show the workspace list]", "[CONTROL:Open the project roster]",
            "[CONTROL:Display the registered projects]", "[CONTROL:Bring up every workspace]",
        ), {}, rows=4),
        _family(f"{prefix}-converse", "converse", "converse", (
            "[INSTRUCTION:What changed in the latest project review?]",
            "[INSTRUCTION:Can you explain how task cancellation works here?]",
            "[INSTRUCTION:What happens when deferred work is queued?]",
            "[INSTRUCTION:What does a remote task handoff mean?]",
        ), {}, rows=4),
    ))
    return families


def _token_bounds(text: str) -> set[int]:
    """Return starts and ends of basic tokenizer tokens."""
    bounds = {0, len(text)}
    i = 0
    while i < len(text):
        if text[i].isspace():
            i += 1
            continue
        start = i
        is_punct = unicodedata.category(text[i]).startswith("P")
        if is_punct:
            i += 1
        else:
            i += 1
            while i < len(text) and not text[i].isspace() and not unicodedata.category(text[i]).startswith("P"):
                i += 1
        bounds.update((start, i))
    return bounds


def _span_text(row: dict, span: dict) -> str:
    return row["text"][span["start"]:span["end"]]


def validate_row(row: dict) -> list[str]:
    errors: list[str] = []
    for key in ("id", "split", "family", "category", "text", "action", "spans", "template_source"):
        if key not in row:
            errors.append(f"missing {key}")
    if errors:
        return errors
    if row["split"] not in SPLITS:
        errors.append(f"bad split {row['split']!r}")
    if row["action"] not in ACTIONS:
        errors.append(f"bad action {row['action']!r}")
    text = row["text"]
    if not isinstance(text, str) or not text:
        return errors + ["empty text"]
    spans = row["spans"]
    if not isinstance(spans, list):
        return errors + ["spans not a list"]
    bounds = _token_bounds(text)
    for span in spans:
        label = span.get("label")
        start, end = span.get("start"), span.get("end")
        if label not in LABELS:
            errors.append(f"bad label {span}")
            continue
        if not isinstance(start, int) or not isinstance(end, int) or not (0 <= start < end <= len(text)):
            errors.append(f"bad offsets {span}")
            continue
        covered = text[start:end]
        if covered.strip() == "" or covered != covered.strip():
            errors.append(f"whitespace span {span}")
        if start not in bounds or end not in bounds:
            errors.append(f"non-token boundary {span} -> {covered!r}")

    def overlaps(left: dict, right: dict) -> bool:
        return left["start"] < right["end"] and right["start"] < left["end"]

    for index, left in enumerate(spans):
        for right in spans[index + 1:]:
            if overlaps(left, right):
                errors.append(f"overlap {left} vs {right}")
    return errors


def _make_row(split: str, family: Family, index: int, value_offset: int = 0) -> dict:
    template_index = index % len(family.templates)
    slot = index // len(family.templates)
    source = family.templates[template_index]
    # Rotate value slots per family so pools wider than one family's slot
    # range still get covered (v0.7.5: instruction verbs 4-9 never appeared
    # because every family only used slots 0-3). Deterministic in family order.
    values = {
        key: vals[(slot + value_offset) % len(vals)]
        for key, vals in family.values.items()
    }
    text, spans = render_marked(source, values)
    row = {
        "id": f"jx-v071-{split}-{family.name}-{index:03d}",
        "split": split, "family": family.name, "category": family.category,
        "text": text, "action": family.action, "spans": spans,
        "template_source": source, "template_index": template_index,
    }
    if family.context_key is not None:
        row["context"] = {family.context_name: values[family.context_key]}
    if family.expected:
        row["expected"] = dict(family.expected)
    errors = validate_row(row)
    if errors:
        raise RuntimeError(f"invalid {row['id']}: {errors}")
    return row


def generate_split(split: str) -> list[dict]:
    families = train_families() if split == "train" else heldout_families(split)
    rows: list[dict] = []
    seen: set[str] = set()
    for family_index, family in enumerate(families):
        count = family.rows if split == "train" else min(family.rows, 7)
        # Rotation is train-only: dev/calibration rows stay byte-identical
        # so selection and threshold sets remain stable across versions.
        offset = family_index if split == "train" else 0
        for index in range(count):
            row = _make_row(split, family, index, value_offset=offset)
            if row["text"] in seen:
                raise RuntimeError(f"duplicate text in {split}: {row['text']!r}")
            seen.add(row["text"])
            rows.append(row)
    return rows


def span_canonical(row: dict) -> tuple:
    return tuple(sorted((_span_text(row, span), span["label"]) for span in row["spans"]))


def validate_dataset(rows: list[dict]) -> list[str]:
    errors: list[str] = []
    ids: set[str] = set()
    text_by_split: dict[str, set[str]] = defaultdict(set)
    family_splits: dict[str, set[str]] = defaultdict(set)
    catalog: dict[str, dict[str, set[str]]] = defaultdict(lambda: defaultdict(set))
    canonical: dict[str, set[tuple]] = defaultdict(set)
    for row in rows:
        errors.extend(f"{row.get('id')}: {error}" for error in validate_row(row))
        if row.get("id") in ids:
            errors.append(f"duplicate id {row.get('id')}")
        ids.add(row.get("id"))
        split, text = row.get("split", "?"), row.get("text", "")
        if text in text_by_split[split]:
            errors.append(f"duplicate text within {split}: {text!r}")
        text_by_split[split].add(text)
        family_splits[row.get("family", "")].add(split)
        canonical[text].add((row.get("action"), span_canonical(row)))
        for span in row.get("spans", []):
            if span.get("label") in TOKEN_LABELS:
                catalog[split][span["label"]].add(_span_text(row, span))
    for family, splits in family_splits.items():
        if len(splits) > 1:
            errors.append(f"family crosses splits {family}: {sorted(splits)}")
    all_texts: dict[str, str] = {}
    for split, texts in text_by_split.items():
        for text in texts:
            if text in all_texts and all_texts[text] != split:
                errors.append(f"text leak {split}x{all_texts[text]}: {text!r}")
            all_texts[text] = split
    for i, left in enumerate(SPLITS):
        for right in SPLITS[i + 1:]:
            for label in TOKEN_LABELS:
                overlap = catalog[left][label] & catalog[right][label]
                if overlap:
                    errors.append(f"catalog leak {label} {left}x{right}: {sorted(overlap)[:3]}")
    for text, keys in canonical.items():
        if len(keys) > 1:
            errors.append(f"canonical conflict for {text!r}")
    return errors


def generate_all() -> list[dict]:
    rows = [row for split in SPLITS for row in generate_split(split)]
    errors = validate_dataset(rows)
    if errors:
        raise RuntimeError("dataset validation failed: " + "; ".join(errors[:12]))
    return rows


def _write_jsonl(path: str, rows: Iterable[dict]) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Generate authored v0.7 train/dev/calibration data")
    parser.add_argument("--out-dir", default="/home/abstergo/.local/share/circe-experiments/extract-v07/data")
    parser.add_argument("--no-write", action="store_true")
    args = parser.parse_args(argv)
    rows = generate_all()
    counts = {split: sum(row["split"] == split for row in rows) for split in SPLITS}
    print(f"dataset {VERSION} counts={json.dumps(counts, sort_keys=True)}")
    if args.no_write:
        return 0
    for split in SPLITS:
        _write_jsonl(os.path.join(args.out_dir, f"{split}.jsonl"),
                     (row for row in rows if row["split"] == split))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
