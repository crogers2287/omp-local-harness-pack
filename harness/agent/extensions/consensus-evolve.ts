/**
 * consensus-evolve — self-healing harness extension for omp.
 *
 * CONSENSUS: `consensus` tool fans a question out to an independent model
 * panel (real separate API calls), synthesizes agreement/dissent; destructive
 * bash commands are gated until a recent consensus verdict exists.
 *
 * SELF-HEALING (tuned for local models like llamaswap local-primary/local-secondary):
 *  - Failure signatures: every tool failure is classified (mechanism,
 *    agent-caused?) and clustered; clusters feed reflection as evidence.
 *  - Repeat-call breaker: an identical tool call that already failed twice is
 *    blocked once with a corrective reason (kills hallucinated retry loops).
 *  - Pre-flight bash hygiene: markdown fences / prompt artifacts in commands
 *    are blocked with the exact fix (local models emit these under stress).
 *  - Result steering: known error classes get a one-line "[harness hint]"
 *    appended to the tool result so the model converges in one turn.
 *  - Path auto-correct: read/edit calls with a non-existent path are repaired
 *    segment-by-segment against the real filesystem (bounded edit distance)
 *    before execution — DRY-corrupted paths get fixed instead of failed.
 *  - Tool masking: a non-essential tool failing 3+ times in a row with the
 *    same signature is deactivated until a verification passes.
 *  - Verification-before-completion: `todo` op:"done" is blocked unless a
 *    verification command (test/build/lint, exit 0) ran recently; force-allow
 *    after maxVerifyBlocks to prevent livelock.
 *
 * EVOLUTION: reflection distills deduped rules from the signature evidence
 * bundle into learned-rules.md, injected into every session.
 *
 * Data dir: ~/.omp/agent/consensus-evolve/{config.json,learned-rules.md,evolution.jsonl}
 */

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { completeSimple } from "@oh-my-pi/pi-ai";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

// ---------------------------------------------------------------------------
// Config & state

interface Config {
	panelModels: string[];
	synthesizerModel: string;
	panelTimeoutMs: number;
	destructiveGate: "block" | "off";
	gateCooldownMs: number;
	failureStreakNudge: number;
	reflectEveryTurns: number;
	evolution: "on" | "off";
	maxInjectedRulesChars: number;
	maxRules: number;
	/** Block todo op:"done" without a recent passing verification command. */
	verifyBeforeDone: "block" | "off";
	/** A verification success counts for this many subsequent tool calls. */
	verifyWindowToolCalls: number;
	/** Force-allow completion after this many gate blocks (anti-livelock). */
	maxVerifyBlocks: number;
	/** Mask a non-essential tool after this many same-signature consecutive failures. */
	maskStreakThreshold: number;
	preflightBashHygiene: boolean;
	resultSteering: boolean;
	/** Auto-run the ablation gate on the newest rule after session-end reflection. */
	autoAblate: "on" | "off";
	/** Seeds for auto-triggered ablations (manual runs choose their own). */
	autoAblateSeeds: number;
	/** Break loops of identical successful tool calls returning identical results. */
	toolLoopBreaker: "on" | "off";
	/** Block when the same call+result pair has occurred this many times. */
	toolLoopThreshold: number;
	/** Abort the agent when the same request context is sent this many times in a row. */
	requestLoopAbortAt: number;
	/** Inject a steering message after this many identical consecutive requests (0=off). */
	requestLoopSteerAt: number;
	/** Max auto-continuations per user input when the model announces an action but calls no tool (0=off). */
	announceContinueMax: number;
	/**
	 * Plan-mode autonomy:
	 *   "on"            — always auto-create a plan on a multi-step first input
	 *   "headless-only" — only auto-create when there is no interactive UI (ctx.hasUI === false)
	 *   "off"           — disable auto-create; the suggest-nudge fires instead (legacy behaviour)
	 */
	autoPlan: "on" | "headless-only" | "off";
	/**
	 * After this many seq-think nudges for the SAME (tool, mechanism) signature
	 * without the model actually invoking the sequentialthinking MCP tool, the
	 * harness escalates: it MASKS every other tool, leaving only the seq-think
	 * tool active. The mask self-clears the moment the model calls seq-think.
	 * Set to 0 to disable mandatory escalation (soft-nudge only). Default 3.
	 */
	mandatorySeqThinkAt: number;
}

// Defaults tuned for small local models (local-primary/local-secondary): nudge earlier, reflect
// more often, keep the injected-rule block lean to preserve context headroom.
const DEFAULT_CONFIG: Config = {
	panelModels: ["llamaswap/local-primary", "llamaswap/local-secondary", "deepseek/deepseek-v4-pro"],
	synthesizerModel: "",
	panelTimeoutMs: 120_000,
	destructiveGate: "block",
	gateCooldownMs: 10 * 60_000,
	failureStreakNudge: 2,
	reflectEveryTurns: 15,
	evolution: "on",
	maxInjectedRulesChars: 2000,
	maxRules: 40,
	verifyBeforeDone: "block",
	verifyWindowToolCalls: 6,
	maxVerifyBlocks: 3,
	maskStreakThreshold: 3,
	preflightBashHygiene: true,
	resultSteering: true,
	autoAblate: "on",
	autoAblateSeeds: 1,
	toolLoopBreaker: "on",
	toolLoopThreshold: 3,
	requestLoopAbortAt: 6,
	requestLoopSteerAt: 3,
	announceContinueMax: 2,
	autoPlan: "on",
	mandatorySeqThinkAt: 3,
};

const DATA_DIR = path.join(os.homedir(), ".omp", "agent", "consensus-evolve");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const RULES_PATH = path.join(DATA_DIR, "learned-rules.md");
const LOG_PATH = path.join(DATA_DIR, "evolution.jsonl");
const PLANS_DIR = path.join(DATA_DIR, "plans");
const LEGACY_PLAN_PATH = path.join(DATA_DIR, "active-plan.json"); // pre-cwd-scoping

interface ActivePlanPhase {
	name: string;
	verify: string;
	brief: string;
}
interface ActivePlan {
	task: string;
	currentPhase: number;
	phases: ActivePlanPhase[];
	startedAt: string;
	completedPhases?: number[];
	/** The cwd this plan was created for (added 2026-06-16 with cwd scoping). */
	cwd?: string;
}

/**
 * Encode a cwd into a filesystem-safe slug that mirrors omp's session-dir
 * convention ("/tmp/local-secondary-hm3" -> "-tmp-local-secondary-hm3"). Capped to keep paths sane on
 * filesystems with NAME_MAX limits.
 */
function cwdToPlanSlug(cwd: string): string {
	const normalized = path.resolve(cwd || ".").replace(/[/\\]/g, "-");
	const stripped = normalized.replace(/^[.-]+/, "-");
	return stripped.slice(0, 200) || "-root";
}

function planPathForCwd(cwd: string): string {
	return path.join(PLANS_DIR, `${cwdToPlanSlug(cwd)}.json`);
}

function readActivePlan(cwd: string): ActivePlan | undefined {
	const p = planPathForCwd(cwd);
	try {
		const raw = fs.readFileSync(p, "utf8");
		const plan = JSON.parse(raw) as ActivePlan;
		if (
			typeof plan.task !== "string" ||
			typeof plan.currentPhase !== "number" ||
			!Array.isArray(plan.phases) ||
			plan.phases.length === 0
		)
			return undefined;
		if (plan.currentPhase < 0 || plan.currentPhase >= plan.phases.length) return undefined;
		return plan;
	} catch {
		return undefined;
	}
}

function writeActivePlan(plan: ActivePlan, cwd: string): void {
	const p = planPathForCwd(cwd);
	try {
		fs.mkdirSync(PLANS_DIR, { recursive: true });
		plan.cwd = path.resolve(cwd);
		fs.writeFileSync(p, `${JSON.stringify(plan, null, 2)}\n`);
	} catch {
		/* best-effort */
	}
}

function clearActivePlan(cwd: string): void {
	const p = planPathForCwd(cwd);
	try {
		if (fs.existsSync(p)) {
			const archive = `${p}.${Date.now()}.archived`;
			fs.renameSync(p, archive);
		}
	} catch {
		/* best-effort */
	}
}

/**
 * One-time migration of the pre-2026-06-16 single-file plan layout. If a
 * `active-plan.json` exists at the legacy path AND its task references the
 * current cwd, move it into the new per-cwd slot; otherwise archive it so it
 * cannot leak into an unrelated session.
 */
function migrateLegacyPlan(cwd: string): void {
	try {
		if (!fs.existsSync(LEGACY_PLAN_PATH)) return;
		const raw = fs.readFileSync(LEGACY_PLAN_PATH, "utf8");
		const legacy = JSON.parse(raw) as ActivePlan;
		const taskRefsCwd =
			typeof legacy.task === "string" && legacy.task.toLowerCase().includes(path.resolve(cwd).toLowerCase());
		if (taskRefsCwd && Array.isArray(legacy.phases) && legacy.phases.length > 0) {
			fs.mkdirSync(PLANS_DIR, { recursive: true });
			legacy.cwd = path.resolve(cwd);
			fs.writeFileSync(planPathForCwd(cwd), `${JSON.stringify(legacy, null, 2)}\n`);
		}
		const archive = `${LEGACY_PLAN_PATH}.migrated-${Date.now()}.archived`;
		fs.renameSync(LEGACY_PLAN_PATH, archive);
	} catch {
		/* best-effort */
	}
}

function loadConfig(): Config {
	let raw: Partial<Config> = {};
	try {
		raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
	} catch {
		/* fall through to defaults */
	}
	const merged = { ...DEFAULT_CONFIG, ...raw };
	try {
		fs.mkdirSync(DATA_DIR, { recursive: true });
		fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(merged, null, 2)}\n`);
	} catch {
		/* read-only env — run on merged values */
	}
	return merged;
}

interface SignatureCluster {
	count: number;
	samples: string[];
}

interface SessionStats {
	toolCalls: number;
	toolErrors: number;
	failureStreak: number;
	nudgesSent: number;
	corrections: string[];
	consensusRuns: { question: string; agreement: number; dissent: string }[];
	lastConsensusAt: number;
	lastReflectAt: number;
	/** signature ("tool:mechanism") -> cluster */
	signatures: Map<string, SignatureCluster>;
	/** current consecutive-failure signature streak */
	sigStreak: { sig: string; count: number };
	/** normalized call hash -> consecutive failures of that exact call */
	failedCallHashes: Map<string, { fails: number; blockedOnce: boolean }>;
	/** rolling window of completed successful calls: call hash + result fingerprint */
	recentCalls: { hash: string; resultFp: string }[];
	/** call hash -> times the tool-loop breaker has blocked it */
	loopBlocks: Map<string, number>;
	/** fingerprint of the last outgoing LLM request + consecutive repeat count */
	requestLoop: { fp: string; repeats: number };
	/** announce-without-act auto-continuations since the last real user input */
	autoContinues: number;
	/** true while omp's auto-retry policy is replaying a request (don't count those) */
	inAutoRetry: boolean;
	/** tools masked by the harness, with the tool-call count at masking time */
	maskedTools: Map<string, number>;
	/** tool-call counter at last passing verification command */
	lastVerifyOkAtCall: number;
	verifyBlocks: number;
	healEvents: number;
	/** degenerate-generation aborts since the last real user input */
	degenAborts: number;
	/** fingerprints of degenerate messages already scrub-logged (avoid log spam) */
	scrubLogged: Set<string>;
	/** signatures we've already steered toward sequentialthinking THIS turn */
	seqThinkHinted: Set<string>;
	/** exact verification commands already given explicit grader-feedback nudges THIS turn */
	verifyFailureHinted: Set<string>;
	/** libraries the agent has verified via context7 this session */
	context7Verified: Set<string>;
	/** libraries we've already steered toward context7 this session */
	context7Hinted: Set<string>;
	/** Plan-mode auto-suggest fires on the very first non-empty user input only. */
	planSuggestSent: boolean;
	/** Cumulative seq-think nudges sent for each signature THIS session. */
	seqThinkNudgeCount: Map<string, number>;
	/** Cumulative seq-think nudges across ALL signatures (drives mandatory). */
	seqThinkNudgeTotal: number;
	/** True while the harness has masked all tools except sequentialthinking. */
	seqThinkMandatoryActive: boolean;
	/** Pre-mandatory active-tools snapshot — restored when the model finally calls seq-think. */
	preMandatoryToolSnapshot: string[] | null;
}

function freshStats(): SessionStats {
	return {
		toolCalls: 0,
		toolErrors: 0,
		failureStreak: 0,
		nudgesSent: 0,
		corrections: [],
		consensusRuns: [],
		lastConsensusAt: 0,
		lastReflectAt: 0,
		signatures: new Map(),
		sigStreak: { sig: "", count: 0 },
		failedCallHashes: new Map(),
		recentCalls: [],
		loopBlocks: new Map(),
		requestLoop: { fp: "", repeats: 0 },
		autoContinues: 0,
		inAutoRetry: false,
		maskedTools: new Map(),
		lastVerifyOkAtCall: -1,
		verifyBlocks: 0,
		healEvents: 0,
		degenAborts: 0,
		scrubLogged: new Set(),
		seqThinkHinted: new Set(),
		verifyFailureHinted: new Set(),
		context7Verified: new Set(),
		context7Hinted: new Set(),
		planSuggestSent: false,
		seqThinkNudgeCount: new Map(),
		seqThinkNudgeTotal: 0,
		seqThinkMandatoryActive: false,
		preMandatoryToolSnapshot: null,
	};
}

// ---------------------------------------------------------------------------
// Learned rules file

function readRules(): string[] {
	try {
		return fs
			.readFileSync(RULES_PATH, "utf8")
			.split("\n")
			.filter(line => line.startsWith("- "));
	} catch {
		return [];
	}
}

function writeRules(rules: string[]): void {
	fs.mkdirSync(DATA_DIR, { recursive: true });
	const header = "# Learned rules (written by consensus-evolve; prune with /evolve prune <n>)\n\n";
	fs.writeFileSync(RULES_PATH, `${header}${rules.join("\n")}\n`);
}

function isDuplicateRule(candidate: string, existing: string[]): boolean {
	const words = (s: string) =>
		new Set(
			s
				.toLowerCase()
				.replace(/[^a-z0-9 ]/g, " ")
				.split(/\s+/)
				.filter(w => w.length > 3),
		);
	const cw = words(candidate);
	if (cw.size === 0) return true;
	for (const rule of existing) {
		const rw = words(rule);
		let shared = 0;
		for (const w of cw) if (rw.has(w)) shared++;
		if (shared / cw.size > 0.7) return true;
	}
	return false;
}

function appendLog(entry: Record<string, unknown>): void {
	try {
		fs.mkdirSync(DATA_DIR, { recursive: true });
		fs.appendFileSync(LOG_PATH, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
	} catch {
		/* best-effort */
	}
}

// ---------------------------------------------------------------------------
// Failure signatures

type Mechanism =
	| "args-invalid"
	| "not-found-file"
	| "not-found-cmd"
	| "syntax"
	| "timeout"
	| "permission"
	| "stale-anchor"
	| "network"
	| "gated"
	| "other";

const MECHANISM_PATTERNS: Array<[Mechanism, RegExp]> = [
	["gated", /blocked by consensus gate|verification gate|\[harness gate\]/i],
	["stale-anchor", /hashline|snapshot tag|stale.*(tag|anchor|line)|file (changed|drifted)|#tag/i],
	["args-invalid", /validation|invalid (params?|argument|input|type)|schema|required (property|parameter)|expected .* (got|received)|missing required/i],
	["not-found-cmd", /command not found|not recognized as an? (internal|external)|executable file not found|no such command/i],
	[
		"not-found-file",
		/no such file|enoent|file (not found|does not exist)|directory (not found|does not exist)|path ['"`]?[^\n]{0,260}['"`]? not found|cannot find (the )?(file|path|module)/i,
	],
	["syntax", /syntax error|unexpected (token|eof|end of)|parse error|unterminated|unmatched|bad substitution/i],
	["timeout", /timed? ?out|deadline exceeded/i],
	["permission", /permission denied|eacces|eperm|operation not permitted/i],
	["network", /econnrefused|econnreset|enotfound|fetch failed|socket hang ?up|network (error|unreachable)|getaddrinfo/i],
];

