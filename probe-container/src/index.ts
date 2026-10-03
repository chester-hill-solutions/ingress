/**
 * Probe: can a Durable Object own a container, and can that container get bytes
 * out to a gate the platform intercepts?
 *
 * This exists because the product's load-bearing claim depends on three
 * primitives being simultaneously true on a live account:
 *
 *   1. a DO can start a container from a registry image
 *   2. outbound HTTP from inside that container reaches a WorkerEntrypoint gate
 *   3. the container can compute a manifest of its own filesystem and deliver it
 *
 * If (3) fails, the workspace can never learn what a participant actually did,
 * and the write fence stays self-reported. So this measures all three in one
 * container start rather than discovering the gap later.
 *
 * Everything is written to Durable Object storage and echoed on /report, because
 * a probe whose answer only exists in a container log is a probe whose answer
 * can be lost.
 */

import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';

interface Env {
  PROBE: DurableObjectNamespace<ProbeAgent>;
  GATE: Fetcher;
}

/**
 * A script that runs inside the container and reports what it can see.
 *
 * Deliberately adaptive: it does not assume `node`, `curl`, or `sha256sum`
 * exist. Whichever path succeeds is itself part of the finding, so the script
 * reports the path it took rather than failing quietly.
 *
 * The work directory is /workspace because that is the conventional container
 * workspace and a real participant will be pointed there too.
 */
const PROBE_SCRIPT = String.raw`
# Absolute first action: prove the egress channel before anything else can fail.
# If this POST never arrives, nothing later in this script is evidence of anything.
printf "FIRST-LINE-REACHED pid=%s\n" "$$" > /tmp/probe-facts.txt

send() {
  if command -v curl >/dev/null 2>&1; then
    curl -s -m 15 -X POST -H "x-transport: $1" --data-binary @/tmp/probe-facts.txt http://workspace.internal/report 2>&1 | sed "s/^/RESPONSE /"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -T 15 -O - --post-file=/tmp/probe-facts.txt http://workspace.internal/report 2>&1 | sed "s/^/RESPONSE /"
  elif command -v node >/dev/null 2>&1; then
    node -e 'const fs=require("fs");fetch("http://workspace.internal/report",{method:"POST",body:fs.readFileSync("/tmp/probe-facts.txt")}).then(r=>r.text()).then(t=>console.log("RESPONSE "+t)).catch(e=>console.log("RESPONSE FAIL "+e.message))'
  else
    echo "NO-HTTP-CLIENT-FOUND" >> /tmp/probe-facts.txt
  fi
}

send first
set +e

WORK=/workspace
mkdir -p "$WORK" 2>/dev/null
echo "agent-probe-wrote-this" > "$WORK/probe-written-by-agent.txt" 2>/dev/null

emit() { printf "%s\n" "$1"; }

{
  emit "== binaries =="
  for b in sh bash node python3 curl wget sha256sum find stat busybox git npm; do
    p=$(command -v "$b" 2>/dev/null)
    if [ -n "$p" ]; then emit "have $b -> $p"; else emit "missing $b"; fi
  done
  emit "== identity =="
  emit "pid=$$ uid=$(id -u 2>/dev/null) user=$(id -un 2>/dev/null) pwd=$(pwd 2>/dev/null)"
  emit "== os-release =="
  cat /etc/os-release 2>/dev/null | head -6
} >> /tmp/probe-facts.txt 2>&1

{
  emit "== manifest =="
  find "$WORK" -type f 2>/dev/null | LC_ALL=C sort | while IFS= read -r f; do
    rel=$(printf '%s' "$f" | sed "s|^$WORK/||")
    if command -v sha256sum >/dev/null 2>&1; then
      h=$(sha256sum "$f" 2>/dev/null | cut -d" " -f1)
    else
      h="nohash"
    fi
    printf "%s %s %s\n" "$rel" "$(wc -c < "$f" 2>/dev/null | tr -d " ")" "$h"
  done
} >> /tmp/probe-facts.txt 2>&1

send full
emit "probe script finished"
sleep 3
`;

