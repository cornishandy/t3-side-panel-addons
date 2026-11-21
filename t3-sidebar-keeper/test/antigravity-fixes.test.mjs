import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import zlib from "node:zlib";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t3-keeper-agfixes-test-"));
const asar = path.join(tmp, "app.asar");
const pristine = path.join(tmp, "pristine.asar");

const REAL_ASAR = "/Applications/T3 Code (Nightly).app/Contents/Resources/app.asar";
const REAL_BACKUPS = path.join(os.homedir(), ".local/share/t3-sidebar-keeper/backups");

process.env.T3_ASAR_PATH = asar;
process.env.T3_KEEPER_HOME = path.join(tmp, "home");

const K = await import("../keeper.mjs");
const R = await import("../reminders.mjs");

function buildPristine() {
  fs.copyFileSync(REAL_ASAR, pristine);
  const files = fs.existsSync(REAL_BACKUPS)
    ? fs.readdirSync(REAL_BACKUPS).filter((n) => n.endsWith(".json.gz")).map((n) => path.join(REAL_BACKUPS, n))
    : [];
  if (files.length === 0) return;
  const newest = files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  const backup = JSON.parse(zlib.gunzipSync(fs.readFileSync(newest)).toString("utf8"));
  const fd = fs.openSync(pristine, "r+");
  try {
    const layout = K.readLayout(fd);
    const items = [];
    for (const [rel, info] of Object.entries(backup.files)) {
      const buf = Buffer.from(info.base64, "base64");
      try {
        if (K.readEntry(fd, layout, rel).length === buf.length) items.push({ rel, buf });
      } catch {}
    }
    if (items.length) K.writeEntries(fd, layout, items);
  } finally {
    fs.closeSync(fd);
  }
}

buildPristine();

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function synthServerAsar(serverFiles) {
  const fileEntries = {};
  const chunks = [];
  let offset = 0;
  for (const [name, content] of Object.entries(serverFiles)) {
    const buf = Buffer.from(content, "utf8");
    fileEntries[name] = { size: buf.length, offset: String(offset) };
    chunks.push(buf);
    offset += buf.length;
  }
  const headerJson = Buffer.from(JSON.stringify({
    files: { apps: { files: { server: { files: { dist: { files: fileEntries } } } } } },
  }));
  const pickle = Buffer.alloc(16 + ((headerJson.length + 3) & ~3));
  pickle.writeUInt32LE(4, 0);
  pickle.writeUInt32LE(pickle.length - 8, 4);
  pickle.writeUInt32LE(pickle.length - 12, 8);
  pickle.writeUInt32LE(headerJson.length, 12);
  headerJson.copy(pickle, 16);
  const outPath = path.join(tmp, `synth-${crypto.randomUUID()}.asar`);
  fs.writeFileSync(outPath, Buffer.concat([pickle, ...chunks]));
  return outPath;
}

const PAD = (n) => `/*\n${" ".repeat(n)}*/\n`;

// ---------- Synthetic fixtures matching build 5051 shapes ----------

const ACP_STEER_FIXTURE = `
class ProviderAdapterSteerDeclinedError {
  constructor(v) { Object.assign(this, v); this._tag = "ProviderAdapterSteerDeclinedError"; }
  *[Symbol.iterator]() { return yield this; }
}
class ProviderAdapterSteerRunUnsupportedError {
  constructor(v) { Object.assign(this, v); this._tag = "ProviderAdapterSteerRunUnsupportedError"; }
  *[Symbol.iterator]() { return yield this; }
}
class ProviderAdapterSteerRunError { constructor(v) { Object.assign(this, v); this._tag = "ProviderAdapterSteerRunError"; } }
function makeAcpHarness({ pendingMap, context, prompts }) {
  const driver = "antigravity";
  const activeTurn = { ref: context };
  const pendingRuntimeRequests = { ref: pendingMap };
  const get$9 = (r) => (function* () { return r.ref; })();
  const gen$1 = (fn) => fn;
  const fn = (_name) => (impl, wrap) => ({ impl, wrap });
  const mapError = (mapper) => ({ mapper });
  const runRuntimeCallbackAtGeneration = (_g, gFn) => (function* () { return yield* gFn(); })();
  const steerWithPrompt = fn("AcpAdapterV2.steerWithPrompt")(function* (turnInput) {
    const context = yield* get$9(activeTurn);
    if (context === null || context.finalized || context.interrupted || context.providerTurnId !== turnInput.providerTurnId) return { _err: "inactive" };
    const steered = yield* runRuntimeCallbackAtGeneration(1, gen$1(function* () {
      if (context.finalized || context.interrupted) return false;
      context.promptSettled = false;
      prompts.push(turnInput.message.text);
      return true;
    }));
    return steered;
  });
  const adapter = {
    steerTurn: fn("AcpAdapterV2.steerTurn")(function* (turnInput) {
      return yield* steerWithPrompt.impl(turnInput);
    }, (effect, turnInput) => effect.pipe(mapError((cause) => cause._tag === "ProviderAdapterSteerRunUnsupportedError" ? cause : new ProviderAdapterSteerRunError({
      driver,
      providerThreadId: turnInput.providerThread.id,
      providerTurnId: turnInput.providerTurnId,
      cause
    }))))
  };
  return { steerWithPrompt, adapter };
}
`;

const DISPATCH_POLICY_FIXTURE = `
function resolveDeliveryIntent(_p, mode) { return mode; }
function isNativeMaintenanceCommand() { return false; }
function isActiveRun$1() { return true; }
function providerTurnCapabilities() { return { supportsActiveSteering: true }; }
function providerSwitchWaitsForTurn() { return false; }
function resolveMessageDispatchIntent(projection, requestedMode, deliveryIntent) {
  const mode = resolveDeliveryIntent(projection, requestedMode, deliveryIntent);
  if (mode.type !== "steer_active") return mode;
  const target = projection.runs.find((run) => run.id === mode.targetRunId);
  const targetMessage = projection.messages.find((message) => message.id === target?.userMessageId);
  if (targetMessage !== void 0 && isNativeMaintenanceCommand(targetMessage)) return { type: "queue_after_active" };
  const turns = target === void 0 || !isActiveRun$1(target) ? void 0 : providerTurnCapabilities(projection, target);
  return turns !== void 0 && !turns.supportsActiveSteering && providerSwitchWaitsForTurn(turns) ? { type: "queue_after_active" } : mode;
}
`;

