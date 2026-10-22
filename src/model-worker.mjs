/**
 * One model turn that produces one file, with what it cost.
 *
 * Why this is harness-side and not inside the container
 *
 * The product's architecture is an outside harness driving a deterministic sandbox: the
 * container runs a command, the fence arbitrates what lands, and no model exists inside it.
 * Putting a model in the container would mean passing a provider credential into a command
 * string that the workspace stores, and the container's own log is durable evidence — so the
 * credential would end up in the record this project is careful not to put it in. The model
 * therefore runs here, in a temporary directory, and its bytes are published through the
 * ordinary participant path: a container command writes them and declares what they were
 * built from.
 *
 * What that boundary costs, stated plainly: **the model's work is not confined to the
 * sandbox.** It reads and writes files on the machine running the harness, and only its
 * *publication* goes through the fence. The stronger profile — a model whose editing happens
 * inside the private working copy — is a distinct piece of work that the plan already
 * carries, and running the weaker one while saying so is the honest order to do them in.
 *
 * What it measures
 *
 * Tokens and cost are taken from the native step events, by the same collector the squad
 * harness uses, so a figure from this module and a figure from a squad run mean the same
 * thing. A step whose cost was not reported is `null` rather than zero, and the totals say
 * whether they are complete — a cost total that silently treated "unknown" as "free" would
 * make every mechanism look affordable.
 */

import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { startOpenCode } from './process.mjs';
import { OpenCodeClient, safeRuntimeError } from './opencode.mjs';
import { ModelSteps } from './squad.mjs';

/**
 * How large a file the model may produce before the harness refuses to publish it.
 *
 * Bounded for a plumbing reason that is worth naming: the bytes travel to the container inside
 * a participant command, and that command is capped at 4 KiB. A model that answers with an
 * essay would otherwise fail as a mysterious refusal from `/start`. This says what actually
 * happened instead.
 */
export const MAX_MODEL_FILE_BYTES = 1_536;

const finite = value => (Number.isFinite(value) ? value : null);

/**
 * The session's own account of a failed turn, reduced to the harness's vocabulary.
 *
 * Type, status and finish reason only. The provider's message is deliberately dropped, the same
 * rule `safeRuntimeError` applies: it is prose from another system, and it does not belong in
 * this repository's evidence. The first model-mode run recorded nothing at all about why nine
 * turns failed, and a harness that cannot say "provider.auth, 401" cannot tell a broken key from
 * a broken prompt.
 */