/** The gate: every outbound request from inside the container lands here. */
export class GateProbe extends WorkerEntrypoint<Env> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const transport = request.headers.get('x-transport') ?? 'unknown';
    let body = '';
    try {
      body = await request.text();
    } catch {
      body = '(unreadable body)';
    }

    await this.env.PROBE.get(this.env.PROBE.idFromName('probe')).record({
      at: new Date().toISOString(),
      method: request.method,
      url: url.pathname,
      transport,
      bytes: body.length,
      body: body.slice(0, 8000),
    });

    // Anything that is not our report is refused. The container has no business
    // reaching anything else, and saying so is cheaper than finding out later.
    if (url.pathname !== '/report') {
      return new Response('REFUSED: only /report is permitted', { status: 409 });
    }
    return new Response('GATE-OK', { status: 200 });
  }
}

export class ProbeAgent extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/report') {
      return Response.json({ events: (await this.ctx.storage.get('events')) ?? [] });
    }

    if (url.pathname !== '/run') {
      return Response.json({ error: 'not_found', routes: ['/run', '/report'] }, { status: 404 });
    }

    const container = this.ctx.container;

    // Interception must be installed before the container starts, or there is a
    // window in which its egress is unmediated.
    await container.interceptAllOutboundHttp(this.env.GATE);
    container.start({
      entrypoint: ['/bin/sh', '-c', PROBE_SCRIPT],
      enableInternet: false,
      env: {
        INGRESS_PROBE: 'true',
        INGRESS_PARTICIPANT: url.searchParams.get('participant') ?? 'probe',
      },
    });

    // Snapshots are the primitive the whole product thesis rests on, so probe every
    // available variant rather than concluding from the first failure.
    //
    // Crucially, this runs *while the container is live*. An earlier probe
    // snapshotted immediately after `start()` and reported the capability as
    // absent; that is also what you would see if the container had not finished
    // booting. Liveness is established by the gate actually receiving the
    // container's first outbound request, so "the container is up" is observed
    // rather than assumed.
    const snapshotAttempts: Record<string, unknown> = {};
    const attempt = async (label: string, fn: () => Promise<unknown>) => {
      try {
        snapshotAttempts[label] = { ok: true, value: await fn() };
      } catch (error) {
        snapshotAttempts[label] = { ok: false, error: String(error) };
      }
    };

    const priorEvents = ((await this.ctx.storage.get('events')) ?? []) as unknown[];
    const baselineCount = priorEvents.length;
    const waitForLive = async (timeoutMs: number) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const now = ((await this.ctx.storage.get('events')) ?? []) as unknown[];
        if (now.length > baselineCount) return true;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      return false;
    };

    const liveObserved = await waitForLive(30_000);
    snapshotAttempts.containerProvenLive = { ok: liveObserved, value: `gate saw ${baselineCount}->events` };

    await attempt('snapshotContainer/live', () => container.snapshotContainer({ name: 'probe-live' }));
    await attempt('snapshotContainer/live/again', () => container.snapshotContainer({ name: 'probe-live-2' }));

    let monitorError: string | null = null;
    try {
      await container.monitor();
    } catch (error) {
      monitorError = String(error);
    }

    const events = ((await this.ctx.storage.get('events')) ?? []) as unknown[];
    return Response.json({
      ran: true,
      snapshotAttempts,
      monitorError,
      running: (container as { running?: boolean }).running ?? null,
      eventCount: events.length,
      lastEvent: events[events.length - 1] ?? null,
    });
  }

  /** Anything the gate saw, plus the container's own exit shape. */
  async record(event: unknown) {
    const events = ((await this.ctx.storage.get('events')) ?? []) as unknown[];
    events.push(event);
    await this.ctx.storage.put('events', events.slice(-50));
  }

  async tailLogs(): Promise<string> {
    try {
      const out: string[] = [];
      // @ts-expect-error -- setInactivityTimeout/exec surface varies by runtime
      this.ctx.container.setInactivityTimeout(5_000);
      await new Promise(resolve => setTimeout(resolve, 250));
      return out.join('\n');
    } catch {
      return '(no log capture available)';
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return Response.json({ ok: true, service: 'ingress-container-probe' });
    }
    const match = /^\/probe(\/.*)?$/.exec(url.pathname);
    if (match) {
      const stub = env.PROBE.get(env.PROBE.idFromName('probe'));
      const target = new URL(`https://probe.internal${match[1] ?? '/run'}`);
      target.search = url.search;
      return stub.fetch(target.toString(), request);
    }
    return Response.json({ error: 'not_found' }, { status: 404 });
  },
};