const ORCHESTRATOR_STEER_FIXTURE = `
function makeOrchestratorHarness(deps) {
  const fn = (_name) => (impl) => impl;
  const isSlashCommand = (m) => m.text.startsWith("/");
  const isNativeMaintenanceCommand = () => false;
  const isLiveRun = () => true;
  const isSome = (o) => o !== null;
  const none$1 = () => null;
  const orElseSucceed = () => (x) => x;
  const stopReachedRun = () => (function* () { return false; })();
  const goalCommandStopsActiveRun = () => true;
  const ensureGoalCommandSupported = () => (function* () {})();
  const ensureSteeringMessage = () => (function* () {})();
  const queuedRunModelSelection = () => ({ instanceId: "antigravity" });
  const parseGoalCommand = (m) => m.text.startsWith("/goal") ? { type: "set" } : null;
  const goalDriverFor = () => (function* () { return "antigravity"; })();
  const isCompactionCommandMessage = () => false;
  const now = (function* () { return "2026-11-21T19:00:00Z"; })();
  const emit = (events) => (ev) => (function* () { events.push(ev); })();
  const loadProjectionForCommand = () => (function* () { return deps.projection; })();
  const providerSessions = { get: () => ({ pipe: () => (function* () { return { value: { providerSession: { capabilities: { turns: { supportsActiveSteering: true, activeSteeringInterruptsTools: false } } } } }; })() }) };
  const providerAdapters = { get: () => ({ pipe: () => (function* () { return { getCapabilities: () => ({ pipe: () => (function* () { return {}; })() }) }; })() }) };
  const commandPolicy = { decideSteeringExecution: () => ({ pipe: () => (function* () {})() }) };
  const stopRunForQueuedCommand = (arg) => (function* () { deps.stopCalls.push(arg); })();
  const dispatchSteerIntoRun = (arg) => (function* () { deps.steerCalls.push(arg); })();
  class OrchestratorDispatchError { constructor(v) { Object.assign(this, v); } }

  const runNoticeCheck = function* (command, projection, delegatedCompletion, freshContext) {
    let dispatchMode = { type: "queue_after_active" };
    const noticeKind = command.notification?.source.kind;
    const commandNotice = noticeKind === "command" && command.creationSource === "server";
    if (!freshContext && !isSlashCommand(command) && (delegatedCompletion !== void 0 ? delegatedCompletion.taskIds.every((id) => projection.subagents.find((task) => task.id === id)?.completionWake === "always") : noticeKind === "delegated_task" || commandNotice)) {
      const active = projection.runs.find((run) => run.status === "running");
      const providerThread = projection.providerThreads.find((row) => row.id === active?.providerThreadId);
      const activeTurn = projection.providerTurns.find((turn) => turn.runAttemptId === active?.activeAttemptId && turn.status === "running");
      const activeMessage = projection.messages.find((message) => message.id === active?.userMessageId);
      if (active !== void 0 && activeTurn !== void 0 && providerThread?.providerSessionId != null && (!commandNotice || providerThread.goal?.status === "active") && (activeMessage === void 0 || !isNativeMaintenanceCommand(activeMessage))) {
        const session = yield* providerSessions.get(providerThread.providerSessionId).pipe(orElseSucceed(() => none$1()));
        if (isSome(session) && session.value.providerSession.capabilities.turns.supportsActiveSteering && session.value.providerSession.capabilities.turns.activeSteeringInterruptsTools !== true && !(yield* stopReachedRun(command, command.threadId, active.id))) dispatchMode = {
          type: "steer_active",
          targetRunId: active.id
        };
      }
    }
    return dispatchMode;
  };

  const dispatchQueuedMessagePromoteToSteer = fn("Orchestrator.dispatchQueuedMessagePromoteToSteer")(function* (command, events, effects) {
    const projection = yield* loadProjectionForCommand(command);
    const queuedRun = projection.runs.find((candidate) => candidate.id === command.queuedRunId);
    const queuedRootNode = projection.nodes.find((candidate) => candidate.id === queuedRun.rootNodeId);
    const queuedAttempt = projection.attempts.find((candidate) => candidate.id === queuedRun.activeAttemptId);
    const queuedMessage = projection.messages.find((candidate) => candidate.id === queuedRun.userMessageId);
    const now$52 = yield* now;
    const emitEvent = emit(events, command);
    const modelSelection = queuedRunModelSelection(projection, queuedRun);
    const parsedGoalCommand = parseGoalCommand(queuedMessage);
    const goalCommand = parsedGoalCommand === null || (yield* goalDriverFor(command, modelSelection.instanceId)) === void 0 ? null : parsedGoalCommand;
    const target = projection.runs.find((run) => run.id === command.targetRunId);
    const targetMessage = projection.messages.find((message) => message.id === target?.userMessageId);
    if (target !== void 0 && targetMessage !== void 0 && isCompactionCommandMessage(targetMessage)) {
      return;
    }
    if (goalCommand !== null || isSlashCommand(queuedMessage)) {
      if (goalCommand !== null) yield* ensureGoalCommandSupported(command, queuedMessage, modelSelection.instanceId);
      const goal = projection.providerThreads.find((candidate) => candidate.id === target?.providerThreadId)?.goal;
      yield* emitEvent({
        type: "run.updated",
        threadId: command.threadId,
        runId: queuedRun.id,
        nodeId: queuedRootNode.id,
        providerInstanceId: queuedRun.providerInstanceId,
        occurredAt: now$52,
        payload: { ...queuedRun, queuePosition: 1 }
      });
      const stops = goalCommand !== null && target !== void 0 && isLiveRun(target) && goalCommandStopsActiveRun(goalCommand, goal?.status ?? null) && (targetMessage === void 0 || !isNativeMaintenanceCommand(targetMessage)) && !(yield* stopReachedRun(command, command.threadId, target.id));
      return yield* stopRunForQueuedCommand({
        command, events, effects, projection, queuedRunId: queuedRun.id,
        targetRunId: stops ? target.id : void 0,
        reason: "Stopped to apply /goal",
        now: now$52
      });
    }
    if ((target?.status === "preparing" || target?.status === "starting" || target?.status === "running" && !projection.providerTurns.some((turn) => turn.runAttemptId === target.activeAttemptId && turn.status === "running")) && !(yield* stopReachedRun(command, command.threadId, target.id))) {
      yield* ensureSteeringMessage(command, queuedMessage);
      yield* emitEvent({
        type: "run.updated",
        threadId: command.threadId,
        runId: queuedRun.id,
        nodeId: queuedRootNode.id,
        providerInstanceId: queuedRun.providerInstanceId,
        occurredAt: now$52,
        payload: { ...queuedRun, steerWhenReadyRunId: target.id }
      });
      return;
    }
    yield* emitEvent({
      type: "run.updated",
      threadId: command.threadId,
      runId: queuedRun.id,
      nodeId: queuedRootNode.id,
      providerInstanceId: queuedRun.providerInstanceId,
      occurredAt: now$52,
      payload: { ...queuedRun, status: "cancelled", queuePosition: null, completedAt: now$52 }
    });
    yield* dispatchSteerIntoRun({
      command, events, effects, projection, modelSelection,
      targetRunId: command.targetRunId, messageId: queuedMessage.id, text: queuedMessage.text,
      attachments: [], createdBy: "user", creationSource: "web", forceRestart: false
    });
  });
  return { runNoticeCheck, dispatchQueuedMessagePromoteToSteer };
}
`;