const AGENT_CAUSED: Record<Mechanism, boolean | undefined> = {
	"args-invalid": true,
	"not-found-cmd": true,
	"not-found-file": true,
	syntax: true,
	"stale-anchor": true,
	gated: true,
	timeout: false,
	network: false,
	permission: undefined,
	other: undefined,
};

export function classifyFailure(errorText: string): Mechanism {
	for (const [mechanism, pattern] of MECHANISM_PATTERNS) {
		if (pattern.test(errorText)) return mechanism;
	}
	return "other";
}

/**
 * Assisted steering for not-found-file: pull the attempted path out of the
 * error text and embed a real (capped) listing of its parent directory, so
 * the model stops guess-and-checking paths and reads the actual filesystem.
 */
function extractMissingPath(errorText: string): string | undefined {
	const patterns = [
		/(?:cat|ls|stat|rm|cp|mv|python3?|node|bun|head|tail|grep)[^\n]*?:\s*([^\s:'"]+):\s*No such file/i,
		/['"`]([^'"`\n]+)['"`][^\n]{0,40}(?:No such file|not found|does not exist)/i,
		/(?:ENOENT|no such file or directory)[^\n]{0,30}['"`]?([/.][^\s'"`,)\]]+)/i,
		/([/.][\w./-]{2,}):\s*No such file/i,
	];
	for (const pattern of patterns) {
		const match = errorText.match(pattern);
		if (match?.[1] && match[1].length < 300) return match[1];
	}
	return undefined;
}

/** Fallback when error text yields nothing: pull the path operand off the command itself. */
function extractPathFromCommand(command: string): string | undefined {
	const match = command.match(
		/(?:cat|less|head|tail|stat|rm|cp|mv|cd|ls|python3?|node|bun|source|wc|grep)\s+(?:-[\w-]+\s+)*([^\s&|>;'"]+)/,
	);
	const candidate = match?.[1];
	if (candidate && candidate.length < 300 && /[./]/.test(candidate)) return candidate;
	return undefined;
}

function listParentDir(missingPath: string, cwd: string): string | undefined {
	const resolved = path.isAbsolute(missingPath) ? missingPath : path.resolve(cwd, missingPath);
	let dir = path.dirname(resolved);
	if (!fs.existsSync(dir)) dir = cwd;
	try {
		const out = spawnSync("ls", ["-F"], { cwd: dir, encoding: "utf8", timeout: 3_000 });
		if (out.status !== 0) return undefined;
		const entries = out.stdout.split("\n").filter(Boolean);
		const shown = entries.slice(0, 30).join("  ");
		const more = entries.length > 30 ? `  …(+${entries.length - 30} more)` : "";
		return `Actual contents of ${dir}/: ${shown}${more}`;
	} catch {
		return undefined;
	}
}

/**
 * Library detection for context7 routing. Scans an edit/write payload or a
 * bash install command for external-dependency names. Returns a deduped lowercase
 * list capped at 5 names (the nudge becomes noise past that). Empty array = no
 * library work detected.
 */
const STDLIB_SKIP = new Set([
	// Node builtins (with and without `node:` prefix).
	"fs", "path", "os", "child_process", "crypto", "http", "https", "stream", "url", "util", "events",
	"buffer", "process", "querystring", "zlib", "readline", "assert", "net", "dgram", "tls", "timers",
	"vm", "worker_threads", "async_hooks", "perf_hooks", "string_decoder", "punycode", "v8", "repl",
	"tty", "dns", "module", "constants", "domain",
	"node:fs", "node:path", "node:os", "node:child_process", "node:crypto", "node:http", "node:https",
	"node:stream", "node:url", "node:util", "node:events", "node:buffer", "node:process", "node:assert",
	"node:net", "node:dgram", "node:tls", "node:timers", "node:vm", "node:worker_threads",
	"node:async_hooks", "node:perf_hooks", "node:string_decoder", "node:punycode", "node:v8", "node:repl",
	"node:tty", "node:dns", "node:module", "node:constants", "node:querystring", "node:zlib", "node:readline",
	// Python stdlib (common — extend liberally; false negatives just nudge once per session,
	// false positives don't nudge at all, so over-skipping costs nothing).
	"os", "sys", "re", "json", "math", "time", "datetime", "collections", "itertools", "functools",
	"pathlib", "subprocess", "typing", "random", "string", "io", "logging", "argparse", "csv", "asyncio",
	"dataclasses", "enum", "hashlib", "base64", "tempfile", "shutil", "glob", "warnings", "traceback",
	"abc", "copy", "ast", "inspect", "contextlib", "weakref", "threading", "multiprocessing", "queue",
	"socket", "ssl", "select", "signal", "struct", "array", "bisect", "heapq", "statistics", "fractions",
	"decimal", "numbers", "operator", "types", "importlib", "pickle", "pkgutil", "platform", "gc",
	"atexit", "gettext", "locale", "textwrap", "pprint", "reprlib", "difflib", "secrets", "hmac", "uuid",
	"urllib", "email", "mailbox", "mimetypes", "xml", "html", "sqlite3", "dbm", "shelve", "zipfile",
	"tarfile", "gzip", "bz2", "lzma", "configparser", "tomllib", "venv", "code", "calendar", "zoneinfo",
	"fnmatch", "linecache", "filecmp", "stat", "fileinput", "tokenize", "keyword", "errno", "ctypes",
	"unittest", "doctest", "concurrent",
	// Rust core
	"std", "core", "alloc",
	// Common pseudo-identifiers that match an import-style regex but aren't libraries.
	// These show up in heredocs / docstrings / comments and would false-positive otherwise.
	"bug", "test", "tests", "main", "lib", "src", "app", "tmp", "data", "init", "log", "logs",
	"args", "name", "type", "value", "config", "settings", "utils", "helpers", "models", "views",
	"index", "default", "common", "shared", "core", "base", "module", "modules", "package", "packages",
	"foo", "bar", "baz", "qux", "example", "examples", "sample", "samples", "demo", "test1", "test2",
	"hello", "world", "ok", "yes", "no", "true", "false", "null", "none", "self", "this",
	// Relative imports
	".", "..",
]);
const LIB_NAME_RE = /^[a-z0-9@][a-z0-9._@/-]*$/i;
// A library name must be at least this many chars to be worth nudging on.
// Without this guard, identifiers like "x", "a", "go" produce noisy false positives.
const LIB_NAME_MIN_LENGTH = 3;
export function extractLibrariesFromCode(text: string): string[] {
	const hits = new Set<string>();
	const patterns: RegExp[] = [
		// ES/TS imports — `import X from "lib"`, `import {x} from "lib"`, `import "lib"`.
		// No anchor: semicolon-separated imports on one line must all match.
		/\bimport\s+(?:[^"'`\n;]+?\s+from\s+)?["'`]([^"'`\n]+)["'`]/g,
		// CJS — bare require call.
		/\brequire\(\s*["'`]([^"'`\n]+)["'`]\s*\)/g,
		// Python — `from X import ...` (X is an identifier, no quotes; can't collide with ES).
		/\bfrom\s+([a-zA-Z_][\w.]*)\s+import\b/g,
		// Python — `import X` or `import X, Y`. Statement-start anchor (line
		// start or after `;`) prevents matching `from X import Y` (the `import`
		// keyword in that form is not at statement start). The trailing
		// terminator requirement prevents matching ES `import X from "..."`.
		/(?:^|[\n;])\s*import\s+([a-zA-Z_][\w.]*(?:\s*,\s*[a-zA-Z_][\w.]*)*)\s*(?:as\s|;|\n|$)/g,
		// Rust — `use foo::...` or `use foo;`.
		/\buse\s+([a-zA-Z_][\w]*)(?:\s*::|\s*;)/g,
	];
	for (const re of patterns) {
		let match: RegExpExecArray | null;
		while ((match = re.exec(text))) {
			// Python `import a, b, c` — split the captured list.
			for (const raw of match[1].split(/\s*,\s*/)) {
				let name = raw.trim();
				if (name.startsWith("./") || name.startsWith("../") || name.startsWith("/")) continue;
				// `@scope/pkg/sub` -> `@scope/pkg`; `lodash/get` -> `lodash`; `a.b.c` -> `a`.
				if (name.startsWith("@")) {
					const segs = name.split("/");
					name = segs.length >= 2 ? `${segs[0]}/${segs[1]}` : name;
				} else if (name.includes("/")) {
					name = name.split("/")[0];
				} else if (name.includes(".")) {
					name = name.split(".")[0];
				}
				name = name.toLowerCase();
				if (!LIB_NAME_RE.test(name)) continue;
				if (name.length < LIB_NAME_MIN_LENGTH) continue;
				if (STDLIB_SKIP.has(name)) continue;
				hits.add(name);
				if (hits.size >= 5) return [...hits];
			}
		}
	}
	return [...hits];
}

export function extractLibrariesFromInstallCommand(command: string): string[] {
	const hits = new Set<string>();
	// npm/pnpm/yarn/bun add|install [flags] pkg1 pkg2 ...
	const jsRe = /\b(?:npm|pnpm|yarn|bun)\s+(?:add|install|i)\b([^\n&|;]*)/gi;
	// pip install pkg1 pkg2 ...
	const pyRe = /\bpip3?\s+install\b([^\n&|;]*)/gi;
	// cargo add pkg1 ...
	const cargoRe = /\bcargo\s+add\b([^\n&|;]*)/gi;
	for (const re of [jsRe, pyRe, cargoRe]) {
		let match: RegExpExecArray | null;
		while ((match = re.exec(command))) {
			for (const tok of match[1].split(/\s+/)) {
				// Strip version specifiers: `pkg@^5`, `pkg==1.2.3`, `pkg>=2`.
				// `@scope/pkg@^5` keeps the leading @scope; only strip the SECOND @.
				let cleaned = tok.replace(/[=<>!~^].*$/, "").trim();
				if (cleaned.length > 1) {
					const atIdx = cleaned.indexOf("@", 1);
					if (atIdx > 0) cleaned = cleaned.slice(0, atIdx);
				}
				if (!cleaned || cleaned.startsWith("-")) continue;
				if (cleaned.endsWith(".txt") || cleaned.endsWith(".toml") || cleaned.endsWith(".json")) continue;
				const name = cleaned.toLowerCase();
				if (!LIB_NAME_RE.test(name)) continue;
				if (name.length < LIB_NAME_MIN_LENGTH) continue;
				if (STDLIB_SKIP.has(name)) continue;
				hits.add(name);
				if (hits.size >= 5) return [...hits];
			}
		}
	}
	return [...hits];
}

export function isManifestPath(p: string): boolean {
	return /(?:^|\/)(?:package\.json|requirements\.txt|requirements-[^/]+\.txt|Cargo\.toml|pyproject\.toml|Pipfile|go\.mod)$/.test(p);
}

/**
 * Mangled-path auto-correction. Local models under DRY sampling corrupt
 * oft-repeated paths character-by-character ("companycam" → "c1ompanycam",
 * "ViewModel" → "ViewMoodel" — observed live 2026-06-11, 10 consecutive
 * mangled read calls ended in a failure-streak abort). The model cannot fix
 * this itself: the sampler is steering it OFF the correct tokens. So the
 * harness fixes the call: resolve each missing path segment to its closest
 * real directory entry (bounded edit distance) and rewrite the input in place.
 */
function levenshteinBounded(a: string, b: string, max: number): number {
	if (Math.abs(a.length - b.length) > max) return max + 1;
	let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		const cur = [i];
		let rowMin = i;
		for (let j = 1; j <= b.length; j++) {
			cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
			if (cur[j] < rowMin) rowMin = cur[j];
		}
		if (rowMin > max) return max + 1;
		prev = cur;
	}
	return prev[b.length];
}

/** Closest directory entry to `segment` within a bounded edit distance, or undefined. */
function bestEntryMatch(dir: string, segment: string): string | undefined {
	let entries: string[];
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return undefined;
	}
	const lower = segment.toLowerCase();
	const caseInsensitive = entries.find(e => e.toLowerCase() === lower);
	if (caseInsensitive) return caseInsensitive;
	// Allow ~1 edit per 4 chars, min 1, max 3 — enough for DRY corruption
	// ("c1ompanycam", "Moode1") without jumping to unrelated files.
	const cap = Math.min(3, Math.max(1, Math.floor(segment.length / 4)));
	let best: string | undefined;
	let bestDistance = cap + 1;
	let ties = 0;
	for (const entry of entries) {
		const d = levenshteinBounded(entry.toLowerCase(), lower, cap);
		if (d < bestDistance) {
			bestDistance = d;
			best = entry;
			ties = 0;
		} else if (d === bestDistance) {
			ties++;
		}
	}
	// Ambiguous match (two entries equally close) is worse than no match.
	return bestDistance <= cap && ties === 0 ? best : undefined;
}

/**
 * Repair a non-existent path segment-by-segment. Returns the corrected
 * absolute path (with any `:line-range` suffix preserved) or undefined if the
 * path exists, is unfixable, or needs more than 3 segment corrections.
 */
export function autocorrectPath(rawPath: string, cwd: string): string | undefined {
	const suffixMatch = rawPath.match(/^(.*?)(:\d+(?:-\d+)?)$/);
	const bare = suffixMatch ? suffixMatch[1] : rawPath;
	const suffix = suffixMatch ? suffixMatch[2] : "";
	if (!bare || bare.length > 500) return undefined;
	const abs = path.isAbsolute(bare) ? path.normalize(bare) : path.resolve(cwd, bare);
	if (fs.existsSync(abs)) return undefined; // nothing to fix
	const segments = abs.split(path.sep).filter(Boolean);
	let current = path.sep;
	let corrections = 0;
	for (const segment of segments) {
		const next = path.join(current, segment);
		if (fs.existsSync(next)) {
			current = next;
			continue;
		}
		const match = bestEntryMatch(current, segment);
		if (!match) return undefined;
		corrections++;
		if (corrections > 3) return undefined;
		current = path.join(current, match);
	}
	if (corrections === 0 || !fs.existsSync(current)) return undefined;
	return current + suffix;
}

const STEERING_HINTS: Partial<Record<Mechanism, string>> = {
	"not-found-file": "[harness hint] Path was wrong — list the parent directory (ls/glob) to find the real path before retrying. Do not retry the same path.",
	"not-found-cmd": "[harness hint] That binary is not installed or misspelled — run `which <cmd>` or use an installed alternative before retrying.",
	"args-invalid": "[harness hint] The tool rejected these arguments — re-check the tool's parameter schema and fix the named field. Do not resend identical arguments.",
	"stale-anchor": "[harness hint] The file changed since you read it — re-read it to get fresh line numbers, then re-issue the edit against current content.",
	syntax: "[harness hint] The command/payload had a syntax error — for multi-line or heavily-quoted commands, write a script file with the write tool and execute that instead.",
	timeout: "[harness hint] The operation timed out — narrow its scope (smaller file set, single test) or raise the timeout, rather than repeating it unchanged.",
};

/**
 * omp's bash tool reports a failing COMMAND (nonzero exit) as a successful
 * TOOL call: isError stays false and details.exitCode carries the code. The
 * healing layer must treat those as failures too.
 */
function isFailedResult(toolName: string, result: unknown, isError: boolean): boolean {
	if (isError) return true;
	if (toolName !== "bash") return false;
	const details = (result as { details?: { exitCode?: number } } | undefined)?.details;
	return typeof details?.exitCode === "number" && details.exitCode !== 0;
}

function normalizeCallHash(toolName: string, input: unknown): string {
	let body = "";
	try {
		body = JSON.stringify(input) ?? "";
	} catch {
		body = String(input);
	}
	return `${toolName}:${body.slice(0, 400)}`;
}

/**
 * Strip per-call noise (artifact ids, wall times, timestamps) so two runs of
 * the same command with the same real output fingerprint identically. Without
 * this the success-loop breaker never fires: every bash result embeds an
 * incrementing `artifact://N` and a wall time (observed live 2026-06-11:
 * 14 identical `find` calls sailed through undetected).
 */
export function normalizeResultNoise(s: string): string {
	return s
		.replace(/artifact:\/\/\d+/g, "artifact://N")
		.replace(/wall time:?\s*[\d.]+\s*(seconds|secs|s|ms)\b/gi, "wallTime")
		.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, "TS")
		.replace(/\b\d+(\.\d+)?\s*(ms|milliseconds)\b/gi, "DUR");
}

function compactVerifyFailureExcerpt(result: unknown): string | undefined {
	const content = (result as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content;
	let raw = Array.isArray(content)
		? content
				.filter(block => block?.type === "text" && typeof block.text === "string")
				.map(block => block.text)
				.join("\n")
		: "";
	if (!raw) {
		try {
			raw = typeof result === "string" ? result : (JSON.stringify(result) ?? "");
		} catch {
			raw = String(result ?? "");
		}
	}
	const lines = normalizeResultNoise(raw)
		.replace(/\r/g, "\n")
		.split("\n")
		.map(line => line.trim())
		.filter(line => line.length > 0 && !/^\[raw output: artifact:\/\/N\]$/i.test(line));
	const chosen =
		lines.find(line => /(error|failed|exception|traceback|panic|not found|expected|FAIL\b)/i.test(line)) ??
		lines[0];
	if (!chosen) return undefined;
	return chosen.length > 220 ? `${chosen.slice(0, 217)}...` : chosen;
}

// Degenerate-generation constants — shared by the stream breaker (abort the
// generation) and the context scrub (remove the repetition from later
// requests so it can't re-poison the model).
const REP_PROBE = 240; // chars; a verbatim 240-char triplet is never legitimate prose
const REP_MIN_OCCURRENCES = 3;

/**
 * Collapse a degenerate verbatim-repetition tail: if the trailing REP_PROBE
 * chars of `text` occur >= REP_MIN_OCCURRENCES times, keep everything up to
 * the end of the FIRST occurrence and append a harness note. Returns the
 * collapsed text, or undefined when the text is not degenerate.
 */
export function collapseDegenerateTail(
	text: string,
	probeLen = REP_PROBE,
	minOccurrences = REP_MIN_OCCURRENCES,
): string | undefined {
	if (text.length < probeLen * minOccurrences) return undefined;
	const probe = text.slice(-probeLen);
	const first = text.indexOf(probe);
	if (first === -1 || first >= text.length - probeLen) return undefined;
	let count = 0;
	let idx = 0;
	while ((idx = text.indexOf(probe, idx)) !== -1) {
		count++;
		idx += 1;
	}
	if (count < minOccurrences) return undefined;
	return (
		text.slice(0, first + probeLen) +
		"\n\n[harness: truncated — the model repeated the preceding text verbatim in a degenerate loop; the repetitions were removed from context]"
	);
}

/** Fingerprint of a tool result with per-call noise removed. */
export function resultFingerprint(value: unknown): string {
	let s = "";
	try {
		s = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
	} catch {
		s = String(value);
	}
	return fingerprint(normalizeResultNoise(s));
}

/** FNV-1a over the full string — cheap fingerprint for results and request contexts. */
function fingerprint(value: unknown): string {
	let s = "";
	try {
		s = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
	} catch {
		s = String(value);
	}
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return `${(h >>> 0).toString(36)}:${s.length}`;
}

const ESSENTIAL_TOOLS = new Set(["bash", "read", "edit", "write", "todo", "consensus", "task", "search", "grep", "find", "ls"]);

const VERIFY_COMMAND_RE =
	/\b(?:(?:npm|bun|pnpm|yarn)\s+(?:run\s+)?(?:test|build|lint|typecheck|check)|pytest|jest|vitest|cargo\s+(?:test|check|build|clippy)|go\s+(?:test|build|vet|run)|make(?:\s+\S+)?$|tsc\b|biome\s+(?:check|ci)|eslint|ruff\s+(?:check|format)|mvn\s+(?:test|verify)|gradle\w*\s+\S*(?:test|check|build|assemble|bundle)\w*|ctest|mix\s+test|rspec|phpunit|python3?\s+(?:-m\s+\S+|\S+\.py)|node\s+\S+\.[cm]?js|bun\s+\S+\.[jt]s|(?:ba)?sh\s+\S+\.sh)\b/;

// ---------------------------------------------------------------------------
// Model helpers

function extractText(message: AssistantMessage): string {
	const content = message.content as Array<{ type: string; text?: string }>;
	return content
		.filter(block => block.type === "text" && typeof block.text === "string")
		.map(block => block.text)
		.join("\n")
		.trim();
}

async function resolvePanel(config: Config, ctx: ExtensionContext): Promise<Model<any>[]> {
	const resolved: Model<any>[] = [];
	for (const selector of config.panelModels) {
		const slash = selector.indexOf("/");
		if (slash <= 0) continue;
		const model = ctx.modelRegistry.find(selector.slice(0, slash), selector.slice(slash + 1));
		if (model && ctx.modelRegistry.hasConfiguredAuth(model)) resolved.push(model);
	}
	if (resolved.length === 0 && ctx.model && ctx.modelRegistry.hasConfiguredAuth(ctx.model)) {
		resolved.push(ctx.model);
	}
	return resolved;
}

const PERSONAS = [
	{
		name: "Skeptic",
		prompt:
			"You are a relentless skeptic reviewing an engineering decision. Your job is to find what is wrong, risky, or unproven in the leading approach. Attack hidden assumptions, failure modes, and irreversibility. If the approach survives your attack, say so plainly. End with VERDICT: <one-sentence position>.",
	},
	{
		name: "Pragmatist",
		prompt:
			"You are a pragmatic senior engineer. Identify the simplest approach that fully solves the problem, what can be deferred, and where effort is being wasted. Prefer boring, reversible moves. End with VERDICT: <one-sentence position>.",
	},
	{
		name: "Specialist",
		prompt:
			"You are a correctness and security specialist. Evaluate the options strictly for correctness, data safety, security, and long-term maintenance burden. Flag anything that risks data loss or silent corruption. End with VERDICT: <one-sentence position>.",
	},
];

/** Review-mode personas, used when the consensus call carries code/diff. */
const REVIEW_PERSONAS = [
	{
		name: "Bug Hunter",
		prompt:
			"You are reviewing code for CORRECTNESS BUGS only: off-by-one errors, unhandled edge cases (empty/zero/negative inputs, None/null ambiguity), broken invariants, race conditions, resource leaks. Quote the exact line for every finding. No style commentary. If you find no bugs, say so plainly. End with VERDICT: <one-sentence position>.",
	},
	{
		name: "Simplifier",
		prompt:
			"You are reviewing code for SIMPLICITY and IDIOM: dead code, needless abstraction, non-idiomatic constructs the standard library already solves, misleading names, missing or wrong docstrings/types. Quote the exact line for every finding. Do not invent requirements. End with VERDICT: <one-sentence position>.",
	},
	{
		name: "Adversarial User",
		prompt:
			"You are reviewing code as a hostile caller: what inputs, call orders, or states break it? Invalid constructor args, mutation during iteration, huge inputs, concurrent use, type confusion. Quote the exact line each break occurs at. Rank findings by likelihood in real use. End with VERDICT: <one-sentence position>.",
	},
];

interface PanelAnswer {
	persona: string;
	model: string;
	text: string;
	error?: string;
}

async function runConsensus(
	question: string,
	context: string,
	config: Config,
	ctx: ExtensionContext,
	onPanelist?: (answer: PanelAnswer) => void,
	code?: string,
): Promise<{ report: string; agreement: number; dissent: string }> {
	const panel = await resolvePanel(config, ctx);
	if (panel.length === 0) {
		throw new Error("consensus: no panel model with configured credentials (check panelModels in config.json)");
	}

	const personas = code ? REVIEW_PERSONAS : PERSONAS;
	let userBlock = context ? `${question}\n\n<context>\n${context}\n</context>` : question;
	if (code) userBlock += `\n\n<code>\n${code.slice(0, 24_000)}\n</code>`;
	const calls = personas.map(async (persona, index): Promise<PanelAnswer> => {
		const model = panel[index % panel.length];
		const label = `${model.provider}/${model.id}`;
		try {
			const apiKey = await ctx.modelRegistry.getApiKey(model);
			const message = await completeSimple(
				model,
				{
					systemPrompt: persona.prompt,
					messages: [{ role: "user", content: userBlock, timestamp: Date.now() }],
				} as any,
				{ apiKey, temperature: 0.9, signal: AbortSignal.timeout(config.panelTimeoutMs) } as any,
			);
			const answer = { persona: persona.name, model: label, text: extractText(message) };
			onPanelist?.(answer);
			return answer;
		} catch (error) {
			const answer = {
				persona: persona.name,
				model: label,
				text: "",
				error: error instanceof Error ? error.message : String(error),
			};
			onPanelist?.(answer);
			return answer;
		}
	});

	const answers = await Promise.all(calls);
	const usable = answers.filter(a => a.text.length > 0);
	if (usable.length === 0) {
		throw new Error(`consensus: all panelists failed (${answers.map(a => a.error).join("; ")})`);
	}

	let synthesizer = ctx.model && ctx.modelRegistry.hasConfiguredAuth(ctx.model) ? ctx.model : panel[0];
	if (config.synthesizerModel) {
		const slash = config.synthesizerModel.indexOf("/");
		const custom =
			slash > 0
				? ctx.modelRegistry.find(config.synthesizerModel.slice(0, slash), config.synthesizerModel.slice(slash + 1))
				: undefined;
		if (custom && ctx.modelRegistry.hasConfiguredAuth(custom)) synthesizer = custom;
	}
	const transcript = usable.map(a => `### ${a.persona} (${a.model})\n${a.text}`).join("\n\n");
	const apiKey = await ctx.modelRegistry.getApiKey(synthesizer);
	const synthesis = await completeSimple(
		synthesizer,
		{
			systemPrompt: code
				? "You are the synthesis judge of a code-review panel. Merge the panelists' findings, discard duplicates and pedantry, and produce:\n" +
					"AGREEMENT: <0-100, how aligned the panel is>\n" +
					"FINDINGS: <numbered list of real issues worth fixing, each with the quoted line and a one-line fix; omit non-issues>\n" +
					"DISSENT: <a finding the panel disagreed on, 1-2 sentences, or 'none'>\n" +
					"ACTION: <fix now / fix the top finding only / ship as-is — pick one with a one-line reason>"
				: "You are the synthesis judge of a consensus panel. Read the panelists' independent positions and produce:\n" +
					"AGREEMENT: <0-100, how aligned the panel is>\n" +
					"CONSENSUS: <the position the evidence best supports, 2-4 sentences>\n" +
					"DISSENT: <the strongest unresolved objection, 1-2 sentences, or 'none'>\n" +
					"ACTION: <the single concrete next step>",
			messages: [
				{
					role: "user",
					content: `Question:\n${userBlock}\n\nPanel positions:\n\n${transcript}`,
					timestamp: Date.now(),
				},
			],
		} as any,
		{ apiKey, signal: AbortSignal.timeout(config.panelTimeoutMs) } as any,
	);
	const verdict = extractText(synthesis);
	const agreementMatch = verdict.match(/AGREEMENT:\s*(\d{1,3})/i);
	const agreement = agreementMatch ? Math.min(100, Number(agreementMatch[1])) / 100 : 0.5;
	const dissentMatch = verdict.match(/DISSENT:\s*([^\n]+)/i);
	const dissent = dissentMatch ? dissentMatch[1].trim() : "none";

	const failures = answers.filter(a => a.error).map(a => `(${a.persona} failed: ${a.error})`);
	const report = [`## Consensus verdict`, verdict, "", `## Panel`, transcript, ...failures].join("\n");
	return { report, agreement, dissent };
}

// ---------------------------------------------------------------------------
// Destructive-command detection

const DESTRUCTIVE_PATTERNS: RegExp[] = [
	/\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)[a-z]*\s+(?!\/tmp\/|\.\/node_modules|node_modules)/i,
	/\bgit\s+push\s+[^\n]*(--force\b|-f\b)/i,
	/\bgit\s+reset\s+--hard\b/i,
	/\bgit\s+clean\s+-[a-z]*f/i,
	/\bgit\s+branch\s+-D\b/i,
	/\bdd\s+[^\n]*of=\/dev\//i,
	/\bmkfs(\.|\s)/i,
	/\bshred\b/i,
	/\b(DROP|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA)\b/i,
	/\bDELETE\s+FROM\s+\w+\s*;?\s*$/i,
	/\bchmod\s+-R\s+777\s+\//i,
];

function findDestructive(command: string): string | undefined {
	for (const pattern of DESTRUCTIVE_PATTERNS) {
		const match = command.match(pattern);
		if (match) return match[0];
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Bash pre-flight hygiene (local models emit these artifacts under stress)

function bashHygieneIssue(command: string): string | undefined {
	const trimmed = command.trimStart();
	if (trimmed.startsWith("```")) return "command starts with a markdown code fence (```) — resend the raw command with no fences";
	if (/\n```\s*$/.test(command) || /^```\s*$/m.test(command.slice(3))) {
		if (command.includes("```")) return "command contains markdown code fences (```) — resend the raw command with no fences";
	}
	if (/^\$\s+\S/.test(trimmed)) return 'command starts with a "$ " shell-prompt artifact — remove the leading "$ "';
	const heredocs = command.match(/<<-?\s*['"]?(\w+)['"]?/g);
	if (heredocs) {
		for (const h of heredocs) {
			const tag = h.replace(/<<-?\s*['"]?/, "").replace(/['"]$/, "");
			const tagRe = new RegExp(`^\\s*${tag}\\s*$`, "m");
			if (!tagRe.test(command)) return `heredoc <<${tag} is never terminated — add a line containing only ${tag}`;
		}
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// System-prompt doctrine

const DOCTRINE = `## Consensus protocol (consensus-evolve extension)
You have a \`consensus\` tool: it fans your question out to an independent model panel (skeptic / pragmatist / specialist) and returns a synthesized verdict with the agreement level and strongest dissent.
Call it BEFORE committing when a decision is (a) architecturally load-bearing, (b) irreversible or destructive, (c) something you've failed at 2+ times in a row, or (d) one where you notice real uncertainty in your own reasoning. Do NOT call it for routine edits, lookups, or anything trivially reversible.
Destructive shell commands (force-push, rm -rf outside /tmp, hard reset, DROP TABLE, ...) are gated: they are blocked unless a consensus ran in the last few minutes. If blocked, run \`consensus\` on whether/how to proceed, then retry.
Treat a verdict with agreement < 60% as a yellow flag: present the dissent to the user instead of pushing through.

## Completion discipline (self-healing harness)
Marking a todo item done is gated: you must have run a passing verification command (test / build / lint / typecheck, exit 0) shortly before. Run the verification FIRST, then mark done.
If a tool call fails, read the [harness hint] in the result and change something before retrying — an identical retry of a failed call will be blocked.

## When stuck: research before retrying
After 2 failed attempts at the same thing, STOP guessing and gather outside information:
- \`web_search\` — search for the exact error message or symptom (SearXNG is configured; no API key needed). Quote the error verbatim in the query.
- Context7 MCP (\`resolve-library-id\` then \`query-docs\`) — for anything involving a library, framework, or API: current docs beat your training data. Use it BEFORE writing dependency-specific code you are unsure about.
- Sequential-thinking MCP (\`sequentialthinking\`) — when the problem is reasoning-shaped rather than information-shaped: decompose it step by step, revise earlier steps as evidence arrives, THEN act.
Pick by failure type: unknown error/behavior → web_search; library/API usage → Context7; confused plan or contradictory evidence → sequential thinking. Cite what you found in one line before applying it.

## Quality pass
After an implementation passes its tests, do one quality pass before declaring done: run the project formatter/linter if one exists, and re-read your diff for dead code, missing edge cases (empty/zero/negative inputs, invalid constructor args), and misleading names.
For load-bearing or multi-file implementations, call the \`consensus\` tool with the code in the \`code\` parameter — the panel switches to review mode (bug hunter / simplifier / adversarial user) and returns concrete findings. Fix real findings before marking done; ignore pedantry.`;

// ---------------------------------------------------------------------------
// Reflection / evolution

async function reflect(
	stats: SessionStats,
	config: Config,
	ctx: ExtensionContext,
	trigger: string,
	logger: { info(msg: string, meta?: unknown): void; warn(msg: string, meta?: unknown): void },
): Promise<number> {
	if (config.evolution !== "on") return 0;
	if (stats.toolCalls < 10 && stats.corrections.length === 0) return 0;
	const model = ctx.model;
	if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) return 0;

	const existing = readRules();
	const clusters = [...stats.signatures.entries()]
		.sort((a, b) => b[1].count - a[1].count)
		.slice(0, 6)
		.map(([sig, cluster]) => ({ signature: sig, count: cluster.count, samples: cluster.samples }));
	const summary = {
		toolCalls: stats.toolCalls,
		toolErrors: stats.toolErrors,
		healInterventions: stats.healEvents,
		verifyGateBlocks: stats.verifyBlocks,
		userCorrections: stats.corrections.slice(-5),
		failureClusters: clusters,
		consensusDissents: stats.consensusRuns.filter(r => r.dissent !== "none").map(r => r.dissent),
	};
	const apiKey = await ctx.modelRegistry.getApiKey(model);
	const message = await completeSimple(
		model,
		{
			systemPrompt:
				"You are the self-improvement reflex of a coding agent harness. The trajectory below includes clustered failure signatures (tool:mechanism, with counts and samples). Distill AT MOST 3 durable, generalizable working rules that would have prevented the highest-count failure clusters. Each rule must start with the cluster it targets in brackets, e.g. [bash:not-found-cmd]. Rules must be imperative, one line each, specific enough to act on, and NOT restate the existing rules. If nothing durable was learned, output NONE.\nOutput format: one rule per line, no numbering, no commentary.",
			messages: [
				{
					role: "user",
					content: `Trajectory:\n${JSON.stringify(summary, null, 2)}\n\nExisting rules:\n${existing.join("\n") || "(none)"}`,
					timestamp: Date.now(),
				},
			],
		} as any,
		{ apiKey, signal: AbortSignal.timeout(25_000), disableReasoning: true } as any,
	);
	const text = extractText(message);
	if (!text || /^\s*NONE\s*$/i.test(text)) return 0;

	const date = new Date().toISOString().slice(0, 10);
	const candidates = text
		.split("\n")
		.map(line => line.replace(/^[-*\d.\s]+/, "").trim())
		.filter(line => line.length > 15 && line.length < 300)
		.slice(0, 3);

	let added = 0;
	const rules = readRules();
	for (const candidate of candidates) {
		if (isDuplicateRule(candidate, rules)) continue;
		// "candidate" status: the ablation gate (ablate.ts) promotes to
		// "validated" or archives to losers.md based on with/without runs.
		rules.push(`- ${candidate} _(learned ${date}, ${trigger}, candidate)_`);
		added++;
	}
	if (added > 0) {
		while (rules.length > config.maxRules) rules.shift();
		writeRules(rules);
		appendLog({ kind: "reflect", trigger, added, summary });
		logger.info("consensus-evolve: learned rules", { added, trigger });
	}
	return added;
}

// ---------------------------------------------------------------------------
// Extension entry

export default function consensusEvolve(pi: ExtensionAPI): void {
	pi.setLabel("Consensus + Evolve");
	const config = loadConfig();
	const stats = freshStats();
	// Session cwd — captured from the first ctx-bearing event and reused in
	// places (buildDoctrineMessage, session_start log) that don't otherwise
	// have a ctx in scope. omp sessions cannot change cwd mid-session, so
	// once latched it stays correct.
	let sessionCwd = process.cwd();
	let sessionCwdLatched = false;
	function latchCwd(ctx: { cwd?: string } | undefined): void {
		if (sessionCwdLatched) return;
		const cwd = ctx?.cwd;
		if (typeof cwd === "string" && cwd.length > 0) {
			sessionCwd = cwd;
			sessionCwdLatched = true;
			// One-shot migration of the pre-cwd-scoping single-file plan.
			migrateLegacyPlan(sessionCwd);
		}
	}

	// ---- consensus tool -----------------------------------------------------
	pi.registerTool({
		name: "consensus",
		label: "Consensus Panel",
		description:
			"Convene an independent multi-model panel (skeptic / pragmatist / specialist) on a decision and return a synthesized verdict with agreement level and strongest dissent. Use for load-bearing, irreversible, or repeatedly-failing decisions — not routine work.",
		approval: "read",
		parameters: pi.zod.z.object({
			question: pi.zod.z.string().describe("The decision or question to put to the panel"),
			context: pi.zod.z
				.string()
				.optional()
				.describe("Relevant context: constraints, options considered, evidence, prior failures"),
			code: pi.zod.z
				.string()
				.optional()
				.describe(
					"Code or diff to review. When provided, the panel switches to code-review mode (bug hunter / simplifier / adversarial user) and returns concrete findings with quoted lines.",
				),
		}),
		execute: async (_toolCallId, params, _signal, onUpdate, ctx) => {
			const done: string[] = [];
			try {
				const { report, agreement, dissent } = await runConsensus(
					params.question,
					params.context ?? "",
					config,
					ctx,
					answer => {
						done.push(`${answer.persona}${answer.error ? " ✗" : " ✓"}`);
						onUpdate?.({
							isPartial: true,
							partialResult: { content: [{ type: "text", text: `Panel: ${done.join(", ")}` }] },
						});
					},
					params.code,
				);
				stats.lastConsensusAt = Date.now();
				stats.consensusRuns.push({ question: params.question.slice(0, 120), agreement, dissent });
				return { content: [{ type: "text", text: report }], details: { agreement, dissent } };
			} catch (error) {
				// A throw here used to surface as "Tool returned an invalid result:
				// missing content array" — useless to the model. Return a real,
				// actionable result instead (observed when the panel models share
				// a busy llama-swap and every panelist times out).
				const message = error instanceof Error ? error.message : String(error);
				appendLog({ kind: "heal", type: "consensus-error", error: message.slice(0, 300) });
				return {
					content: [
						{
							type: "text",
							text:
								`[consensus error] ${message}\n` +
								"The panel is unavailable (likely busy/overloaded local models). Do NOT retry consensus now. " +
								"Proceed with your own best judgment: prefer the reversible/safer option, state your reasoning in one line, and continue.",
						},
					],
					details: { agreement: 0, dissent: "panel-unavailable" },
				};
			}
		},
	});

	// ---- pre-execution gates (tool_call) --------------------------------------
	// Hash is computed ONCE here from the raw input and remembered by call id;
	// execution args are transformed downstream and would hash differently.
	const callHashById = new Map<string, string>();
	// toolCallId -> original mangled path, so the result can tell the model.
	const autoCorrectNotes = new Map<string, { original: string; corrected: string }>();
	// Calls blocked by THIS harness. Their error results are steering, not model
	// failures — counting them spirals gate-blocks into repeat-call blocks and a
	// failure-streak abort on already-completed work (observed live 2026-06-12:
	// 3 verify-gate blocks fed failedCallHashes, the repeat-call breaker then
	// blocked the retry that would have hit force-allow, streak rode to 10).
	const harnessBlockedIds = new Set<string>();
	function blockCall(toolCallId: string, reason: string): { block: true; reason: string } {
		harnessBlockedIds.add(toolCallId);
		if (harnessBlockedIds.size > 200) {
			const oldest = harnessBlockedIds.values().next().value;
			if (oldest !== undefined) harnessBlockedIds.delete(oldest);
		}
		return { block: true, reason };
	}
	pi.on("tool_call", async (event, ctx) => {
		const input = event.input as Record<string, unknown> | undefined;

		// -1. Sequentialthinking unmask: the model finally called the tool. Lift
		// the mandatory mask (if active), restore the previous tool set, and
		// clear seq-think counters so future stuck streaks restart from zero.
		if (
			stats.seqThinkMandatoryActive &&
			/sequential.*think|think.*sequential/i.test(event.toolName)
		) {
			try {
				if (stats.preMandatoryToolSnapshot) {
					await pi.setActiveTools(stats.preMandatoryToolSnapshot);
				}
				stats.preMandatoryToolSnapshot = null;
				stats.seqThinkMandatoryActive = false;
				stats.seqThinkNudgeCount.clear();
				appendLog({ kind: "heal", type: "seq-think-mandatory-unmask", tool: event.toolName });
			} catch (error) {
				pi.logger.warn("consensus-evolve: seq-think unmask failed", { error: String(error) });
			}
		}

		// 0. Mangled-path heal: rewrite a corrupted path to the closest real one
		// BEFORE hashing, so the corrected call participates in dedup/loop logic
		// as what actually runs. event.input is the same object the tool will
		// execute with (verified: HookToolWrapper passes params by reference),
		// so in-place mutation IS the fix. read/edit only — write creates paths.
		if ((event.toolName === "read" || event.toolName === "edit") && typeof input?.path === "string") {
			const corrected = autocorrectPath(input.path, ctx.cwd);
			if (corrected && corrected !== input.path) {
				const original = input.path;
				input.path = corrected;
				autoCorrectNotes.set(event.toolCallId, { original, corrected });
				if (autoCorrectNotes.size > 50) {
					const oldest = autoCorrectNotes.keys().next().value;
					if (oldest !== undefined) autoCorrectNotes.delete(oldest);
				}
				stats.healEvents++;
				appendLog({
					kind: "heal",
					type: "path-autocorrect",
					tool: event.toolName,
					from: original.slice(-160),
					to: corrected.slice(-160),
				});
			}
		}

		// 1. Repeat-call breaker: identical call that already failed twice.
		const hash = normalizeCallHash(event.toolName, event.input);
		callHashById.set(event.toolCallId, hash);
		if (callHashById.size > 200) {
			const oldest = callHashById.keys().next().value;
			if (oldest !== undefined) callHashById.delete(oldest);
		}
		const failed = stats.failedCallHashes.get(hash);
		if (failed && failed.fails >= 2 && !failed.blockedOnce) {
			failed.blockedOnce = true;
			stats.healEvents++;
			appendLog({ kind: "heal", type: "repeat-call-breaker", tool: event.toolName, fails: failed.fails });
			return blockCall(
				event.toolCallId,
				`[harness gate] This exact ${event.toolName} call has already failed ${failed.fails} times. ` +
					"Repeating it unchanged will fail again. Change the arguments or the approach (re-read the error, inspect state first, or run `consensus` if stuck).",
			);
		}

		// 1b. Success-loop breaker: identical call that keeps SUCCEEDING with an
		// identical result. Common with small local models: they re-issue the same
		// tool call after every result and never advance. Two identical results
		// prove no new information — block the next identical attempt.
		if (config.toolLoopBreaker !== "off") {
			const dupes = stats.recentCalls.filter(c => c.hash === hash);
			if (dupes.length >= config.toolLoopThreshold - 1) {
				const lastTwo = dupes.slice(-2);
				if (lastTwo.length === 2 && lastTwo[0].resultFp === lastTwo[1].resultFp) {
					const blocks = (stats.loopBlocks.get(hash) ?? 0) + 1;
					stats.loopBlocks.set(hash, blocks);
					stats.healEvents++;
					appendLog({ kind: "heal", type: "tool-loop-breaker", tool: event.toolName, occurrences: dupes.length, blocks });

					// Escalation ladder — blocks alone don't stop a model that
					// can't change course (observed live: todo loop, block 5+).
					// Block 3: mask the tool so the call CANNOT be issued again
					// (loop-masking deliberately ignores ESSENTIAL_TOOLS — the
					// loop proves this tool isn't essential right now). The
					// verify-pass unmask path restores it.
					if (blocks === 3 && !stats.maskedTools.has(event.toolName)) {
						try {
							const active = pi.getActiveTools();
							if (active.includes(event.toolName)) {
								await pi.setActiveTools(active.filter(name => name !== event.toolName));
								stats.maskedTools.set(event.toolName, stats.toolCalls);
								appendLog({ kind: "heal", type: "tool-loop-mask", tool: event.toolName });
								pi.sendMessage(
									{
										customType: "consensus-evolve-nudge",
										content: `[consensus-evolve] Tool loop: \`${event.toolName}\` re-issued identically despite ${blocks} blocks — tool deactivated until a verification command passes. Continue the actual task without it.`,
										display: true,
									},
									{ triggerTurn: false },
								);
							}
						} catch (error) {
							pi.logger.warn("consensus-evolve: loop mask failed", { error: String(error) });
						}
					}
					// Block 5: masking didn't take (or the runtime re-exposed the
					// tool) and the model is still wedged — stop the turn.
					if (blocks >= 5) {
						stats.autoContinues = config.announceContinueMax;
						appendLog({ kind: "heal", type: "tool-loop-abort", tool: event.toolName, blocks });
						pi.sendMessage(
							{
								customType: "consensus-evolve-nudge",
								content: `[consensus-evolve] Aborted: \`${event.toolName}\` loop survived ${blocks} blocks and a tool mask. The model cannot break free of this context — rephrase the request or switch model (Ctrl+P).`,
								display: true,
							},
							{ triggerTurn: false },
						);
						ctx.abort();
						return blockCall(event.toolCallId, "[harness gate] Loop abort — agent stopped.");
					}
					return blockCall(
						event.toolCallId,
						`[harness gate] LOOP (block ${blocks}): this exact ${event.toolName} call already ran ${dupes.length} times and returned the SAME result each time. ` +
							"Re-running it cannot produce new information. State what you learned from the last result, then take a DIFFERENT action: " +
							"different arguments, a different tool, `web_search` the blocker, check docs via Context7, or report your conclusion to the user. Do not issue this call again.",
					);
				}
			}
		}

		// 2. Bash-specific gates.
		if (event.toolName === "bash" && typeof input?.command === "string") {
			const command = input.command;

			if (config.preflightBashHygiene) {
				const issue = bashHygieneIssue(command);
				if (issue) {
					stats.healEvents++;
					appendLog({ kind: "heal", type: "preflight-bash", issue, command: command.slice(0, 200) });
					return blockCall(event.toolCallId, `[harness gate] Malformed command: ${issue}. Then retry.`);
				}
			}

			if (config.destructiveGate !== "off") {
				const hit = findDestructive(command);
				if (hit && Date.now() - stats.lastConsensusAt >= config.gateCooldownMs) {
					return blockCall(
						event.toolCallId,
						`Destructive command blocked by consensus gate (matched: "${hit}"). ` +
							`Run the \`consensus\` tool on whether/how to proceed (include the exact command and blast radius as context), then retry. ` +
							`A verdict unlocks destructive commands for ${Math.round(config.gateCooldownMs / 60000)} minutes.`,
					);
				}
			}
		}

		// 3. Verification-before-completion: gate todo op:"done".
		if (
			config.verifyBeforeDone !== "off" &&
			event.toolName === "todo" &&
			Array.isArray(input?.ops) &&
			(input.ops as Array<{ op?: string }>).some(op => op?.op === "done")
		) {
			const verifiedRecently =
				stats.lastVerifyOkAtCall >= 0 && stats.toolCalls - stats.lastVerifyOkAtCall <= config.verifyWindowToolCalls;
			if (!verifiedRecently && stats.verifyBlocks < config.maxVerifyBlocks) {
				stats.verifyBlocks++;
				appendLog({ kind: "verify-gate", blocks: stats.verifyBlocks });
				return blockCall(
					event.toolCallId,
					"[harness gate] Completion blocked: no passing verification command (test/build/lint/typecheck, exit 0) ran in the " +
						`last ${config.verifyWindowToolCalls} tool calls. Run the project's verification command first; if it passes, mark done. ` +
						`(${config.maxVerifyBlocks - stats.verifyBlocks} block(s) remaining before force-allow.)`,
				);
			}
		}

		// 4. Library → context7 steer (steer-only, no block). When the model
		// touches an external library (import/require/install/manifest), nudge
		// it once per library per session to verify current API via context7
		// before the edit lands. A subsequent context7 call (resolve-library-id
		// or query-docs) marks the library "verified" and suppresses the nudge.
		const isContext7Call =
			/(^|[_/.:-])context7([_/.:-]|$)/i.test(event.toolName) ||
			event.toolName === "resolve-library-id" ||
			event.toolName === "query-docs";
		if (isContext7Call) {
			// Mark every string-valued arg as a verified library token. This is
			// lossy but cheap; we just need overlap with what we'd nudge next.
			const args = input ?? {};
			for (const value of Object.values(args)) {
				if (typeof value !== "string") continue;
				const tokens = value.toLowerCase().match(/[a-z0-9@][a-z0-9@/._-]{1,40}/g);
				for (const tok of tokens ?? []) stats.context7Verified.add(tok);
			}
		} else {
			let libs: string[] = [];
			if ((event.toolName === "edit" || event.toolName === "write") && typeof input?.content === "string") {
				libs = extractLibrariesFromCode(input.content as string);
				if (typeof input?.path === "string" && isManifestPath(input.path as string)) {
					// Manifest edits without import lines should still nudge once.
					if (libs.length === 0) libs = ["__manifest__"];
				}
			} else if (event.toolName === "bash" && typeof input?.command === "string") {
				// Bash covers three library-touching patterns: (a) package installs
				// (`npm install`, `pip install`, ...); (b) heredoc / printf file
				// writes containing import / require statements (local-secondary prefers this
				// over the edit tool); (c) manifest creation via redirect.
				const cmd = input.command as string;
				libs = extractLibrariesFromInstallCommand(cmd);
				if (libs.length === 0) {
					const codeLibs = extractLibrariesFromCode(cmd);
					if (codeLibs.length > 0) libs = codeLibs;
				}
				if (libs.length === 0) {
					const redirectMatch = cmd.match(/>\s*([^\s|&;<>]+)/);
					if (redirectMatch && isManifestPath(redirectMatch[1])) libs = ["__manifest__"];
				}
			}
			if (libs.length > 0) {
				const unseen = libs.filter(
					name => !stats.context7Verified.has(name) && !stats.context7Hinted.has(name),
				);
				if (unseen.length > 0) {
					for (const name of unseen) stats.context7Hinted.add(name);
					stats.healEvents++;
					appendLog({ kind: "heal", type: "context7-nudge", libs: unseen, tool: event.toolName });
					const label = unseen[0] === "__manifest__"
						? "the dependency manifest you're editing"
						: unseen.map(n => `\`${n}\``).join(", ");
					pi.sendMessage(
						{
							customType: "consensus-evolve-nudge",
							content:
								`[consensus-evolve] You're touching ${label} — verify the current API via Context7 BEFORE this edit lands ` +
								"(`resolve-library-id` → `query-docs`). Your training data may not reflect the installed version. This nudge fires once per library per session.",
							display: true,
						},
						{ triggerTurn: false },
					);
				}
			}
		}

		return undefined;
	});

	// ---- doctrine + learned rules into context ------------------------------
	// Ablation toggles (set by ablate.ts per arm):
	//   CE_RULES_OFF=1            -> inject doctrine but NO learned rules
	//   CE_ABLATE_DISABLE=<n>     -> omit rule n (1-based, /evolve review order)
	const ablateRulesOff = process.env.CE_RULES_OFF === "1";
	const ablateDisableIndex = Number(process.env.CE_ABLATE_DISABLE) || 0;

	const CE_MARKER = "<!--consensus-evolve-doctrine-->";
	// KV-cache locality: the doctrine message must be BYTE-STABLE across turns
	// or every turn pays a full local prefill. Rules are snapshotted once per
	// session (in append order — appends are the prefix-stable layout; sorting
	// would shift tokens). Mid-session reflection writes to disk for the NEXT
	// session; /evolve now|prune explicitly refresh the snapshot.
	let doctrineSnapshot: string | undefined;
	function refreshDoctrineSnapshot(): void {
		doctrineSnapshot = undefined;
	}
	function buildDoctrineMessage(): { role: "user"; content: string; timestamp: number; attribution: "agent" } {
		if (doctrineSnapshot === undefined) {
			let text = `<system-directive>\n${CE_MARKER}\n${DOCTRINE}`;
			let rules = ablateRulesOff ? [] : readRules();
			if (ablateDisableIndex > 0) rules = rules.filter((_, i) => i !== ablateDisableIndex - 1);
			if (rules.length > 0) {
				let block = "\n\n## Learned rules (earned from past sessions — follow unless the user overrides)\n";
				for (const rule of rules) {
					if (block.length + rule.length > config.maxInjectedRulesChars) break;
					block += `${rule}\n`;
				}
				text += block.trimEnd();
			}
			// Active plan recitation: surface the current phase + next phase so the
			// model stays anchored to the planned step instead of drifting. The
			// harness auto-driver advances currentPhase when the phase's verify
			// command passes. Plans are cwd-scoped (per-project file).
			const plan = readActivePlan(sessionCwd);
			if (plan) {
				const cur = plan.phases[plan.currentPhase];
				const next = plan.phases[plan.currentPhase + 1];
				const total = plan.phases.length;
				let pblock = `\n\n## Active plan (phase ${plan.currentPhase + 1}/${total})\n`;
				pblock += `OVERALL GOAL: ${plan.task.slice(0, 400)}\n\n`;
				pblock += `[CURRENT PHASE ${plan.currentPhase + 1}/${total}] ${cur.name}\n`;
				pblock += `VERIFY: ${cur.verify}\n`;
				pblock += `BRIEF:\n${cur.brief}\n`;
				if (next) {
					pblock += `\n[NEXT PHASE ${plan.currentPhase + 2}/${total}] ${next.name} — will start automatically once the current verify passes.\n`;
				} else {
					pblock += `\n(This is the FINAL phase. Verify passing ends the plan.)\n`;
				}
				pblock += "\nWork ONLY on the current phase. Do not skip ahead. When the VERIFY command exits 0, the harness will auto-advance.";
				text += pblock;
			}
			text += "\n</system-directive>";
			doctrineSnapshot = text;
		}
		return { role: "user", content: doctrineSnapshot, timestamp: 0, attribution: "agent" };
	}

	// Auto-retry replays (transport errors, 429s) legitimately resend the same
	// context — those must not count toward the request-loop breaker.
	pi.on("auto_retry_start", async () => {
		stats.inAutoRetry = true;
	});
	pi.on("auto_retry_end", async () => {
		stats.inAutoRetry = false;
	});

	pi.on("context", async (event, ctx) => {
		const messages = event.messages;
		latchCwd(ctx);

		// Stale-plan auto-archive. Plans are now stored PER-CWD so unrelated
		// projects can't leak — but a plan written for THIS cwd in a previous
		// session might still be stale (different task, same project). Two
		// independent staleness signals — either triggers archive:
		//   1. CWD mismatch: plan's recorded cwd != current ctx.cwd. Should be
		//      rare with per-cwd storage but kept as a belt-and-braces check.
		//   2. Content non-overlap: incoming first user message shares no
		//      meaningful contiguous substring with the plan's task.
		if (!stats.planSuggestSent) {
			const stale = readActivePlan(ctx.cwd ?? sessionCwd);
			if (stale) {
				const firstNonDoctrineUser = messages.find(m => {
					const msg = m as { role?: string; content?: unknown };
					if (msg.role !== "user") return false;
					const c = msg.content;
					if (typeof c === "string") return !c.includes(CE_MARKER) && c.trim().length > 0;
					if (Array.isArray(c)) {
						for (const block of c) {
							const b = block as { type?: string; text?: string };
							if (b.type === "text" && typeof b.text === "string" && !b.text.includes(CE_MARKER) && b.text.trim().length > 0) return true;
						}
					}
					return false;
				});
				if (firstNonDoctrineUser) {
					const incoming = (typeof (firstNonDoctrineUser as { content?: unknown }).content === "string"
						? ((firstNonDoctrineUser as { content: string }).content)
						: ((firstNonDoctrineUser as { content: Array<{ type?: string; text?: string }> }).content
							.filter(b => b.type === "text").map(b => b.text ?? "").join("\n"))
					).slice(0, 400).toLowerCase();
					const known = stale.task.slice(0, 400).toLowerCase();
					const cwd = (ctx.cwd ?? sessionCwd).toLowerCase();

					// Signal 1: stored-cwd vs current-cwd mismatch (cheap, exact).
					const storedCwd = (stale.cwd ?? "").toLowerCase();
					const cwdMismatch = storedCwd.length > 0 && cwd.length > 0 && storedCwd !== cwd;

					// Signal 2: content overlap (loose, catches same-cwd stale plans).
					const contentOverlap = incoming.length > 8 && known.length > 8 && (
						incoming.includes(known.slice(0, Math.min(40, known.length))) ||
						known.includes(incoming.slice(0, Math.min(40, incoming.length)))
					);

					if (cwdMismatch || !contentOverlap) {
						try {
							const planPath = planPathForCwd(ctx.cwd ?? sessionCwd);
							const archive = `${planPath}.stale-${Date.now()}.archived`;
							if (fs.existsSync(planPath)) fs.renameSync(planPath, archive);
							refreshDoctrineSnapshot();
							appendLog({
								kind: "plan-stale-archived",
								reason: { cwdMismatch, contentOverlap, cwd, storedCwd, incomingHead: incoming.slice(0, 80), knownHead: known.slice(0, 80) },
							});
						} catch {
							/* best-effort */
						}
					}
				}
			}
		}

		// First-prompt plan auto-create. The `input` event only fires for the
		// "interactive" source — `omp -p` headless mode bypasses it entirely, so
		// auto-plan never ran on -p prompts. The context event fires in BOTH
		// modes, so we run the first-prompt detection here exactly once per
		// session. Pulls the first non-doctrine user message as the task text.
		// User content can be a bare string OR an array of text/image blocks.
		if (!stats.planSuggestSent) {
			const userContentToText = (content: unknown): string => {
				if (typeof content === "string") return content;
				if (Array.isArray(content)) {
					return content
						.map(block => {
							const b = block as { type?: string; text?: string };
							return b.type === "text" && typeof b.text === "string" ? b.text : "";
						})
						.join("\n");
				}
				return "";
			};
			let text = "";
			for (const m of messages) {
				const msg = m as { role?: string; content?: unknown };
				if (msg.role !== "user") continue;
				const raw = userContentToText(msg.content);
				if (raw.includes(CE_MARKER)) continue; // skip doctrine
				if (raw.trim().length === 0) continue;
				text = raw.trim();
				break;
			}
			if (text.length > 0) {
				stats.planSuggestSent = true;
				if (!readActivePlan(ctx.cwd ?? sessionCwd)) {
					const lengthHit = text.length > 200;
					const numberedListHit = /(^|\n)\s*(?:1[.)]|\*|-)\s+\S[\s\S]*?\n\s*2[.)]/.test(text);
					const connectorHits = (text.match(/\b(?:and then|then|after that|next,|also,)\b/gi) ?? []).length;
					const andCount = (text.match(/\band\b/gi) ?? []).length;
					const multiVerbHit = /\b(?:add|implement|build|create|fix|refactor|migrate|update|write|set\s+up|wire|test|deploy)\b/gi;
					const verbHits = (text.match(multiVerbHit) ?? []).length;
					const multiStep =
						numberedListHit ||
						connectorHits >= 2 ||
						(lengthHit && (andCount >= 2 || verbHits >= 3)) ||
						verbHits >= 4;
					if (multiStep) {
						const headless = !ctx.hasUI;
						const autoCreate =
							config.autoPlan === "on" || (config.autoPlan === "headless-only" && headless);
						if (autoCreate) {
							appendLog({
								kind: "plan-auto-create-start",
								reason: { lengthHit, numberedListHit, connectorHits, andCount, verbHits, headless },
							});
							// Fire-and-forget: omp enforces a 30s handler timeout but the
							// planner LLM call takes 30-90s. Awaiting here gets the handler
							// killed and the request aborted (observed live). Instead let
							// the first turn proceed without the plan, write active-plan.json
							// in the background, and let the doctrine recitation on later
							// turns pick it up. The model burns 1-2 turns of throwaway work,
							// but for a multi-minute task that's a rounding error vs the
							// alternative (no plan at all because of the timeout).
							void createPlanFromTask(text, ctx, { seedPhase1: false })
								.then(res => {
									if ("error" in res) {
										appendLog({ kind: "plan-auto-create-failed", error: res.error });
										return;
									}
									appendLog({ kind: "plan-auto-create-ok", phases: res.plan.phases.length });
									refreshDoctrineSnapshot();
									pi.sendMessage(
										{
											customType: "consensus-evolve-nudge",
											content:
												`[plan-mode] Auto-built ${res.plan.phases.length}-phase plan in the background. Plan is now visible in your context — re-read the system directive and switch to working PHASE-BY-PHASE. The harness auto-advances when each phase's VERIFY command exits 0.`,
											display: true,
										},
										{ triggerTurn: false },
									);
								})
								.catch(err => {
									appendLog({
										kind: "plan-auto-create-failed",
										error: String(err).slice(0, 200),
									});
								});
						} else {
							appendLog({
								kind: "plan-suggest",
								reason: { lengthHit, numberedListHit, connectorHits, andCount, verbHits },
							});
							pi.sendMessage(
								{
									customType: "consensus-evolve-nudge",
									content:
										"[plan-mode] This looks like multi-step work. Consider running `/plan <one-line task>` first — the planner breaks it into verifiable phases and the harness auto-advances through them.",
									display: true,
								},
								{ triggerTurn: false },
							);
						}
					}
				}
			}
		}

		// Request-loop breaker: the same context sent over and over means the
		// model's responses are producing nothing usable (e.g. local-primary emitting
		// unparseable tool calls -> omp drops them -> identical re-request,
		// forever, ~5s apart). Tool-level gates never fire because no tool call
		// materializes — this is the only place that sees the loop.
		const fp = fingerprint(messages);
		if (stats.inAutoRetry) {
			// don't count, don't reset — a retry burst shouldn't clear a real streak
		} else if (fp === stats.requestLoop.fp) {
			stats.requestLoop.repeats++;
			if (stats.requestLoop.repeats >= config.requestLoopAbortAt) {
				stats.requestLoop = { fp: "", repeats: 0 };
				stats.autoContinues = config.announceContinueMax;
				stats.healEvents++;
				appendLog({ kind: "heal", type: "request-loop-abort", repeats: config.requestLoopAbortAt });
				pi.sendMessage(
					{
						customType: "consensus-evolve-nudge",
						content:
							`[consensus-evolve] Aborted: the agent sent the identical request to the model ${config.requestLoopAbortAt} times in a row with no usable response (likely malformed/empty tool calls from a local model). ` +
							"Try rephrasing the prompt, or switch model (Ctrl+P) — this context may be poisoned for this model.",
						display: true,
					},
					{ triggerTurn: false },
				);
				ctx.abort();
			}
		} else {
			stats.requestLoop = { fp, repeats: 0 };
		}

		const filtered = messages.filter(
			m =>
				!(
					typeof (m as { content?: unknown }).content === "string" &&
					(m as { content: string }).content.includes(CE_MARKER)
				),
		);

		// Degenerate-tail scrub: an aborted degenerate generation leaves a wall
		// of verbatim repetition in the session; replaying it re-poisons the
		// model on every later turn (and survives compaction — observed live:
		// fill -> auto-compact -> re-loop death spiral). Collapse the repetition
		// out of the OUTGOING context only; the session file keeps the evidence.
		// Messages here are clones, but clone may be shallow — never mutate.
		const scrubbed = filtered.map(m => {
			const msg = m as { role?: string; content?: unknown };
			if (msg.role !== "assistant" || !Array.isArray(msg.content)) return m;
			let changed = false;
			const content = (msg.content as Array<Record<string, unknown>>).map(block => {
				const field = block.type === "text" ? "text" : block.type === "thinking" ? "thinking" : undefined;
				if (!field) return block;
				const blockText = block[field];
				if (typeof blockText !== "string" || blockText.length < REP_PROBE * REP_MIN_OCCURRENCES) return block;
				const collapsed = collapseDegenerateTail(blockText);
				if (collapsed === undefined) return block;
				changed = true;
				const fp = fingerprint(blockText);
				if (!stats.scrubLogged.has(fp)) {
					stats.scrubLogged.add(fp);
					stats.healEvents++;
					appendLog({ kind: "heal", type: "degenerate-context-scrub", before: blockText.length, after: collapsed.length });
				}
				return { ...block, [field]: collapsed };
			});
			if (!changed) return m;
			return { ...(m as object), content } as typeof m;
		});

		const out = [buildDoctrineMessage() as unknown as (typeof messages)[number], ...scrubbed];

		// Mid-streak steer: transiently append a corrective user message (context
		// replacements are not persisted to the session, so the fingerprint above
		// — computed on the incoming messages — keeps counting if this fails).
		if (
			config.requestLoopSteerAt > 0 &&
			stats.requestLoop.repeats >= config.requestLoopSteerAt &&
			stats.requestLoop.repeats < config.requestLoopAbortAt
		) {
			out.push({
				role: "user",
				content:
					"[harness] Your previous responses were empty or contained unparseable tool calls, so nothing was executed. " +
					"Respond with PLAIN TEXT first (one sentence on what you will do), then at most one simple, well-formed tool call.",
				timestamp: 0,
				attribution: "agent",
			} as unknown as (typeof messages)[number]);
		}

		return { messages: out };
	});

	// ---- result steering (tool_result) ----------------------------------------
	pi.on("tool_result", async (event, ctx) => {
		// Surface a path auto-correction so the model adopts the real path
		// instead of believing its mangled one worked.
		const autoCorrect = autoCorrectNotes.get(event.toolCallId);
		if (autoCorrect) {
			autoCorrectNotes.delete(event.toolCallId);
			return {
				content: [
					...(event.content ?? []),
					{
						type: "text",
						text:
							`[harness] The path you sent ("${autoCorrect.original}") does not exist — it was auto-corrected to "${autoCorrect.corrected}" and this result is from the corrected path. ` +
							"Your output is corrupting repeated paths; copy the corrected path exactly for future calls.",
					},
				],
			};
		}
		if (!config.resultSteering) return undefined;
		const text = (event.content ?? [])
			.map(block => (block as { type?: string; text?: string }).text ?? "")
			.join("\n");
		const failed =
			event.isError ||
			(event.toolName === "bash" &&
				(typeof (event.details as { exitCode?: number } | undefined)?.exitCode === "number"
					? (event.details as { exitCode: number }).exitCode !== 0
					: /Command exited with code [1-9]/.test(text)));
		if (!failed) return undefined;
		if (text.includes("[harness hint]") || text.includes("[harness gate]")) return undefined;
		const mechanism = classifyFailure(text);
		let hint = STEERING_HINTS[mechanism];
		if (!hint) return undefined;
		// Assisted steering: for missing paths, ship the real directory listing
		// with the error so the model reads the filesystem instead of guessing.
		if (mechanism === "not-found-file") {
			const command = (event.input as { command?: string } | undefined)?.command;
			const missing = extractMissingPath(text) ?? (command ? extractPathFromCommand(command) : undefined);
			if (missing) {
				const listing = listParentDir(missing, ctx.cwd);
				if (listing) hint = `[harness hint] "${missing}" not found. ${listing}\nUse one of these real paths; do not retry the guessed one.`;
			}
		}
		stats.healEvents++;
		appendLog({ kind: "heal", type: "result-steering", tool: event.toolName, mechanism, assisted: hint.includes("Actual contents") });
		return { content: [...(event.content ?? []), { type: "text", text: hint }] };
	});

	// ---- trajectory tracking ----------------------------------------------------
	// tool_execution_end carries no args; capture them at start, keyed by call id.
	const pendingArgs = new Map<string, unknown>();
	pi.on("tool_execution_start", async event => {
		pendingArgs.set(event.toolCallId, event.args);
		if (pendingArgs.size > 200) {
			const oldest = pendingArgs.keys().next().value;
			if (oldest !== undefined) pendingArgs.delete(oldest);
		}
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		latchCwd(ctx);
		stats.toolCalls++;
		const args = pendingArgs.get(event.toolCallId);
		pendingArgs.delete(event.toolCallId);
		const hash = callHashById.get(event.toolCallId) ?? normalizeCallHash(event.toolName, args);
		callHashById.delete(event.toolCallId);

		if (isFailedResult(event.toolName, event.result, event.isError)) {
			// Harness-induced block: the steering text already told the model what
			// to do. It must NOT count as a model failure — no failure streak, no
			// signature cluster, no repeat-call tracking (which would block the
			// very retry the verify gate's force-allow is waiting for).
			if (harnessBlockedIds.delete(event.toolCallId)) return;
			stats.toolErrors++;
			stats.failureStreak++;

			let errorText = "";
			try {
				errorText = JSON.stringify(event.result ?? "").slice(0, 500);
			} catch {
				errorText = String(event.result).slice(0, 500);
			}
			const mechanism = classifyFailure(errorText);
			const sig = `${event.toolName}:${mechanism}`;
			const command = (args as { command?: string } | undefined)?.command;
			const verifyCommand =
				event.toolName === "bash" && typeof command === "string" && VERIFY_COMMAND_RE.test(command)
					? command.trim()
					: "";
			if (verifyCommand && !stats.verifyFailureHinted.has(verifyCommand)) {
				stats.verifyFailureHinted.add(verifyCommand);
				const excerpt = compactVerifyFailureExcerpt(event.result);
				stats.healEvents++;
				appendLog({
					kind: "heal",
					type: "verify-feedback",
					command: verifyCommand.slice(0, 200),
					excerpt,
				});
				pi.sendMessage(
					{
						customType: "consensus-evolve-nudge",
						content:
							`[consensus-evolve] Verification failed for \`${verifyCommand}\`. Treat this as grader feedback, not just another tool error.` +
							(excerpt ? ` Excerpt: ${excerpt}` : "") +
							" Read the failing output, fix ONLY what this check proved, then rerun the SAME verification command. " +
							`Do not mark done or change plans until \`${verifyCommand}\` passes (exit 0).`,
						display: true,
					},
					{ triggerTurn: false },
				);
			}

			// Cluster.
			const cluster = stats.signatures.get(sig) ?? { count: 0, samples: [] };
			cluster.count++;
			if (cluster.samples.length < 3) cluster.samples.push(errorText.slice(0, 160));
			stats.signatures.set(sig, cluster);

			// Signature streak.
			if (stats.sigStreak.sig === sig) stats.sigStreak.count++;
			else stats.sigStreak = { sig, count: 1 };

			// Stuck → sequentialthinking nudge with mandatory-mask escalation.
			// At sigStreak >= 2 and once-per-turn-per-signature, we count cumulative
			// nudges for this signature this session. The first (mandatorySeqThinkAt - 1)
			// nudges are soft text. The Nth nudge MASKS every other tool except the
			// sequentialthinking MCP tool — the model literally can't do anything
			// else until it calls seq-think (the mask auto-clears at that point).
			// Safety: if no seq-think tool is present in the active list, never
			// mask (would lock the model out). Set mandatorySeqThinkAt=0 to disable
			// escalation and keep nudges soft forever.
			if (stats.sigStreak.count >= 2 && !stats.seqThinkHinted.has(sig)) {
				stats.seqThinkHinted.add(sig);
				const cumulative = (stats.seqThinkNudgeCount.get(sig) ?? 0) + 1;
				stats.seqThinkNudgeCount.set(sig, cumulative);
				stats.seqThinkNudgeTotal++;
				stats.healEvents++;
				// Mandatory mask fires on TOTAL nudges across the session (any signature),
				// not per-signature. The HM run demonstrated the per-signature threshold
				// is unreachable: each failure-streak-abort cycle hits different sigs, so
				// no single sig accumulates to 3 before the abort kills the turn. Total
				// nudges = "the model has been told N times to use seq-think and hasn't" —
				// that's the real signal for mandatory escalation.
				const wantMandatory =
					config.mandatorySeqThinkAt > 0 &&
					stats.seqThinkNudgeTotal >= config.mandatorySeqThinkAt &&
					!stats.seqThinkMandatoryActive;
				let masked = false;
				if (wantMandatory) {
					try {
						const active = pi.getActiveTools();
						const seqTool = active.find(n => /sequential.*think|think.*sequential/i.test(n));
						if (seqTool) {
							stats.preMandatoryToolSnapshot = active.slice();
							await pi.setActiveTools([seqTool]);
							stats.seqThinkMandatoryActive = true;
							masked = true;
							appendLog({
								kind: "heal",
								type: "seq-think-mandatory-mask",
								signature: sig,
								totalNudges: stats.seqThinkNudgeTotal,
								perSig: cumulative,
								tool: seqTool,
								restoreSize: active.length,
							});
							pi.sendMessage(
								{
									customType: "consensus-evolve-nudge",
									content:
										`[consensus-evolve] MANDATORY: ${stats.seqThinkNudgeTotal}× total nudges to call \`sequentialthinking\` have been ignored this session (currently stuck on \`${sig}\`). ` +
										`All other tools are now MASKED until you invoke \`${seqTool}\`. Decompose what the error actually says vs what you assumed, then the mask lifts and your tools come back.`,
									display: true,
								},
								{ triggerTurn: false },
							);
						} else {
							appendLog({
								kind: "heal",
								type: "seq-think-mandatory-unavailable",
								signature: sig,
								cumulative,
								reason: "no sequentialthinking tool in active list (MCP down?)",
							});
						}
					} catch (error) {
						pi.logger.warn("consensus-evolve: seq-think mandatory mask failed", { error: String(error) });
					}
				}
				if (!masked) {
					appendLog({
						kind: "heal",
						type: "stuck-seq-think-nudge",
						signature: sig,
						streak: stats.sigStreak.count,
						cumulative,
					});
					pi.sendMessage(
						{
							customType: "consensus-evolve-nudge",
							content:
								`[consensus-evolve] Stuck on \`${sig}\` (${stats.sigStreak.count}× streak, nudge ${cumulative}` +
								(config.mandatorySeqThinkAt > 0
									? `/${config.mandatorySeqThinkAt} before tools get masked`
									: "") +
								"). Stop retrying — call the `sequentialthinking` MCP tool to decompose what the error ACTUALLY says vs what you assumed, then take a different action.",
							display: true,
						},
						{ triggerTurn: false },
					);
				}
			}

			// Repeat-call tracking.
			const failed = stats.failedCallHashes.get(hash) ?? { fails: 0, blockedOnce: false };
			failed.fails++;
			stats.failedCallHashes.set(hash, failed);

			// Tool masking for non-essential tools on a same-signature streak.
			if (
				stats.sigStreak.count >= config.maskStreakThreshold &&
				!ESSENTIAL_TOOLS.has(event.toolName) &&
				!stats.maskedTools.has(event.toolName)
			) {
				try {
					const active = pi.getActiveTools();
					if (active.includes(event.toolName)) {
						await pi.setActiveTools(active.filter(name => name !== event.toolName));
						stats.maskedTools.set(event.toolName, stats.toolCalls);
						appendLog({ kind: "heal", type: "tool-mask", tool: event.toolName, signature: sig });
						stats.healEvents++;
						pi.sendMessage(
							{
								customType: "consensus-evolve-nudge",
								content: `[consensus-evolve] Tool \`${event.toolName}\` deactivated after ${stats.sigStreak.count} consecutive ${sig} failures. It will be re-enabled after a verification command passes. Use a different approach for now.`,
								display: true,
							},
							{ triggerTurn: false },
						);
					}
				} catch (error) {
					pi.logger.warn("consensus-evolve: tool mask failed", { error: String(error) });
				}
			}

			// Failure-streak abort: final backstop. 10 consecutive failures with
			// no successful call in between means the model is wedged (e.g. it
			// keeps calling a masked/unknown tool from stale context) — stop the
			// turn instead of burning the backend.
			if (stats.failureStreak >= 10) {
				// Pre-abort escalation: if seq-think hasn't been used yet AND the
				// MCP tool is present, force a mandatory mask instead of aborting.
				// The model gets one structured-thinking attempt before we give up
				// on this turn. This subsumes the per-signature mandatory threshold
				// for the failure-streak path — when the streak is THIS bad and the
				// model never tried decomposing the problem, masking is the last
				// resort before the abort.
				if (!stats.seqThinkMandatoryActive && config.mandatorySeqThinkAt > 0) {
					try {
						const active = pi.getActiveTools();
						const seqTool = active.find(n => /sequential.*think|think.*sequential/i.test(n));
						if (seqTool) {
							stats.preMandatoryToolSnapshot = active.slice();
							await pi.setActiveTools([seqTool]);
							stats.seqThinkMandatoryActive = true;
							stats.failureStreak = 0; // give the mask room to work
							appendLog({
								kind: "heal",
								type: "seq-think-pre-abort-mask",
								signature: stats.sigStreak.sig,
								totalNudges: stats.seqThinkNudgeTotal,
								tool: seqTool,
							});
							pi.sendMessage(
								{
									customType: "consensus-evolve-nudge",
									content:
										`[consensus-evolve] PRE-ABORT ESCALATION: 10 consecutive failures (dominant: ${stats.sigStreak.sig}), and you never called \`sequentialthinking\`. ` +
										`All other tools MASKED — invoke \`${seqTool}\` to decompose what's going wrong, or this turn will abort.`,
									display: true,
								},
								{ triggerTurn: false },
							);
							return;
						}
					} catch (error) {
						pi.logger.warn("consensus-evolve: pre-abort mask failed", { error: String(error) });
					}
				}
				stats.failureStreak = 0;
				stats.autoContinues = config.announceContinueMax;
				appendLog({ kind: "heal", type: "failure-streak-abort", signature: stats.sigStreak.sig });
				pi.sendMessage(
					{
						customType: "consensus-evolve-nudge",
						content:
							"[consensus-evolve] Aborted: 10 consecutive tool failures " +
							`(dominant signature: ${stats.sigStreak.sig}). The model cannot recover in this context — rephrase the request or switch model (Ctrl+P).`,
						display: true,
					},
					{ triggerTurn: false },
				);
				ctx.abort();
				return;
			}

			// Failure-streak nudge.
			if (stats.failureStreak === config.failureStreakNudge && stats.nudgesSent < 3) {
				stats.nudgesSent++;
				pi.sendMessage(
					{
						customType: "consensus-evolve-nudge",
						content:
							`[consensus-evolve] ${stats.failureStreak} consecutive tool failures (dominant signature: ${stats.sigStreak.sig}). ` +
							"Stop repeating the same approach: re-read the error and form a different hypothesis. If you don't understand the error, `web_search` its exact text; " +
							"if it involves a library/API, check current docs via Context7 (resolve-library-id → query-docs); if your plan feels confused, work it through with the sequentialthinking tool. " +
							"If the decision is load-bearing, run the `consensus` tool before continuing.",
						display: true,
					},
					{ triggerTurn: false },
				);
			}
		} else {
			stats.failureStreak = 0;
			stats.sigStreak = { sig: "", count: 0 };
			stats.failedCallHashes.delete(hash);

			// Feed the success-loop breaker: remember call + result fingerprint.
			stats.recentCalls.push({ hash, resultFp: resultFingerprint(event.result) });
			if (stats.recentCalls.length > 12) stats.recentCalls.shift();
			// A different successful call means the model broke its loop — reset
			// block counters so a later legitimate revisit isn't pre-punished.
			if (stats.loopBlocks.size > 0 && !stats.loopBlocks.has(hash)) stats.loopBlocks.clear();

			// Verification success?
			const command = (args as { command?: string } | undefined)?.command;
			const isBash = event.toolName === "bash" && typeof command === "string";

			// Plan-mode phase advance: when the active phase's verify command runs
			// successfully (substring-loose match so `cd dir && <verify>` still
			// counts), mark the phase complete, advance currentPhase, refresh the
			// doctrine snapshot, and trigger the next-phase brief as the next turn.
			let phaseAdvanced = false;
			if (isBash) {
				const planCwd = ctx.cwd ?? sessionCwd;
				const plan = readActivePlan(planCwd);
				if (plan && plan.currentPhase < plan.phases.length) {
					const cur = plan.phases[plan.currentPhase];
					const normCmd = (command as string).replace(/\s+/g, " ").trim();
					const normVerify = cur.verify.replace(/\s+/g, " ").trim();
					if (
						normVerify.length > 0 &&
						(normCmd === normVerify || normCmd.includes(normVerify) || normVerify.includes(normCmd))
					) {
						const completed = new Set(plan.completedPhases ?? []);
						completed.add(plan.currentPhase);
						const wasFinal = plan.currentPhase >= plan.phases.length - 1;
						if (wasFinal) {
							appendLog({ kind: "plan-completed", phases: plan.phases.length, task: plan.task.slice(0, 200) });
							clearActivePlan(planCwd);
							refreshDoctrineSnapshot();
							pi.sendMessage(
								{
									customType: "consensus-evolve-nudge",
									content:
										`[plan-mode] FINAL PHASE PASSED (${plan.phases.length}/${plan.phases.length}: ${cur.name}). ` +
										"Plan complete — overall verification green. You can stop now or report results to the user.",
									display: true,
								},
								{ triggerTurn: false },
							);
						} else {
							const nextIdx = plan.currentPhase + 1;
							const next = plan.phases[nextIdx];
							plan.completedPhases = [...completed];
							plan.currentPhase = nextIdx;
							writeActivePlan(plan, planCwd);
							refreshDoctrineSnapshot();
							appendLog({
								kind: "plan-phase-advance",
								from: nextIdx - 1,
								to: nextIdx,
								name: next.name,
							});
							pi.sendMessage(
								{
									customType: "consensus-evolve-nudge",
									content:
										`[plan-mode] PHASE ${nextIdx}/${plan.phases.length} PASSED (${cur.name}). Advancing.\n\n` +
										`PHASE ${nextIdx + 1}/${plan.phases.length}: ${next.name}\n\n${next.brief}\n\n` +
										`VERIFY (run this when done; the harness watches for exit 0 and auto-advances): ${next.verify}`,
									display: true,
								},
								{ triggerTurn: true, deliverAs: "nextTurn" },
							);
						}
						phaseAdvanced = true;
						stats.healEvents++;
					}
				}
			}

			const isVerifyMatch = isBash && VERIFY_COMMAND_RE.test(command as string);
			if (isVerifyMatch || phaseAdvanced) {
				stats.lastVerifyOkAtCall = stats.toolCalls;
				stats.verifyBlocks = 0;

				// Unmask any harness-masked tools.
				if (stats.maskedTools.size > 0) {
					try {
						const active = pi.getActiveTools();
						const restored = [...stats.maskedTools.keys()].filter(name => !active.includes(name));
						if (restored.length > 0) await pi.setActiveTools([...active, ...restored]);
						appendLog({ kind: "heal", type: "tool-unmask", tools: restored });
						stats.maskedTools.clear();
					} catch (error) {
						pi.logger.warn("consensus-evolve: tool unmask failed", { error: String(error) });
					}
				}
			}
		}
	});

	pi.on("input", async (event, ctx) => {
		latchCwd(ctx);
		stats.autoContinues = 0;
		stats.degenAborts = 0;
		// Per-turn reset: stuck nudges fire at most once per signature per turn so
		// the next user instruction can resurface the same hint if the model is
		// still stuck after redirection.
		stats.seqThinkHinted.clear();
		stats.verifyFailureHinted.clear();
		if (/^\s*(no\b|nope\b|wrong\b|stop\b|don'?t\b|not what)/i.test(event.text)) {
			stats.corrections.push(event.text.slice(0, 150));
		}
		// Plan mode on first input: detect multi-step intent, then either auto-CREATE
		// the plan (config.autoPlan="on" or "headless-only" + no UI) or fall back to a
		// suggest-nudge ("off" or "headless-only" + UI present). The auto path AWAITS
		// the planner so the model's first turn already sees the plan in its doctrine
		// — this is the lesson from the regex E2E where the nudge alone landed on a
		// model that couldn't act on it.
		if (!stats.planSuggestSent) {
			const text = (event.text ?? "").trim();
			if (text.length > 0) {
				stats.planSuggestSent = true; // fire at most once per session
				if (!readActivePlan(ctx.cwd ?? sessionCwd)) {
					const lengthHit = text.length > 200;
					const numberedListHit = /(^|\n)\s*(?:1[.)]|\*|-)\s+\S[\s\S]*?\n\s*2[.)]/.test(text);
					const connectorHits = (text.match(/\b(?:and then|then|after that|next,|also,)\b/gi) ?? []).length;
					const andCount = (text.match(/\band\b/gi) ?? []).length;
					const multiVerbHit = /\b(?:add|implement|build|create|fix|refactor|migrate|update|write|set\s+up|wire|test|deploy)\b/gi;
					const verbHits = (text.match(multiVerbHit) ?? []).length;
					const multiStep =
						numberedListHit ||
						connectorHits >= 2 ||
						(lengthHit && (andCount >= 2 || verbHits >= 3)) ||
						verbHits >= 4;
					if (multiStep) {
						const headless = !ctx.hasUI;
						const autoCreate =
							config.autoPlan === "on" || (config.autoPlan === "headless-only" && headless);
						if (autoCreate) {
							appendLog({
								kind: "plan-auto-create-start",
								reason: { lengthHit, numberedListHit, connectorHits, andCount, verbHits, headless },
							});
							// Fire-and-forget (matches the context-hook path): omp's 30s
							// extension-handler timeout would kill the planner mid-call.
							void createPlanFromTask(text, ctx, { seedPhase1: false })
								.then(res => {
									if ("error" in res) {
										appendLog({ kind: "plan-auto-create-failed", error: res.error });
										pi.sendMessage(
											{
												customType: "consensus-evolve-nudge",
												content:
													`[plan-mode] Auto-planning failed (${res.error}). Proceeding without a plan — consider running \`/plan <one-line task>\` manually.`,
												display: true,
											},
											{ triggerTurn: false },
										);
										return;
									}
									appendLog({ kind: "plan-auto-create-ok", phases: res.plan.phases.length });
									refreshDoctrineSnapshot();
									pi.sendMessage(
										{
											customType: "consensus-evolve-nudge",
											content:
												`[plan-mode] Auto-built ${res.plan.phases.length}-phase plan in the background. Re-read the system directive and switch to working PHASE-BY-PHASE; the harness auto-advances when each phase's VERIFY command exits 0.`,
											display: true,
										},
										{ triggerTurn: false },
									);
								})
								.catch(err => {
									appendLog({
										kind: "plan-auto-create-failed",
										error: String(err).slice(0, 200),
									});
								});
						} else {
							appendLog({
								kind: "plan-suggest",
								reason: { lengthHit, numberedListHit, connectorHits, andCount, verbHits },
							});
							pi.sendMessage(
								{
									customType: "consensus-evolve-nudge",
									content:
										"[plan-mode] This looks like multi-step work. Consider running `/plan <one-line task description>` first — the planner will break it into verifiable phases and the harness will auto-advance through them. " +
										"(One-time suggestion per session; ignore if it's actually a single change.)",
									display: true,
								},
								{ triggerTurn: false },
							);
						}
					}
				}
			}
		}
		return undefined;
	});

	// ---- degenerate-generation breaker (message_update) ------------------------
	// Observed live (example/project, local-primary): the model rambles in
	// circles INSIDE one generation — the same reasoning paragraphs re-emitted
	// verbatim until the context fills, auto-compaction runs, and the loop
	// restarts on the compacted (still poisoned) context. No request- or
	// tool-level breaker can see this; only the stream can. If the trailing
	// chunk of the streaming assistant text (text + thinking) already occurred
	// 3+ times in the same message, the generation is degenerate — abort now,
	// not at context exhaustion.
	const REP_CHECK_STEP = 2048; // re-scan every N new chars, keeps the check O(n) amortized
	let repWatch = { key: "", checkedAt: 0, fired: false };
	pi.on("message_update", async (event, ctx) => {
		const msg = event.message as { role?: string; id?: unknown; content?: unknown };
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) return;
		const text = (msg.content as Array<{ type?: string; text?: string; thinking?: string }>)
			.map(b => (b.type === "text" ? (b.text ?? "") : b.type === "thinking" ? (b.thinking ?? "") : ""))
			.join("\n");
		const key = String(msg.id ?? "current");
		if (repWatch.key !== key) repWatch = { key, checkedAt: 0, fired: false };
		if (repWatch.fired || text.length < REP_PROBE * 3 || text.length - repWatch.checkedAt < REP_CHECK_STEP) return;
		repWatch.checkedAt = text.length;
		const probe = text.slice(-REP_PROBE);
		let count = 0;
		let idx = 0;
		while ((idx = text.indexOf(probe, idx)) !== -1) {
			count++;
			idx += 1;
			if (count >= REP_MIN_OCCURRENCES) break;
		}
		if (count < REP_MIN_OCCURRENCES) return;
		repWatch.fired = true;
		stats.healEvents++;
		stats.degenAborts++;
		// Do not let announce-continue prod a poisoned context back to life —
		// recovery (if any) is scheduled explicitly below.
		stats.autoContinues = config.announceContinueMax;
		appendLog({ kind: "heal", type: "degenerate-generation-abort", textLength: text.length, n: stats.degenAborts });
		if (stats.degenAborts <= 2) {
			// RECOVER, don't strand: the context scrub removes the repetition
			// from the next request; deliverAs:"nextTurn" + triggerTurn queues an
			// internal continuation that fires AFTER the abort teardown (a plain
			// triggerTurn here would route to agent.steer() on the dying stream
			// and be swallowed — observed live 2026-06-11 16:32).
			// Second loop in a row: the same weights keep falling into the same
			// semantic attractor (scrub alone proved insufficient live) — switch
			// to an alternate model for the recovery turn.
			let switched = "";
			if (stats.degenAborts === 2) {
				try {
					const current = ctx.model;
					const all = ctx.modelRegistry.getAll();
					const alt =
						all.find(m => m.provider === current?.provider && m.id !== current?.id && /q\d+b/i.test(m.id)) ??
						all.find(m => m.provider === current?.provider && m.id !== current?.id);
					if (alt && (await pi.setModel(alt))) {
						switched = alt.id;
						appendLog({ kind: "heal", type: "degenerate-model-switch", from: current?.id, to: alt.id });
					}
				} catch (error) {
					pi.logger.warn("consensus-evolve: degenerate model switch failed", { error: String(error) });
				}
			}
			appendLog({ kind: "heal", type: "degenerate-recovery", n: stats.degenAborts });
			pi.sendMessage(
				{
					customType: "consensus-evolve-nudge",
					content:
						"[harness] Your previous response was cut off: it repeated the same text verbatim (degenerate loop). The repetition has been removed from your context. " +
						"Do NOT re-derive or re-explain anything. State your single best conclusion in ONE sentence, then immediately act on it with ONE tool call (read/edit/bash). " +
						"If you genuinely cannot decide between hypotheses, run the `consensus` tool with the specific question instead of reasoning further. " +
						(switched
							? `(degenerate-recovery ${stats.degenAborts}/2 — model switched to ${switched})`
							: `(degenerate-recovery ${stats.degenAborts}/2)`),
					display: true,
				},
				{ triggerTurn: true, deliverAs: "nextTurn" },
			);
		} else {
			pi.sendMessage(
				{
					customType: "consensus-evolve-nudge",
					content:
						"[consensus-evolve] Aborted: the model is repeating the same text verbatim inside one response (degenerate generation) and two scrubbed retries did not break the loop. " +
						"This context is poisoned for this model — rephrase the request more narrowly, /clear, or switch model (Ctrl+P).",
					display: true,
				},
				{ triggerTurn: false },
			);
		}
		ctx.abort();
	});


	// ---- announce-without-act continuation ------------------------------------
	// Observed live (example-project, local-primary): the model says "I found the bug.
	// Let me fix X" / "Let me cut through the noise" — then ends the turn with
	// ZERO tool calls and waits. Nothing loops, so no breaker fires; the user
	// sees the harness announce work and give up. When the agent loop ends on a
	// tool-free assistant message that declares an action, schedule a bounded
	// continuation that forces it to execute or name the blocker.
	const INTENT_RE =
		/\b(let me|let's|i['’]ll|i will|i am going to|i['’]m going to|now i(?:['’]ll| will)?|next,? i|first,? i|going to (?:check|read|look|fix|run|verify|trace|find|update|edit|write))\b/i;
	pi.on("agent_end", async event => {
		if (config.announceContinueMax <= 0) return;
		if (stats.autoContinues >= config.announceContinueMax) return;
		const last = [...event.messages].reverse().find(m => (m as { role?: string }).role === "assistant");
		if (!last) return;
		const content = (last as { content?: unknown }).content;
		if (!Array.isArray(content)) return;
		const blocks = content as Array<{ type?: string; text?: string }>;
		const calledTool = blocks.some(b => b.type === "toolCall" || b.type === "toolUse" || b.type === "tool_use");
		if (calledTool) return;
		const text = blocks
			.filter(b => b.type === "text" && typeof b.text === "string")
			.map(b => b.text as string)
			.join("\n")
			.trim();
		if (!text) return; // empty responses are the request-loop breaker's job
		const tail = text.slice(-400);
		if (!INTENT_RE.test(tail)) return; // no announced action near the end
		if (/\?\s*$/.test(text)) return; // it's asking the user something — legitimate stop
		stats.autoContinues++;
		stats.healEvents++;
		appendLog({ kind: "heal", type: "announce-continue", n: stats.autoContinues, tail: tail.slice(-160) });
		pi.sendMessage(
			{
				customType: "consensus-evolve-nudge",
				content:
					"[harness] You announced an action but ended the turn without executing it. Do not narrate — act. " +
					"Either perform the action NOW with tool calls (read/edit/bash), or state in one sentence exactly what is blocking you and what you need from the user. " +
					`(auto-continue ${stats.autoContinues}/${config.announceContinueMax})`,
				display: true,
			},
			{ triggerTurn: true },
		);
	});

	// ---- reflection triggers ------------------------------------------------------
	pi.on("turn_end", async (event, ctx) => {
		if (config.reflectEveryTurns <= 0) return;
		if (event.turnNumber === 0 || event.turnNumber % config.reflectEveryTurns !== 0) return;
		if (Date.now() - stats.lastReflectAt < 5 * 60_000) return;
		stats.lastReflectAt = Date.now();
		try {
			await reflect(stats, config, ctx, `turn ${event.turnNumber}`, pi.logger);
		} catch (error) {
			pi.logger.warn("consensus-evolve: reflection failed", { error: String(error) });
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		try {
			const added = await reflect(stats, config, ctx, "session end", pi.logger);
			// Close the Self-Harness loop: every freshly-learned rule goes to the
			// ablation gate unattended. Detached + lock-filed so concurrent
			// sessions can't stack GPU work.
			if (added > 0 && config.autoAblate === "on") {
				// Quiet hours only: ablation shares the single llama-swap slot
				// with live sessions, and a spawn-time idle check can't prevent
				// conflicts that develop mid-run (observed live 2026-06-11: an
				// auto-ablation starved an interactive session into 31s
				// first-token stream timeouts). /evolve validate <n> runs
				// anytime — that's a deliberate operator action.
				const hour = new Date().getHours();
				if (hour < 2 || hour >= 9) {
					appendLog({ kind: "auto-ablate-skipped", reason: "outside quiet hours (02:00-09:00)" });
					return;
				}
				const newest = readRules().length;
				const lockPath = path.join(DATA_DIR, "ablate.lock");
				if (!fs.existsSync(lockPath)) {
					const logPath = path.join(DATA_DIR, "ablation-run-auto.log");
					const child = spawn(
						"bash",
						[
							"-c",
							`bun ${path.join(DATA_DIR, "ablate.ts")} ${newest} --seeds ${config.autoAblateSeeds} --model ${config.panelModels[0] ?? "llamaswap/local-primary"} >> ${logPath} 2>&1`,
						],
						{ detached: true, stdio: "ignore" },
					);
					child.unref();
					appendLog({ kind: "auto-ablate", ruleIndex: newest, seeds: config.autoAblateSeeds });
				} else {
					appendLog({ kind: "auto-ablate-skipped", reason: "lock held" });
				}
			}
		} catch (error) {
			pi.logger.warn("consensus-evolve: shutdown reflection failed", { error: String(error) });
		}
	});

	// ---- commands ---------------------------------------------------------------------
	pi.registerCommand("consensus", {
		description: "Run a consensus panel on a question: /consensus <question>",
		handler: async (args, ctx) => {
			const question = args.trim();
			if (!question) {
				ctx.ui.notify("Usage: /consensus <question>", "warning");
				return;
			}
			if (ctx.hasUI) ctx.ui.setWorkingMessage("Convening consensus panel…");
			try {
				const { report, agreement } = await runConsensus(question, "", config, ctx);
				stats.lastConsensusAt = Date.now();
				pi.sendMessage(
					{ customType: "consensus-evolve-report", content: report, display: true },
					{ triggerTurn: false },
				);
				if (ctx.hasUI) ctx.ui.notify(`Consensus complete — agreement ${(agreement * 100).toFixed(0)}%`, "info");
			} finally {
				if (ctx.hasUI) ctx.ui.setWorkingMessage();
			}
		},
	});

	// ---- /debug-trace: root-cause a failed session from its JSONL --------------
	pi.registerCommand("debug-trace", {
		description: "Root-cause the most recent failed session: /debug-trace [path-to-session.jsonl]",
		handler: async (args, ctx) => {
			const sessionsRoot = path.join(os.homedir(), ".omp", "agent", "sessions");
			let target = args.trim();
			if (!target) {
				// Newest session file across all project dirs.
				let newest: { p: string; mtime: number } | undefined;
				for (const dir of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
					if (!dir.isDirectory()) continue;
					const dirPath = path.join(sessionsRoot, dir.name);
					for (const f of fs.readdirSync(dirPath)) {
						if (!f.endsWith(".jsonl")) continue;
						const p = path.join(dirPath, f);
						const mtime = fs.statSync(p).mtimeMs;
						if (!newest || mtime > newest.mtime) newest = { p, mtime };
					}
				}
				if (!newest) {
					ctx.ui.notify("No session files found", "warning");
					return;
				}
				target = newest.p;
			}
			const model = ctx.model;
			if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) {
				ctx.ui.notify("No usable model for analysis", "error");
				return;
			}
			if (ctx.hasUI) ctx.ui.setWorkingMessage("Analyzing trace…");
			try {
				const lines = fs.readFileSync(target, "utf8").split("\n").filter(Boolean);
				const events: string[] = [];
				for (const line of lines) {
					try {
						const rec = JSON.parse(line);
						const m = rec.message;
						if (!m) continue;
						if (m.role === "user" && typeof m.content !== "undefined") {
							const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
							if (!text.includes(CE_MARKER)) events.push(`USER: ${text.slice(0, 300)}`);
						} else if (m.role === "toolResult") {
							const text = JSON.stringify(m.content ?? "").slice(0, 250);
							const failed = m.isError || /exited with code [1-9]|\[harness (hint|gate)\]/.test(text);
							if (failed) events.push(`TOOL-FAIL ${m.toolName}: ${text}`);
						} else if (m.role === "assistant") {
							const text = JSON.stringify(m.content ?? "").slice(0, 200);
							events.push(`ASSISTANT: ${text}`);
						}
					} catch {
						/* skip malformed lines */
					}
				}
				const condensed = events.slice(-80).join("\n").slice(0, 20_000);
				const apiKey = await ctx.modelRegistry.getApiKey(model);
				const analysis = await completeSimple(
					model,
					{
						systemPrompt:
							"You are a trace debugger for a coding-agent harness. From the condensed session trace, produce:\nROOT CAUSE: <the single mechanism that most explains the failures, 2-3 sentences, citing specific TOOL-FAIL lines>\nPATTERN: <tool:mechanism signature, e.g. bash:not-found-cmd>\nHARNESS FIX: <one durable rule (imperative, one line) that would have prevented it, or 'none'>",
						messages: [{ role: "user", content: `Trace (${path.basename(target)}):\n${condensed}`, timestamp: Date.now() }],
					} as any,
					{ apiKey, signal: AbortSignal.timeout(60_000), disableReasoning: true } as any,
				);
				const report = extractText(analysis);
				const reportsDir = path.join(DATA_DIR, "debug-reports");
				fs.mkdirSync(reportsDir, { recursive: true });
				const outPath = path.join(reportsDir, `${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
				fs.writeFileSync(outPath, `# Trace analysis: ${target}\n\n${report}\n`);
				appendLog({ kind: "debug-trace", session: target, report: report.slice(0, 400) });
				pi.sendMessage(
					{
						customType: "consensus-evolve-report",
						content: `## Trace analysis (${path.basename(target)})\n${report}\n\n_Saved to ${outPath}_`,
						display: true,
					},
					{ triggerTurn: false },
				);
			} finally {
				if (ctx.hasUI) ctx.ui.setWorkingMessage();
			}
		},
	});

	// ---- /initproject: feature-list + init.sh scaffolding -----------------------
	pi.registerCommand("initproject", {
		description: "Scaffold long-running-project artifacts: /initproject <one-line project description>",
		handler: async (args, ctx) => {
			const description = args.trim();
			if (!description) {
				ctx.ui.notify("Usage: /initproject <one-line project description>", "warning");
				return;
			}
			const model = ctx.model;
			if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) {
				ctx.ui.notify("No usable model", "error");
				return;
			}
			if (ctx.hasUI) ctx.ui.setWorkingMessage("Generating feature list…");
			try {
				const apiKey = await ctx.modelRegistry.getApiKey(model);
				const result = await completeSimple(
					model,
					{
						systemPrompt:
							'Generate a feature list for a software project as STRICT JSON (no fences): {"features": [{"id": "kebab-slug", "description": "one sentence, end-to-end verifiable", "status": "pending"}]}. 5-12 features, each independently testable, ordered by dependency. Output only the JSON.',
						messages: [{ role: "user", content: description, timestamp: Date.now() }],
					} as any,
					{ apiKey, signal: AbortSignal.timeout(60_000), disableReasoning: true } as any,
				);
				let features = extractText(result).trim().replace(/^```(json)?\n?|```$/g, "");
				JSON.parse(features); // validate before writing
				const featuresPath = path.join(ctx.cwd, "features.json");
				if (fs.existsSync(featuresPath)) {
					ctx.ui.notify("features.json already exists — not overwriting", "warning");
					return;
				}
				fs.writeFileSync(featuresPath, `${features}\n`);
				const initShPath = path.join(ctx.cwd, "init.sh");
				if (!fs.existsSync(initShPath)) {
					fs.writeFileSync(
						initShPath,
						"#!/usr/bin/env bash\n# Session-start checklist (run at the start of every session on this project):\nset -e\npwd\ngit log --oneline -5 2>/dev/null || true\ngit status -sb 2>/dev/null || true\necho '--- features ---'\ncat features.json\necho 'Pick ONE pending feature, implement it end-to-end, verify, mark it done in features.json.'\n",
					);
					fs.chmodSync(initShPath, 0o755);
				}
				ctx.ui.notify("Wrote features.json + init.sh — run ./init.sh at each session start", "info");
			} finally {
				if (ctx.hasUI) ctx.ui.setWorkingMessage();
			}
		},
	});

	pi.registerCommand("evolve", {
		description: "Manage learned rules: /evolve review | stats | prune <n> | now | validate <n>",
		getArgumentCompletions: prefix =>
			["review", "stats", "prune ", "now", "validate "].filter(s => s.startsWith(prefix)).map(s => ({ label: s })),
		handler: async (args, ctx) => {
			const [sub, arg] = args.trim().split(/\s+/);
			const rules = readRules();
			if (sub === "review" || !sub) {
				const body =
					rules.length === 0
						? "No learned rules yet."
						: rules.map((rule, index) => `${index + 1}. ${rule.slice(2)}`).join("\n");
				pi.sendMessage(
					{ customType: "consensus-evolve-report", content: `## Learned rules\n${body}`, display: true },
					{ triggerTurn: false },
				);
			} else if (sub === "stats") {
				const sigs = [...stats.signatures.entries()].map(([s, c]) => `${s}×${c.count}`).join(", ") || "none";
				const body = `tool calls: ${stats.toolCalls}, errors: ${stats.toolErrors}, heals: ${stats.healEvents}, verify-blocks: ${stats.verifyBlocks}, masked: ${[...stats.maskedTools.keys()].join(",") || "none"}, signatures: ${sigs}, rules: ${rules.length}`;
				ctx.ui.notify(body, "info");
			} else if (sub === "prune") {
				const index = Number(arg) - 1;
				if (Number.isInteger(index) && index >= 0 && index < rules.length) {
					const [removed] = rules.splice(index, 1);
					writeRules(rules);
					refreshDoctrineSnapshot();
					ctx.ui.notify(`Pruned: ${removed.slice(2, 80)}`, "info");
				} else {
					ctx.ui.notify("Usage: /evolve prune <rule number from /evolve review>", "warning");
				}
			} else if (sub === "now") {
				stats.lastReflectAt = Date.now();
				const added = await reflect(stats, config, ctx, "manual", pi.logger);
				if (added > 0) refreshDoctrineSnapshot();
				ctx.ui.notify(added > 0 ? `Learned ${added} new rule(s)` : "Nothing durable to learn yet", "info");
			} else if (sub === "validate") {
				const index = Number(arg);
				if (!Number.isInteger(index) || index < 1 || index > rules.length) {
					ctx.ui.notify("Usage: /evolve validate <rule number from /evolve review>", "warning");
					return;
				}
				const ablatePath = path.join(DATA_DIR, "ablate.ts");
				const logPath = path.join(DATA_DIR, `ablation-run-${index}.log`);
				// Long-running (each task runs omp twice); detach and report where to look.
				pi.exec("bash", ["-c", `nohup bun ${ablatePath} ${index} > ${logPath} 2>&1 &`], { cwd: DATA_DIR });
				ctx.ui.notify(
					`Ablation started for rule ${index} (runs each registry task with and without it). Watch ${logPath}; verdict lands in learned-rules.md + ablation-receipts.jsonl.`,
					"info",
				);
			} else {
				ctx.ui.notify("Usage: /evolve review | stats | prune <n> | now | validate <n>", "warning");
			}
		},
	});

	// Shared plan-creation helper used by /plan AND the auto-plan path in the
	// input handler. Spawns the task-planner against the supplied task, parses
	// <<<PLAN>>>...<<<END PLAN>>>, validates, persists active-plan.json, and
	// refreshes the doctrine snapshot. Returns the plan on success, or a
	// {error: string} object on any failure (caller decides whether to notify).
	// The `seedPhase1` flag controls whether a phase-1 brief is sent as a
	// triggerTurn message (true for /plan from a quiet prompt; false for the
	// auto-plan path where the user's original message already drives the turn).
	async function createPlanFromTask(
		task: string,
		ctx: ExtensionContext,
		opts: { seedPhase1: boolean },
	): Promise<{ plan: ActivePlan } | { error: string }> {
		const model = ctx.model;
		if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) {
			return { error: "No usable model for planning" };
		}
		const plannerPath = path.join(os.homedir(), ".omp", "agent", "agents", "task-planner.md");
		let systemPrompt: string;
		try {
			const raw = fs.readFileSync(plannerPath, "utf8");
			systemPrompt = raw.replace(/^---[\s\S]*?\n---\n/, "").trim();
		} catch {
			systemPrompt =
				"You are a task planner. Output ONLY a JSON array of phase objects wrapped in <<<PLAN>>> and <<<END PLAN>>>. Each phase has `name`, `verify` (shell command exiting 0 only when phase is done), and `brief` (GOAL, CONTEXT, CONSTRAINTS, DONE WHEN). 2-6 phases, ordered by dependency. The LAST phase must be named 'overall verification' and run the whole task's success check.";
		}
		try {
			const apiKey = await ctx.modelRegistry.getApiKey(model);
			const result = await completeSimple(
				model,
				{
					systemPrompt,
					messages: [{ role: "user", content: task, timestamp: Date.now() }],
				} as any,
				{ apiKey, signal: AbortSignal.timeout(180_000) } as any,
			);
			const text = extractText(result);
			const planMatch = text.match(/<<<PLAN>>>\s*([\s\S]*?)\s*<<<END PLAN>>>/);
			if (!planMatch) return { error: "Planner did not emit a <<<PLAN>>>…<<<END PLAN>>> block" };
			let parsed: unknown;
			try {
				parsed = JSON.parse(planMatch[1]);
			} catch (error) {
				return { error: `Planner output was not valid JSON: ${String(error).slice(0, 200)}` };
			}
			if (!Array.isArray(parsed) || parsed.length === 0) {
				return { error: "Planner returned an empty or non-array plan" };
			}
			const phases: ActivePlanPhase[] = [];
			for (const entry of parsed as Array<Record<string, unknown>>) {
				if (
					typeof entry?.name !== "string" ||
					typeof entry?.verify !== "string" ||
					typeof entry?.brief !== "string"
				) {
					return { error: "Planner phase missing required fields (name/verify/brief)" };
				}
				phases.push({ name: entry.name, verify: entry.verify, brief: entry.brief });
			}
			const plan: ActivePlan = {
				task,
				currentPhase: 0,
				phases,
				startedAt: new Date().toISOString(),
				completedPhases: [],
			};
			writeActivePlan(plan, ctx.cwd ?? sessionCwd);
			refreshDoctrineSnapshot();
			appendLog({ kind: "plan-created", phases: phases.length, task: task.slice(0, 200), cwd: ctx.cwd ?? sessionCwd });
			if (opts.seedPhase1) {
				const p1 = phases[0];
				pi.sendMessage(
					{
						customType: "consensus-evolve-nudge",
						content:
							`[plan-mode] PHASE 1/${phases.length}: ${p1.name}\n\n${p1.brief}\n\nVERIFY (run this when done; the harness watches for exit 0 and auto-advances): ${p1.verify}`,
						display: true,
					},
					{ triggerTurn: true, deliverAs: "nextTurn" },
				);
			}
			return { plan };
		} catch (error) {
			return { error: `planner call failed: ${String(error).slice(0, 200)}` };
		}
	}

	// /plan — Claude-Code-style plan mode. Spawn the task-planner against the
	// user's task, parse <<<PLAN>>>...<<<END PLAN>>>, persist active-plan.json,
	// refresh the doctrine snapshot, and seed phase 1 as the next turn.
	pi.registerCommand("plan", {
		description: "Plan mode: /plan <task> | /plan status | /plan clear | /plan next",
		getArgumentCompletions: prefix =>
			["status", "clear", "next"].filter(s => s.startsWith(prefix)).map(s => ({ label: s })),
		handler: async (args, ctx) => {
			latchCwd(ctx);
			const planCwd = ctx.cwd ?? sessionCwd;
			const trimmed = args.trim();
			const sub = trimmed.split(/\s+/, 1)[0]?.toLowerCase();
			if (sub === "status") {
				const plan = readActivePlan(planCwd);
				if (!plan) {
					ctx.ui.notify("No active plan for this cwd. Use `/plan <task>` to create one.", "info");
					return;
				}
				const lines = [
					`Active plan (${plan.phases.length} phases, on phase ${plan.currentPhase + 1}):`,
					`  CWD:  ${plan.cwd ?? "(legacy)"}`,
					`  GOAL: ${plan.task.slice(0, 200)}`,
					...plan.phases.map((p, i) => {
						const done = (plan.completedPhases ?? []).includes(i);
						const marker = done ? "✓" : i === plan.currentPhase ? "▶" : " ";
						return `  ${marker} ${i + 1}. ${p.name} — verify: ${p.verify.slice(0, 80)}`;
					}),
				];
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}
			if (sub === "clear") {
				clearActivePlan(planCwd);
				refreshDoctrineSnapshot();
				ctx.ui.notify("Active plan cleared (for this cwd).", "info");
				return;
			}
			if (sub === "next") {
				const plan = readActivePlan(planCwd);
				if (!plan) {
					ctx.ui.notify("No active plan.", "warning");
					return;
				}
				if (plan.currentPhase >= plan.phases.length - 1) {
					ctx.ui.notify("Already on the final phase.", "info");
					return;
				}
				plan.completedPhases = [...(plan.completedPhases ?? []), plan.currentPhase];
				plan.currentPhase++;
				writeActivePlan(plan, planCwd);
				refreshDoctrineSnapshot();
				const next = plan.phases[plan.currentPhase];
				ctx.ui.notify(`Advanced to phase ${plan.currentPhase + 1}: ${next.name}`, "info");
				pi.sendMessage(
					{
						customType: "consensus-evolve-nudge",
						content:
							`[plan-mode] PHASE ${plan.currentPhase + 1}/${plan.phases.length}: ${next.name}\n\n${next.brief}\n\nVERIFY (run this; the harness watches for exit 0): ${next.verify}`,
						display: true,
					},
					{ triggerTurn: true, deliverAs: "nextTurn" },
				);
				return;
			}
			if (!trimmed) {
				ctx.ui.notify("Usage: /plan <task description> | /plan status | /plan clear | /plan next", "warning");
				return;
			}
			if (ctx.hasUI) ctx.ui.setWorkingMessage("Planning…");
			try {
				const res = await createPlanFromTask(trimmed, ctx, { seedPhase1: true });
				if ("error" in res) {
					ctx.ui.notify(`/plan failed: ${res.error}`, "error");
					return;
				}
				const summary = res.plan.phases.map((p, i) => `  ${i + 1}. ${p.name}`).join("\n");
				ctx.ui.notify(`Plan created (${res.plan.phases.length} phases):\n${summary}\nStarting phase 1…`, "info");
			} finally {
				if (ctx.hasUI) ctx.ui.setWorkingMessage();
			}
		},
	});

	pi.on("session_start", async () => {
		pi.logger.info("consensus-evolve active", {
			panel: config.panelModels,
			gate: config.destructiveGate,
			verifyBeforeDone: config.verifyBeforeDone,
			evolution: config.evolution,
			rules: readRules().length,
			activePlan: readActivePlan(sessionCwd) ? "yes" : "no",
			cwd: sessionCwd,
		});
	});
}