async function sessionError(client, sessionID) {
  try {
    const context = await client.context(sessionID, AbortSignal.timeout(5_000));
    const messages = Array.isArray(context?.data) ? context.data : [];
    for (const message of [...messages].reverse()) {
      const error = message?.error;
      if (!error) continue;
      return {
        ...(typeof error.type === 'string' ? { type: error.type } : {}),
        ...(Number.isInteger(error.status) ? { status: error.status } : {}),
        ...(typeof message.finish === 'string' ? { finish: message.finish } : {}),
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Run one model task.
 *
 * `inputs` is written into the working directory before the turn, so the model reads the
 * revision the harness fetched rather than whatever happens to be on disk. `output` is the
 * path the model is expected to have written when it stops.
 *
 * @returns {Promise<object>} the content, the bytes, the cost, and how it ended
 */
export async function runModelTask({ profile, inputs = {}, output, prompt, deadlineMs = 300_000, label = 'model-task', signal }) {
  const base = await mkdtemp(join(tmpdir(), 'ingress-model-task-'));
  const directory = join(base, 'work');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const [path, content] of Object.entries(inputs)) {
    const target = resolve(directory, path);
    // The model's directory is a sandbox by convention, not by enforcement: nothing here
    // should be able to ask for a path outside it just because it came from the workspace.
    if (!target.startsWith(directory + sep)) throw new Error('input_path_outside_working_directory');
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }

  const result = {
    label,
    model: profile?.model ?? null,
    prompt,
    inputs: Object.keys(inputs).sort(),
    output,
    startedAt: new Date().toISOString(),
    outcome: null,
    error: null,
    streamFailure: null,
    content: null,
    bytes: null,
    cost: null,
    costComplete: false,
    tokens: { input: null, output: null, reasoning: null, cache: { read: null, write: null } },
    steps: 0,
    omissions: null,
    elapsedMs: null,
  };

  let host = null;
  let client = null;
  let streamController = null;
  let streaming = null;
  const started = Date.now();
  const stopSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(deadlineMs)])
    : AbortSignal.timeout(deadlineMs);

  try {
    host = await startOpenCode({
      binary: profile.binary,
      stateDir: join(base, 'state'),
      directory,
      apiKey: profile.apiKey,
      baseURL: profile.baseURL,
      modelCatalogPath: profile.modelCatalogPath,
      signal: stopSignal,
    });

    // No permissions are passed, so the client's default applies: everything denied except
    // read, write, edit, glob and grep. That is exactly the surface this task needs -- a model
    // that could run commands could also run somebody else's command, and the mission has no
    // use for one.
    client = new OpenCodeClient({ ...host, directory, model: profile.model });
    const sessionID = await client.createSession(label, stopSignal);
    result.sessionID = sessionID;

    const steps = new ModelSteps();
    let cursor = null;
    let gap = false;
    streamController = new AbortController();
    streaming = (async () => {
      try {
        for await (const event of client.events(sessionID, { transport: 'live', signal: streamController.signal })) {
          if (event?.seq !== undefined && cursor !== null && event.seq !== cursor + 1) { gap = true; steps.gap(); }
          if (event?.seq !== undefined) cursor = event.seq;
          steps.observe(event, { gap });
        }
      } catch (error) {
        if (!streamController.signal.aborted) result.streamFailure = safeRuntimeError(error);
      }
    })();

    const messageID = `msg_${randomUUID().replaceAll('-', '')}`;
    await client.prompt(sessionID, prompt, { id: messageID, signal: stopSignal });
    const terminal = await client.wait(sessionID, stopSignal, { pollIntervalMs: 500 });
    result.outcome = terminal.outcome;
    if (terminal.outcome !== 'succeeded') result.sessionError = await sessionError(client, sessionID);

    // The stream is stopped rather than waited on: it settles when the session is idle and
    // there is no further event coming, and a harness that waited for it would hang on the
    // quiet after the last token.
    streamController.abort();
    await streaming;
    streaming = null;

    const costs = steps.steps.map(step => step.cost).filter(value => value !== null);
    result.cost = costs.length > 0 ? costs.reduce((total, value) => total + value, 0) : null;
    // Said out loud, because a total is only a measurement if every step in it was measured.
    result.costComplete = steps.steps.length > 0 && costs.length === steps.steps.length;
    for (const key of ['input', 'output', 'reasoning']) {
      const values = steps.steps.map(step => step.tokens[key]).filter(value => value !== null);
      result.tokens[key] = values.length > 0 ? values.reduce((total, value) => total + value, 0) : null;
    }
    for (const key of ['read', 'write']) {
      const values = steps.steps.map(step => step.tokens.cache[key]).filter(value => value !== null);
      result.tokens.cache[key] = values.length > 0 ? values.reduce((total, value) => total + value, 0) : null;
    }
    result.steps = steps.steps.length;
    result.omissions = steps.omissions;

    const produced = await readFile(join(directory, output)).catch(() => null);
    result.bytes = produced ? produced.byteLength : null;
    result.content = produced ? produced.toString('utf8') : null;
    if (!produced) result.error = 'model_wrote_no_output';
    else if (produced.byteLength > MAX_MODEL_FILE_BYTES) result.error = 'model_output_too_large';
  } catch (error) {
    result.error = result.error ?? 'model_task_failed';
    result.runtimeError = safeRuntimeError(error);
  } finally {
    result.elapsedMs = Date.now() - started;
    try { streamController?.abort(); } catch { /* already aborted */ }
    try { await streaming; } catch { /* the loop reports its own failure */ }
    try { client?.close(); } catch { /* closing is best effort */ }
    try { await host?.close(); result.hostStopped = true; } catch { result.hostStopped = false; }
    // The bytes are returned rather than kept, so the working directory does not outlive the
    // task: what the model produced is the content, and only the content is evidence here.
    await rm(base, { recursive: true, force: true });
  }

  // The same rule the caller applies, so the run's own verdict and the driver's cannot
  // disagree about whether the turn produced something publishable.
  const publication = publicationOf(result);
  result.publishable = publication.ok;
  if (!publication.ok && result.error === null) result.error = publication.reason;
  result.ok = publication.ok;
  return result;
}

/**
 * Whether a model turn produced something the mission may publish.
 *
 * This exists because the first run of the model mode published *empty files*. The model turns
 * all failed — the provider key had expired — and the harness took `result.content ?? ''` and
 * sent a container to write nothing, which landed as a legitimate publication with a
 * declaration. The mission then reported a coherent, correct-looking workspace full of empty
 * files, and every downstream check measured a mechanism that had never been exercised.
 *
 * A failed turn must therefore stop the mission rather than publish. The rule is deliberately
 * blunt: the turn has to have succeeded, produced bytes, and produced no error of its own. The
 * bytes are also bounded here, because the participant command carrying them is capped and a
 * model that answers with an essay should fail as "too much output" rather than as a mysterious
 * refusal from `/start`.
 */
export function publicationOf(result) {
  if (!result || typeof result !== 'object') return { ok: false, reason: 'no_result' };
  if (result.outcome !== 'succeeded') return { ok: false, reason: `outcome_${result.outcome ?? 'unknown'}` };
  if (result.error !== null && result.error !== undefined) return { ok: false, reason: result.error };
  if (typeof result.content !== 'string' || result.content.length === 0) return { ok: false, reason: 'empty_content' };
  const bytes = Buffer.byteLength(result.content, 'utf8');
  if (bytes > MAX_MODEL_FILE_BYTES) return { ok: false, reason: 'output_too_large', bytes };
  return { ok: true, content: result.content, bytes };
}

/** The totals one or more tasks add up to, with the completeness of each total kept. */export function modelTax(results) {
  const costs = results.map(result => result.cost).filter(value => value !== null);
  const tokens = key => results.map(result => result.tokens[key]).filter(value => value !== null);
  const input = tokens('input');
  const output = tokens('output');
  return {
    calls: results.length,
    succeeded: results.filter(result => result.ok).length,
    cost: costs.length > 0 ? costs.reduce((total, value) => total + value, 0) : null,
    costComplete: costs.length === results.length,
    steps: results.reduce((total, result) => total + (Number.isFinite(result.steps) ? result.steps : 0), 0),
    inputTokens: input.length > 0 ? input.reduce((total, value) => total + value, 0) : null,
    outputTokens: output.length > 0 ? output.reduce((total, value) => total + value, 0) : null,
    // Both totals are reportable only if every call reported them; a partial token count
    // presented as a total is the same mistake as a partial cost total.
    tokensComplete: input.length === results.length && output.length === results.length,
    byLabel: results.map(result => ({ label: result.label, ok: result.ok, cost: finite(result.cost), steps: result.steps, outcome: result.outcome, error: result.error })),
  };
}