const QUOTA_OUTCOME_FIXTURE = `
const ERROR_STEP_TYPE = 17;
const API_ERROR = /Error (\\d{3}), Message: (.+?), Status: ([A-Z_]+)/s;
const STATUS_ERROR = /(?<![A-Z_])([A-Z_]+) \\(code (\\d{3})\\): (\\P{Cc}+)/u;
const QUOTA_EXHAUSTED = /\\breason:QUOTA_EXHAUSTED\\b/;
const RESET_TIMESTAMP = /\\bquotaResetTimeStamp:([^\\s\\]]+)/;
const RESET_DELAY = /\\bquotaResetDelay:((?:\\d+(?:\\.\\d+)?(?:ns|us|\u00b5s|\u03bcs|ms|h|m|s))+)(?=[\\s\\]])/;
const RETRY_DELAY = /\\bretryDelay:((?:\\d+(?:\\.\\d+)?(?:ns|us|\u00b5s|\u03bcs|ms|h|m|s))+)(?=[\\s\\]])/;
const GO_DURATION_PART = /(\\d+(?:\\.\\d+)?)(ns|us|\u00b5s|\u03bcs|ms|h|m|s)/g;
const GO_DURATION_UNIT_MS = { ns: 1e-6, us: .001, "\u00b5s": .001, "\u03bcs": .001, ms: 1, s: 1e3, m: 6e4, h: 36e5 };
const isSome = (o) => o !== null;
const make$105 = (s) => (Number.isFinite(Date.parse(s)) ? { value: Date.parse(s) } : null);
const add = (dt, { milliseconds }) => new Date(dt.getTime() + milliseconds);
const formatIso = (dt) => dt.toISOString();
const makeProviderFailure = (v) => v;
function resetAtFrom(text, now) {
  const timestamp = RESET_TIMESTAMP.exec(text)?.[1];
  if (timestamp !== void 0 && isSome(make$105(timestamp))) return timestamp;
  const delay = RESET_DELAY.exec(text)?.[1] ?? RETRY_DELAY.exec(text)?.[1];
  if (delay === void 0) return void 0;
  let delayMs = 0;
  for (const [, amount, unit] of delay.matchAll(GO_DURATION_PART)) delayMs += Number(amount) * (GO_DURATION_UNIT_MS[unit] ?? 0);
  return delayMs > 0 ? formatIso(add(now, { milliseconds: delayMs })) : void 0;
}
function statusError(text) {
  const match = STATUS_ERROR.exec(text);
  return match === null ? null : [match[0], match[2], match[3], match[1]];
}
function turnFailure(stopReason, step, now) {
  const errorText = step?.type === ERROR_STEP_TYPE ? new TextDecoder().decode(step.payload ?? new Uint8Array()) : void 0;
  if (errorText === void 0 && stopReason !== "refusal") return void 0;
  const text = errorText ?? "";
  const apiError = API_ERROR.exec(text) ?? statusError(text);
  const reusable = (failure) => ({ failure, threadDisposition: "reusable" });
  if (stopReason === "refusal" || QUOTA_EXHAUSTED.test(text)) return reusable(makeProviderFailure({
    class: "usage_limit",
    message: "You have reached your Antigravity quota for this period.",
    code: apiError?.[3] ?? "QUOTA_EXHAUSTED",
    retryable: true,
    resetAt: resetAtFrom(text, now) ?? null
  }));
  if (apiError === null) return reusable(makeProviderFailure({ class: "provider_error", message: "Antigravity stopped this turn because of an error." }));
  const [, httpStatus, message, status] = apiError;
  return reusable(makeProviderFailure({ class: httpStatus === "429" || status === "RESOURCE_EXHAUSTED" ? "usage_limit" : "provider_error", message: message.trim(), code: status ?? null, retryable: true, resetAt: resetAtFrom(text, now) ?? null }));
}
const watchAntigravityPromptOutcome = "AntigravityTurnOutcome.watch";
`;

function driveGen(gen) {
  let step = gen.next();
  while (!step.done) {
    const val = step.value;
    if (val && typeof val === "object" && "_get" in val) {
      step = gen.next(val._get);
    } else if (val && typeof val === "object" && "_runCb" in val) {
      step = gen.next(driveGen(val._runCb()));
    } else if (val && typeof val === "object" && typeof val.next === "function") {
      step = gen.next(driveGen(val));
    } else if (val && val._tag === "ProviderAdapterSteerDeclinedError") {
      return val;
    } else {
      step = gen.next(val);
    }
  }
  return step.value;
}

// ---------- 1. antigravitySteer unit & behavioral tests ----------

