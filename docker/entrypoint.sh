#!/bin/bash
# One container, two processes: the web dashboard and the scheduler.
#
# They are the same two processes the Windows instance always ran, sharing one
# SQLite database through WAL exactly as before - the container changes where
# they run, not what they are (deployment only, §11).
#
# The contract with Docker:
#
#   - if EITHER process dies, the container exits and `restart: unless-stopped`
#     brings both back. Half a radar - a dashboard with no scheduler behind it,
#     or a scheduler nobody can see - looks healthy from the outside, which is
#     the worst kind of down.
#
#   - SIGTERM is forwarded to both children and WAITED for. The scheduler
#     releases its database lease in a finally-block on the way out, but its
#     main loop only notices between ticks; compose's stop_grace_period covers
#     that. Killing early would strand the lease and cost the next start a
#     90-second stale takeover - self-healing, but not clean.
#
# Two review findings shaped this file:
#
#   - the processes are started with the tsx BINARY, not through npx. npm does
#     not forward signals to the child it spawns, so with npx in the middle
#     every `docker stop` would have SIGKILLed the actual scheduler mid-flight
#     and stranded the lease - on every single stop, invisibly.
#
#   - liveness is a poll loop, not `wait -n`. bash can miss a child that died
#     before wait -n was reached, which would leave a container "running" with
#     zero working processes inside it.
set -u

TSX=/app/node_modules/.bin/tsx
SERVE_PID=
SCHED_PID=

forward_term() {
  [ -n "$SERVE_PID" ] && kill -TERM "$SERVE_PID" 2>/dev/null
  [ -n "$SCHED_PID" ] && kill -TERM "$SCHED_PID" 2>/dev/null
}
trap forward_term TERM INT

# --host 0.0.0.0 is container-scoped, not exposure: serve.ts binds loopback by
# default, which inside a container means nothing can reach it at all. What the
# outside world sees is decided by the compose port mapping, and the NAS itself
# is LAN + tailnet only.
"$TSX" serve.ts --port 8888 --host 0.0.0.0 &
SERVE_PID=$!

"$TSX" observer/cli.ts start &
SCHED_PID=$!

# Liveness: both children, checked every two seconds. kill -0 probes without
# signalling, and a SIGTERM interrupting the sleep just makes the next probe
# happen sooner.
while kill -0 "$SERVE_PID" 2>/dev/null && kill -0 "$SCHED_PID" 2>/dev/null; do
  sleep 2
done

# One of them is gone (or we were told to stop). Take the survivor down too,
# then reap both so their exit is orderly rather than orphaned.
forward_term
wait "$SERVE_PID" 2>/dev/null
SERVE_STATUS=$?
wait "$SCHED_PID" 2>/dev/null
SCHED_STATUS=$?

# Non-zero if either was: the restart policy treats any exit the same, but the
# status should tell the truth in `docker ps -a`.
[ "$SERVE_STATUS" -ne 0 ] && exit "$SERVE_STATUS"
exit "$SCHED_STATUS"