test("antigravitySteer patches all 3 targets, is pure ASCII, idempotent, and executes every guard properly", () => {
  const src = `${ACP_STEER_FIXTURE}\n${DISPATCH_POLICY_FIXTURE}\n${ORCHESTRATOR_STEER_FIXTURE}\n${PAD(8000)}`;
  const patched = K.unitAntigravitySteer(src);
  assert.equal(patched.state, "patched");
  assert.ok(/^[\x00-\x7f]*$/.test(patched.text), "antigravitySteer output must be pure ASCII");
  const balanced = K.finishBinCli(patched.text, Buffer.byteLength(src), false);
  assert.equal(Buffer.byteLength(balanced), Buffer.byteLength(src));
  assert.equal(K.unitAntigravitySteer(balanced).state, "already");

  const mod = vm.runInNewContext(
    `${balanced}\n({ makeAcpHarness, resolveMessageDispatchIntent, makeOrchestratorHarness, ProviderAdapterSteerDeclinedError, ProviderAdapterSteerRunError })`
  );

  // 1a. AcpAdapterV2.steerWithPrompt + steerTurn mapError
  const prompts = [];
  const ctxBusy = { finalized: false, interrupted: false, providerTurnId: "turn-1", promptSettled: true };
  const acpBusy = mod.makeAcpHarness({ pendingMap: new Map([["req-1", {}]]), context: ctxBusy, prompts });
  const turnInput = { providerThread: { id: "pth-1" }, providerTurnId: "turn-1", message: { text: "steer msg" } };
  const declined = driveGen(acpBusy.adapter.steerTurn.impl(turnInput));
  assert.equal(declined._tag, "ProviderAdapterSteerDeclinedError");
  assert.equal(prompts.length, 0, "must not send prompt while pendingRuntimeRequests is non-empty");
  assert.equal(ctxBusy.promptSettled, true, "must not mutate context turn state before declining");
  // Error mapper passes ProviderAdapterSteerDeclinedError through without wrapping into ProviderAdapterSteerRunError
  let capturedMapper = null;
  acpBusy.adapter.steerTurn.wrap({ pipe: (m) => { capturedMapper = m.mapper; } }, turnInput);
  assert.equal(capturedMapper(declined)._tag, "ProviderAdapterSteerDeclinedError");
  assert.equal(capturedMapper({ _tag: "OtherError" })._tag, "ProviderAdapterSteerRunError");
  // When no request is pending, steering proceeds normally
  const acpFree = mod.makeAcpHarness({ pendingMap: new Map(), context: ctxBusy, prompts });
  assert.equal(driveGen(acpFree.adapter.steerTurn.impl(turnInput)), true);
  assert.deepEqual(prompts, ["steer msg"]);

  // 1b. CommandPolicy.resolveMessageDispatchIntent
  const baseProj = {
    runs: [{ id: "r1", userMessageId: "m1" }],
    messages: [{ id: "m1", text: "hi" }],
    runtimeRequests: [{ status: "pending", responseCapability: { type: "live" } }],
  };
  assert.deepEqual({ ...mod.resolveMessageDispatchIntent(baseProj, { type: "steer_active", targetRunId: "r1" }) }, { type: "queue_after_active" });
  assert.deepEqual({ ...mod.resolveMessageDispatchIntent({ ...baseProj, runtimeRequests: [{ status: "resolved", responseCapability: { type: "live" } }] }, { type: "steer_active", targetRunId: "r1" }) }, { type: "steer_active", targetRunId: "r1" });
  assert.deepEqual({ ...mod.resolveMessageDispatchIntent({ ...baseProj, runtimeRequests: [{ status: "pending", responseCapability: { type: "message" } }] }, { type: "steer_active", targetRunId: "r1" }) }, { type: "steer_active", targetRunId: "r1" });

  // 1c. Orchestrator notice steering: pending live request AND declined mailbox follow-up after card clears
  const orchProj = {
    runs: [
      { id: "r1", status: "running", providerThreadId: "pt1", activeAttemptId: "a1", userMessageId: "m1" },
      { id: "r2", status: "queued", queuePosition: 2, rootNodeId: "n2", activeAttemptId: "a2", userMessageId: "m2", providerInstanceId: "antigravity" },
    ],
    nodes: [{ id: "n2" }],
    attempts: [{ id: "a2" }],
    messages: [{ id: "m1", text: "work" }, { id: "m2", text: "queued user msg" }],
    providerThreads: [{ id: "pt1", providerSessionId: "ps1", goal: { status: "active" } }],
    providerTurns: [{ runAttemptId: "a1", status: "running" }],
    subagents: [{ id: "sub1", completionWake: "always" }],
    runtimeRequests: [{ status: "pending", responseCapability: { type: "live" } }],
  };
  const deps = { projection: orchProj, stopCalls: [], steerCalls: [] };
  const orch = mod.makeOrchestratorHarness(deps);
  const delivCmd = { threadId: "t1", text: "child done", notification: { source: { kind: "delegated_task" } } };
  // Pending card -> stays queued
  assert.deepEqual({ ...driveGen(orch.runNoticeCheck(delivCmd, orchProj, { taskIds: ["sub1"] }, false)) }, { type: "queue_after_active" });
  // Card cleared, BUT steerFollowUpOfRunId set (declined mailbox delivery) -> STILL stays queued (no re-steer loop!)
  const clearedProj = { ...orchProj, runtimeRequests: [] };
  assert.deepEqual({ ...driveGen(orch.runNoticeCheck({ ...delivCmd, steerFollowUpOfRunId: "r1" }, clearedProj, { taskIds: ["sub1"] }, false)) }, { type: "queue_after_active" });
  // Card cleared and fresh delivery -> steers normally
  assert.deepEqual({ ...driveGen(orch.runNoticeCheck(delivCmd, clearedProj, { taskIds: ["sub1"] }, false)) }, { type: "steer_active", targetRunId: "r1" });

  // 1d. dispatchQueuedMessagePromoteToSteer with pending approval (Astra Pre-OK #1!)
  // Case A: target is running with an active turn (would otherwise cancel queuedRun + call dispatchSteerIntoRun)
  const evRunning = [];
  driveGen(orch.dispatchQueuedMessagePromoteToSteer({ threadId: "t1", queuedRunId: "r2", targetRunId: "r1" }, evRunning, []));
  assert.equal(evRunning.length, 0, "must emit zero events (no cancellation, original queuePosition retained)");
  assert.equal(deps.steerCalls.length, 0, "must emit zero steer effects");
  assert.equal(orchProj.runs[1].queuePosition, 2, "original queued run retains its queue position");

  // Case B: target is preparing (would otherwise set steerWhenReadyRunId)
  deps.projection = { ...orchProj, runs: [{ ...orchProj.runs[0], status: "preparing" }, orchProj.runs[1]] };
  const evPrep = [];
  driveGen(orch.dispatchQueuedMessagePromoteToSteer({ threadId: "t1", queuedRunId: "r2", targetRunId: "r1" }, evPrep, []));
  assert.equal(evPrep.length, 0, "must not set steerWhenReadyRunId while approval is pending");
  assert.equal(deps.steerCalls.length, 0);

  // Case C: promoted /goal command while approval is pending must not interrupt target
  deps.projection = { ...orchProj, messages: [{ id: "m1", text: "work" }, { id: "m2", text: "/goal keep going" }] };
  const evGoal = [];
  driveGen(orch.dispatchQueuedMessagePromoteToSteer({ threadId: "t1", queuedRunId: "r2", targetRunId: "r1" }, evGoal, []));
  assert.equal(deps.stopCalls.length, 1);
  assert.equal(deps.stopCalls[0].targetRunId, undefined, "promoted /goal must not interrupt active turn waiting on approval");

  // Case D: once pending request resolves, promotion calls dispatchSteerIntoRun normally
  deps.projection = { ...orchProj, runtimeRequests: [{ status: "resolved", responseCapability: { type: "live" } }] };
  const evClear = [];
  driveGen(orch.dispatchQueuedMessagePromoteToSteer({ threadId: "t1", queuedRunId: "r2", targetRunId: "r1" }, evClear, []));
  assert.equal(deps.steerCalls.length, 1, "promotion steers normally when no live request is pending");
});

test("antigravitySteer fails closed on reversed polarity or inverted capability filters across all targets", () => {
  // Astra Round 1 #1: reversed polarity `!projection.runtimeRequests.some(...)` in dispatchQueuedMessagePromoteToSteer
  const orchPatched = K.unitAntigravitySteer(ORCHESTRATOR_STEER_FIXTURE, { targets: ["orchestratorSteer"] }).text;
  const reversedPromote = orchPatched.replace(
    /(if \(\/\*t3-keeper-ag-steer-v1\*\/ )(projection\.runtimeRequests\.some\([^\n]+\) return;)/,
    "$1!$2"
  );
  assert.notEqual(reversedPromote, orchPatched);
  assert.throws(
    () => K.unitAntigravitySteer(reversedPromote, { targets: ["orchestratorSteer"] }),
    /dispatchQueuedMessagePromoteToSteer has unexpected pending-request guard/
  );

  // Sol Round 1 #1: inverted capability filter `type === "message"` in dispatchPolicy, notice steering, goal stops, and promote
  const policyPatched = K.unitAntigravitySteer(DISPATCH_POLICY_FIXTURE, { targets: ["dispatchPolicy"] }).text;
  const invertedPolicy = policyPatched.replace('type !== "message"', 'type === "message"');
  assert.notEqual(invertedPolicy, policyPatched);
  assert.throws(
    () => K.unitAntigravitySteer(invertedPolicy, { targets: ["dispatchPolicy"] }),
    /resolveMessageDispatchIntent has unexpected pending-request check/
  );
  const reversedPolicy = policyPatched.replace("projection.runtimeRequests.some(", "!projection.runtimeRequests.some(");
  assert.throws(
    () => K.unitAntigravitySteer(reversedPolicy, { targets: ["dispatchPolicy"] }),
    /resolveMessageDispatchIntent has unexpected pending-request check/
  );

  // Inverted capability filter in notice steering (first occurrence in orchPatched)
  const invertedNotice = orchPatched.replace('type !== "message"', 'type === "message"');
  assert.throws(
    () => K.unitAntigravitySteer(invertedNotice, { targets: ["orchestratorSteer"] }),
    /Orchestrator notice steering has unexpected pending-request guard/
  );

  // Inverted capability filter in /goal stops (second occurrence)
  let seen = 0;
  const invertedGoalStops = orchPatched.replace(/type !== "message"/g, (m) => (++seen === 2 ? 'type === "message"' : m));
  assert.throws(
    () => K.unitAntigravitySteer(invertedGoalStops, { targets: ["orchestratorSteer"] }),
    /dispatchQueuedMessagePromoteToSteer goal stops has unexpected pending-request guard/
  );

  // Inverted capability filter in dispatchQueuedMessagePromoteToSteer early return (third occurrence)
  seen = 0;
  const invertedPromote = orchPatched.replace(/type !== "message"/g, (m) => (++seen === 3 ? 'type === "message"' : m));
  assert.throws(
    () => K.unitAntigravitySteer(invertedPromote, { targets: ["orchestratorSteer"] }),
    /dispatchQueuedMessagePromoteToSteer has unexpected pending-request guard/
  );

  // Reversed size check in AcpAdapterV2.steerWithPrompt
  const acpPatched = K.unitAntigravitySteer(ACP_STEER_FIXTURE, { targets: ["acpSteer"] }).text;
  const reversedAcp = acpPatched.replace(".size > 0", ".size === 0");
  assert.notEqual(reversedAcp, acpPatched);
  assert.throws(
    () => K.unitAntigravitySteer(reversedAcp, { targets: ["acpSteer"] }),
    /steerWithPrompt has unexpected pendingRuntimeRequests/
  );
  // Non-fail wrapper (e.g. succeed(new ProviderAdapterSteerDeclinedError(...))) fails closed
  const wrappedSucceedAcp = acpPatched.replace(
    "return yield* new ProviderAdapterSteerDeclinedError(",
    "return yield* succeed(new ProviderAdapterSteerDeclinedError("
  ).replace("providerTurnId });", "providerTurnId }));");
  assert.throws(
    () => K.unitAntigravitySteer(wrappedSucceedAcp, { targets: ["acpSteer"] }),
    /steerWithPrompt has unexpected pendingRuntimeRequests/
  );

  // Valid upstream helper (`waitsOnPendingRequest`) with positive capability filter yields cleanly; broken helper throws
  const validUpstreamPolicy = `function waitsOnPendingRequest(p) { return p.runtimeRequests.some((r) => r.status === "pending" && r.responseCapability.type === "live"); }\n` +
    DISPATCH_POLICY_FIXTURE.replace(
      'if (mode.type !== "steer_active") return mode;',
      'if (mode.type !== "steer_active") return mode;\n  if (waitsOnPendingRequest(projection)) return { type: "queue_after_active" };'
    );
  assert.equal(K.unitAntigravitySteer(validUpstreamPolicy, { targets: ["dispatchPolicy"] }).state, "already");
  const brokenUpstreamPolicy = validUpstreamPolicy.replace('type === "live"', 'type === "message"');
  assert.throws(
    () => K.unitAntigravitySteer(brokenUpstreamPolicy, { targets: ["dispatchPolicy"] }),
    /resolveMessageDispatchIntent has unexpected pending-request check/
  );
});

// ---------- 2. antigravityQuotaOutcome unit, partial-merge, protobuf prefix & upstream yield tests ----------

test("antigravityQuotaOutcome parses 1.5 JSON quota payloads with printable protobuf prefix and preserves 1.4 Go-map format", () => {
  const src = `${QUOTA_OUTCOME_FIXTURE}\n${PAD(6000)}`;
  const patched = K.unitAntigravityQuotaOutcome(src);
  assert.equal(patched.state, "patched");
  const patchedResetFn = patched.text.slice(patched.text.indexOf("function resetAtFrom("), patched.text.indexOf("function statusError("));
  assert.ok(/^[\x00-\x7f]*$/.test(patchedResetFn), "patched resetAtFrom helper must be pure ASCII");
  for (const name of ["STATUS_ERROR", "QUOTA_EXHAUSTED", "RESET_TIMESTAMP", "RESET_DELAY", "RETRY_DELAY"]) {
    const line = patched.text.split("\n").find((l) => l.startsWith(`const ${name} = `));
    assert.ok(line && /^[\x00-\x7f]*$/.test(line), `patched ${name} line must be pure ASCII`);
  }
  const balanced = K.finishBinCli(patched.text, Buffer.byteLength(src), false);
  assert.equal(Buffer.byteLength(balanced), Buffer.byteLength(src));
  assert.equal(K.unitAntigravityQuotaOutcome(balanced).state, "already");

  const mod = vm.runInNewContext(`${balanced}\n({ statusError, resetAtFrom, turnFailure })`, { TextDecoder });
  const now = new Date("2026-11-21T05:00:00.000Z");

  // Sanitized Antigravity 1.5 payload with printable protobuf length byte 'A' (0x41) immediately before RESOURCE_EXHAUSTED
  const v15Payload = `ARESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 1h28m46s.\n{"error":{"code":429,"details":[{"reason":"QUOTA_EXHAUSTED","metadata":{"quotaResetTimeStamp":"2026-11-21T06:28:46Z","quotaResetDelay":"1h28m46s"}}]}}`;
  const se = mod.statusError(v15Payload);
  assert.ok(se, "statusError must match despite printable protobuf prefix byte 'A'");
  assert.equal(se[1], "429");
  assert.equal(se[2], "Individual quota reached. Resets in 1h28m46s.");
  assert.equal(se[3], "RESOURCE_EXHAUSTED");

  const fail15 = mod.turnFailure("end_turn", { type: 17, payload: new TextEncoder().encode(v15Payload) }, now);
  assert.equal(fail15.failure.class, "usage_limit");
  assert.equal(fail15.failure.code, "RESOURCE_EXHAUSTED");
  assert.equal(fail15.failure.retryable, true);
  assert.equal(fail15.failure.resetAt, "2026-11-21T06:28:46Z");

  // Legacy 1.4 Go-map payload still parses identically
  const v14Payload = `Error 429, Message: Quota exceeded, Status: RESOURCE_EXHAUSTED, Details: [map[reason:QUOTA_EXHAUSTED quotaResetTimeStamp:2026-11-21T07:00:00Z]]`;
  const fail14 = mod.turnFailure("end_turn", { type: 17, payload: new TextEncoder().encode(v14Payload) }, now);
  assert.equal(fail14.failure.class, "usage_limit");
  assert.equal(fail14.failure.resetAt, "2026-11-21T07:00:00Z");
});

test("antigravityQuotaOutcome does not accept partial upstream merge (5 fixed regexes + old resetAtFrom) and computes now + 1 ms on expired JSON ts + 0s + 0.0001s", () => {
  // Astra Pre-OK #2 exact regression fixture: 5 regexes already fixed, but old resetAtFrom still present!
  const partialSrc = QUOTA_OUTCOME_FIXTURE
    .replace(
      'const STATUS_ERROR = /(?<![A-Z_])([A-Z_]+) \\(code (\\d{3})\\): (\\P{Cc}+)/u;',
      'const STATUS_ERROR = /(CANCELLED|UNKNOWN|INVALID_ARGUMENT|DEADLINE_EXCEEDED|NOT_FOUND|ALREADY_EXISTS|PERMISSION_DENIED|RESOURCE_EXHAUSTED|FAILED_PRECONDITION|ABORTED|OUT_OF_RANGE|UNIMPLEMENTED|INTERNAL|UNAVAILABLE|DATA_LOSS|UNAUTHENTICATED) \\(code (\\d{3})\\): (\\P{Cc}+)/u;'
    )
    .replace(
      'const QUOTA_EXHAUSTED = /\\breason:QUOTA_EXHAUSTED\\b/;',
      'const QUOTA_EXHAUSTED = /(?:"reason"\\s*:\\s*"QUOTA_EXHAUSTED"|\\breason:QUOTA_EXHAUSTED\\b)/;'
    )
    .replace(
      'const RESET_TIMESTAMP = /\\bquotaResetTimeStamp:([^\\s\\]]+)/;',
      'const RESET_TIMESTAMP = /(?:"quotaResetTimeStamp"\\s*:\\s*"([^"\\s]+)"|\\bquotaResetTimeStamp:([^\\s\\],}]+))/;'
    )
    .replace(
      'const RESET_DELAY = /\\bquotaResetDelay:((?:\\d+(?:\\.\\d+)?(?:ns|us|\u00b5s|\u03bcs|ms|h|m|s))+)(?=[\\s\\]])/;',
      'const RESET_DELAY = /(?:"quotaResetDelay"\\s*:\\s*"((?:\\d+(?:\\.\\d+)?(?:ns|us|\\u00b5s|\\u03bcs|ms|h|m|s))+)"|\\bquotaResetDelay:((?:\\d+(?:\\.\\d+)?(?:ns|us|\\u00b5s|\\u03bcs|ms|h|m|s))+)(?=[\\s\\],}]|$))/;'
    )
    .replace(
      'const RETRY_DELAY = /\\bretryDelay:((?:\\d+(?:\\.\\d+)?(?:ns|us|\u00b5s|\u03bcs|ms|h|m|s))+)(?=[\\s\\]])/;',
      'const RETRY_DELAY = /(?:"retryDelay"\\s*:\\s*"((?:\\d+(?:\\.\\d+)?(?:ns|us|\\u00b5s|\\u03bcs|ms|h|m|s))+)"|\\bretryDelay:((?:\\d+(?:\\.\\d+)?(?:ns|us|\\u00b5s|\\u03bcs|ms|h|m|s))+)(?=[\\s\\],}]|$))/;'
    ) + `\n${PAD(6000)}`;

  const first = K.unitAntigravityQuotaOutcome(partialSrc);
  assert.equal(first.state, "patched", "must patch old resetAtFrom even when all 5 regexes are already updated");
  const mod = vm.runInNewContext(`${first.text}\n({ resetAtFrom })`);
  const now = new Date("2026-11-21T12:00:00.000Z");
  const payload = '{"quotaResetTimeStamp":"2026-11-21T00:00:00Z","quotaResetDelay":"0s","retryDelay":"0.0001s"}';
  assert.equal(mod.resetAtFrom(payload, now), "2026-11-21T12:00:00.001Z", "expired ts + 0s + 0.0001s must resolve to now + 1 ms");
  // Expired timestamp with no positive delay still falls back to valid parsed timestamp
  assert.equal(mod.resetAtFrom('{"quotaResetTimeStamp":"2026-11-21T00:00:00Z","quotaResetDelay":"0s"}', now), "2026-11-21T00:00:00Z");
  // Second pass must yield "already"
  assert.equal(K.unitAntigravityQuotaOutcome(first.text).state, "already");
});

test("antigravityQuotaOutcome yields cleanly to real upstream PR #40244 and fails closed on broken or unfamiliar shapes", () => {
  const upstream40244 = `
const STATUS_ERROR = /(CANCELLED|UNKNOWN|INVALID_ARGUMENT|DEADLINE_EXCEEDED|NOT_FOUND|ALREADY_EXISTS|PERMISSION_DENIED|RESOURCE_EXHAUSTED|FAILED_PRECONDITION|ABORTED|OUT_OF_RANGE|UNIMPLEMENTED|INTERNAL|UNAVAILABLE|DATA_LOSS|UNAUTHENTICATED) \\(code (\\d{3})\\): (\\P{Cc}+)/u;
const QUOTA_EXHAUSTED = /(?:"reason"\\s*:\\s*"QUOTA_EXHAUSTED"|\\breason:QUOTA_EXHAUSTED\\b)/;
const GO_DURATION = "(?:\\\\d+(?:\\\\.\\\\d+)?(?:ns|us|\u00b5s|\u03bcs|ms|h|m|s))+";
const delayPattern = (field) => new RegExp(\`(?:"\${field}"\\\\s*:\\\\s*"(\${GO_DURATION})"|\\\\b\${field}:(\${GO_DURATION})(?=[\\\\s\\\\],}]|$))\`);
const RESET_TIMESTAMP = /(?:"quotaResetTimeStamp"\\s*:\\s*"([^"\\s]+)"|\\bquotaResetTimeStamp:([^\\s\\],}]+))/;
const RESET_DELAY = delayPattern("quotaResetDelay");
const RETRY_DELAY = delayPattern("retryDelay");
const GO_DURATION_PART = /(\\d+(?:\\.\\d+)?)(ns|us|\u00b5s|\u03bcs|ms|h|m|s)/g;
const GO_DURATION_UNIT_MS = { ns: 1e-6, us: .001, "\u00b5s": .001, "\u03bcs": .001, ms: 1, s: 1e3, m: 6e4, h: 36e5 };
const none = () => null;
const isSome = (o) => o !== null;
const make$1 = (s) => (Number.isFinite(Date.parse(s)) ? { value: Date.parse(s) } : null);
const isGreaterThan = (a, b) => a > b.getTime();
const add = (dt, { milliseconds }) => new Date(dt.getTime() + milliseconds);
const formatIso = (dt) => dt.toISOString();
function matchedValue(match) { return match?.[1] ?? match?.[2]; }
function parsePositiveDelayMs(delay) {
  if (delay === void 0) return void 0;
  let delayMs = 0;
  for (const [, amount, unit] of delay.matchAll(GO_DURATION_PART)) {
    delayMs += Number(amount) * (GO_DURATION_UNIT_MS[unit] ?? 0);
  }
  return delayMs > 0 ? Math.ceil(delayMs) : void 0;
}
function resetAtFrom(text, now) {
  const timestamp = matchedValue(RESET_TIMESTAMP.exec(text));
  const parsedTimestamp = timestamp === void 0 ? none() : make$1(timestamp);
  if (isSome(parsedTimestamp) && isGreaterThan(parsedTimestamp.value, now)) return timestamp;
  const delayMs = parsePositiveDelayMs(matchedValue(RESET_DELAY.exec(text))) ?? parsePositiveDelayMs(matchedValue(RETRY_DELAY.exec(text)));
  return delayMs !== void 0 ? formatIso(add(now, { milliseconds: delayMs })) : isSome(parsedTimestamp) ? timestamp : void 0;
}
const watch = "AntigravityTurnOutcome.watch";
`;
  // Verify the PR-shaped fixture itself behaves accurately (15s -> 15000 ms, expired + 0s + 0.0001s -> now + 1 ms)
  const upMod = vm.runInNewContext(`${upstream40244}\n({ parsePositiveDelayMs, resetAtFrom })`);
  assert.equal(upMod.parsePositiveDelayMs("15s"), 15000);
  assert.equal(upMod.parsePositiveDelayMs("0s"), undefined);
  assert.equal(upMod.parsePositiveDelayMs("0.0001s"), 1);
  const now = new Date("2026-11-21T12:00:00.000Z");
  assert.equal(
    upMod.resetAtFrom('{"quotaResetTimeStamp":"2026-11-21T00:00:00Z","quotaResetDelay":"0s","retryDelay":"0.0001s"}', now),
    "2026-11-21T12:00:00.001Z"
  );
  assert.deepEqual(K.unitAntigravityQuotaOutcome(upstream40244), { state: "already", text: upstream40244 });

  // Astra Round 1 #2: stub parsePositiveDelayMs returning Math.ceil(1) (1 ms for "15s") must fail closed
  const stubbedDelay = upstream40244.replace(
    /function parsePositiveDelayMs\(delay\) \{[\s\S]*?\n\}/,
    "function parsePositiveDelayMs(delay) { return delay ? Math.ceil(1) : void 0; }"
  );
  assert.notEqual(stubbedDelay, upstream40244);
  assert.throws(() => K.unitAntigravityQuotaOutcome(stubbedDelay), /resetAtFrom has unexpected shape/);

  // Sol Round 1 #2: helper that discards RETRY_DELAY via sequence expression must fail closed
  const discardedRetry = K.unitAntigravityQuotaOutcome(QUOTA_OUTCOME_FIXTURE).text
    .replace("/*t3-keeper-ag-quota-v1*/", "")
    .replace("?? parseDelay(RETRY_DELAY)", "?? (parseDelay(RETRY_DELAY), void 0)");
  assert.throws(() => K.unitAntigravityQuotaOutcome(discardedRetry), /resetAtFrom has unexpected shape/);

  // Reversed future comparison `isGreaterThan(now, parsedTimestamp.value)` must fail closed
  const reversedFuture = upstream40244.replace("isGreaterThan(parsedTimestamp.value, now)", "isGreaterThan(now, parsedTimestamp.value)");
  assert.throws(() => K.unitAntigravityQuotaOutcome(reversedFuture), /resetAtFrom has unexpected shape/);

  // Round 2 Blocker 1: returning `null` from parsePositiveDelayMs or guarding `delay === null` must fail closed
  const returnsNull = upstream40244.replace("Math.ceil(delayMs) : void 0;", "Math.ceil(delayMs) : null;");
  assert.throws(() => K.unitAntigravityQuotaOutcome(returnsNull), /resetAtFrom has unexpected shape/);
  const checksStrictNull = upstream40244.replace("if (delay === void 0) return void 0;", "if (delay === null) return void 0;");
  assert.throws(() => K.unitAntigravityQuotaOutcome(checksStrictNull), /resetAtFrom has unexpected shape/);

  // Round 2 Blocker 2: wrong microsecond factor (`"\u00b5s": 1000` or `"\u03bcs": 1000`) must fail closed
  const badMicro1 = upstream40244.replace('"\u00b5s": .001', '"\u00b5s": 1000');
  assert.throws(() => K.unitAntigravityQuotaOutcome(badMicro1), /resetAtFrom has unexpected shape/);
  const badMicro2 = upstream40244.replace('"\u03bcs": .001', '"\u03bcs": 1000');
  assert.throws(() => K.unitAntigravityQuotaOutcome(badMicro2), /resetAtFrom has unexpected shape/);

  // Round 2 Hardening: `const delayMs = 0` or top-level reassignment of helper must fail closed
  const constAccum = upstream40244.replace("let delayMs = 0;", "const delayMs = 0;");
  assert.throws(() => K.unitAntigravityQuotaOutcome(constAccum), /resetAtFrom has unexpected shape/);
  const reassignedHelper = `${upstream40244}\nparsePositiveDelayMs = () => 1;\n`;
  assert.throws(() => K.unitAntigravityQuotaOutcome(reassignedHelper), /resetAtFrom has unexpected shape/);

  // Unfamiliar regex fails closed
  const unfamiliar = QUOTA_OUTCOME_FIXTURE.replace("const QUOTA_EXHAUSTED = /\\breason:QUOTA_EXHAUSTED\\b/;", "const QUOTA_EXHAUSTED = /completely_different/;");
  assert.throws(() => K.unitAntigravityQuotaOutcome(unfamiliar), /QUOTA_EXHAUSTED has unexpected shape/);
});

// ---------- 3. Generalized split-chunk multi-file rollback (Astra Pre-OK #3!) ----------

test("split-chunk rollback handles fit + antigravitySteer simultaneously without reintroducing either failed unit on a shared chunk", () => {
  // Scenario A: Shared chunk A holds rule + fit(binCli) + antigravitySteer(acpSteer) with plenty of room,
  // while fit overflows on chunk B (sanitizeTitles) AND antigravitySteer overflows on chunk C (dispatchPolicy)!
  const sharedA = [
    'const R = "- 3-8 words, fewer than 40 characters.";',
    "function subagentThreadTitle(x){return x;}",
    ACP_STEER_FIXTURE,
    PAD(16000),
  ].join("\n");
  const overflowFitB = "const MAX_THREAD_TITLE_CHARS=120;function sanitizeThreadTitle(r){return r.slice(0,MAX_THREAD_TITLE_CHARS);}";
  const overflowSteerC = DISPATCH_POLICY_FIXTURE.replace(/\s+/g, " ").trim(); // minimal WS, zero comments -> overflows
  const okFitD = `function threadTitle(x){return x;}\n${PAD(12000)}`;
  const okOrchE = `${ORCHESTRATOR_STEER_FIXTURE}\n${PAD(12000)}`;

  const archiveA = synthServerAsar({
    "shared-a.mjs": sharedA,
    "fit-overflow-b.mjs": overflowFitB,
    "steer-overflow-c.mjs": overflowSteerC,
    "fit-ok-d.mjs": okFitD,
    "orch-ok-e.mjs": okOrchE,
  });
  const resA = K.inspect(archiveA);
  assert.equal(resA.results.fit.state, "failed");
  assert.equal(resA.results.antigravitySteer.state, "failed");
  assert.equal(resA.results.rule.state, "patched");
  for (const [slot, file] of Object.entries(resA.files)) {
    const out = file.buf.toString("utf8");
    assert.ok(!out.includes("function t3KeeperFitTitle("), `leaked fit into ${slot}`);
    assert.ok(!out.includes("/*t3-keeper-ag-steer-v1*/"), `leaked antigravitySteer into ${slot}`);
  }
  assert.ok(resA.files.binCli.buf.toString("utf8").includes("- 2-5 words, fewer than 36 characters."), "rule must survive on shared chunk A");
  assert.equal(resA.files.delegatedTitles, undefined, "rolled-back fit chunk D must not be written");
  assert.equal(resA.files.orchestratorSteer, undefined, "rolled-back steer chunk E must not be written");

  // Scenario B: Shared chunk A has room for rule + fit (compact ~1783 B) ONLY,
  // so antigravitySteer (+~280 B) overflows on A during Pass 1; fit ALSO overflows on B, while antigravitySteer fits on C and E ->
  // rollback of fit on A must NOT revive antigravitySteer!
  const tightSharedA = [
    'const R="- 3-8 words, fewer than 40 characters.";',
    "function subagentThreadTitle(x){return x;}",
    ACP_STEER_FIXTURE.replace(/\s+/g, " ").trim(),
    PAD(1800),
  ].join("\n");
  const archiveB = synthServerAsar({
    "shared-a.mjs": tightSharedA,
    "fit-overflow-b.mjs": overflowFitB,
    "policy-ok-c.mjs": `${DISPATCH_POLICY_FIXTURE}\n${PAD(12000)}`,
    "fit-ok-d.mjs": okFitD,
    "orch-ok-e.mjs": okOrchE,
  });
  const resB = K.inspect(archiveB);
  assert.equal(resB.results.fit.state, "failed");
  assert.equal(resB.results.antigravitySteer.state, "failed");
  assert.equal(resB.results.rule.state, "patched");
  for (const [slot, file] of Object.entries(resB.files)) {
    const out = file.buf.toString("utf8");
    assert.ok(!out.includes("function t3KeeperFitTitle("), `Scenario B leaked fit into ${slot}`);
    assert.ok(!out.includes("/*t3-keeper-ag-steer-v1*/"), `Scenario B leaked antigravitySteer into ${slot}`);
  }
  assert.ok(resB.files.binCli.buf.toString("utf8").includes("- 2-5 words, fewer than 36 characters."));
});

// ---------- 4. Installed build 5051 end-to-end & reminders integration ----------

test("installed build 5051 patches antigravitySteer and antigravityQuotaOutcome cleanly, preserves bytes, and records restart reasons", () => {
  fs.copyFileSync(pristine, asar);
  fs.rmSync(process.env.T3_KEEPER_HOME, { recursive: true, force: true });
  const before = K.inspect(asar);
  assert.equal(before.results.antigravitySteer.state, "patched");
  assert.equal(before.results.antigravityQuotaOutcome.state, "patched");

  const first = K.apply({ reason: "agfixes-e2e" });
  assert.equal(first.failed.length, 0, `unexpected failures: ${JSON.stringify(first.results)}`);
  assert.equal(first.results.antigravitySteer.state, "patched");
  assert.equal(first.results.antigravityQuotaOutcome.state, "patched");

  const second = K.apply({ reason: "agfixes-e2e-repeat" });
  assert.equal(second.wrote, false);
  assert.equal(second.results.antigravitySteer.state, "already");
  assert.equal(second.results.antigravityQuotaOutcome.state, "already");

  const pending = R.readStateFile(path.join(process.env.T3_KEEPER_HOME, "reminders.json")).state.pending;
  assert.ok(pending.reasons.includes("antigravitySteer"));
  assert.ok(pending.reasons.includes("antigravityQuotaOutcome"));
});
