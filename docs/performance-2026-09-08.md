# DiodeJS relay selection and transport performance, 8 September 2026

The closest-relay hypothesis is partly confirmed. Default cold startup selected
the closest measured seed correctly, but aging that relay's score could move
working traffic to a relay about ten times farther away in RTT. The local fixes
keep the faster route, apply destination reconciliation to warm connections,
honor failed-probe cooldowns, and remove a Native handshake shutdown race.

The fixes are included in diodejs 0.5.4, based on `8feb655` / 0.5.3. The raw
measurements below were taken before the version bump. Consumer applications
must update their pinned library to receive the changes.

## Method and scope

- Windows, Node 22.19.0, using this workstation's actual public-network route.
- Two disposable identities in the same process. The local echo backend listens
  on loopback and is published privately to the other benchmark identity.
  Traffic travels through real public Diode relays and the actual BindPort and
  PublishPort implementations. No customer device is contacted.
- Six default seeds: five ping samples per authenticated connection, plus
  individual initial ticket-command timings. Default discovery runs independently.
- Five supported combinations: `portopen` TCP/TLS/UDP and `portopen2` TCP/UDP.
  Native uses `portopen` for its signed TLS handshake. TLS as an application
  transport uses API; there is no separate Native TLS implementation.
- Fixed-relay matrix: two trials per combination on `eu1` and `us2` with 0.5.3;
  two per combination on `us2` with the complete 0.5.1 source at `f827272`.
  The historical checkout shares installed dependencies to isolate source changes.
- Managed-routing comparison: both identities connect to `eu1`, `us2`, and
  `as1`. Measure all five combinations, then age only the fastest relay's score
  to 61 seconds and repeat. This is an intentional score-aging experiment,
  not a claim that a customer session switched at that instant. The baseline
  loads the 0.5.3 manager against the same 0.5.3 transport implementation.
- Each sample measures first echo, five warm 32-byte echoes, and a 1 MiB stream
  echo with byte-for-byte validation. UDP sends 200 numbered 1 KiB datagrams,
  paced with a requested 2 ms gap, and counts loss. CPU time and event-loop p99
  cover setup and transfer on both local endpoints.

`echoMbps` counts the payload once over upload-plus-echo elapsed time. It is not
one-way link capacity. UDP offered rate depends on Windows timer scheduling;
its throughput numbers are a paced-delivery measurement, not a saturation test.
Trials are small and sequential. TCP slow start, route changes, transient loss,
and CPU warmup affect results; no confidence interval is claimed.

Raw results and verification summaries are in
[`benchmarks/2026-09-08`](../benchmarks/2026-09-08).

## Closest-node measurements

The first default run was ready on `eu1` in 286 ms. It stayed on `eu1` after
discovery finished in 15.48 seconds. Discovery supplied 174 entries, of which
83 were accepted. Background probes included unreachable relays; their timeout
cost did not block initial readiness.

The final directory audit identified all 91 rejected entries as disconnected;
none of the connected entries was rejected for its format. The final default
run was ready on `eu1` in 226 ms, finished discovery/probing in 16.97 seconds,
and retained its 10 ms `eu1` score after the deliberate aging step.

| Seed | Median relay ping | Full authenticated connection |
| --- | ---: | ---: |
| eu1 | 11.33 ms | 112.42 ms |
| eu2 | 16.01 ms | 242.04 ms |
| us2 | 120.12 ms | 878.45 ms |
| us1 | 147.17 ms | 1083.68 ms |
| as1 | 254.11 ms | 1817.64 ms |
| as2 | 388.51 ms | 2011.24 ms |

These are measurements from this workstation, not fixed geographic properties
of the relays. In particular, `as2` varied substantially between trials.
In the final seed check, `as2` needed 5.20 seconds to authenticate: its `bytes`
request took 1.29 seconds and ticket acceptance took 2.09 seconds, while its
five ping samples ranged from 230 to 573 ms. That is a relay/network setup
bottleneck independent of the score-aging fix, and can exceed the manager's
5-second seed setup budget. A nearby alternative remained available throughout.

An additional default-discovery run reproduced score-aging misselection even
without pinning the three-relay set: aging the 13 ms `eu1` measurement selected
a 27 ms discovered relay instead. This confirms that the bug is in ranking,
not restricted to explicit host configuration.

## Reproduced routing regression and improvement

Baseline `_rankConnectedConnections` sorts all fresh scores ahead of all stale
scores, then sorts by RTT. Scores become stale after 60 seconds, but refresh
attempts are throttled for 300 seconds. A healthy 11 ms relay can therefore lose
to a newly measured 120–250 ms relay. The same ranking feeds idle pruning and
advertised relay hints, extending the impact beyond a single control lookup.

Live ticket lookups also showed that the same publisher returned different
usable relay answers depending on the control relay queried: EU via EU, US via
US, Asia via Asia. Selecting the wrong control relay changed the data route.

In the managed aging experiment, baseline selected `us2` for all five modes;
the final implementation retained `eu1` for all five:

| Protocol / RPC | First echo before → after | Warm echo RTT before → after | Stream echo Mbps before → after |
| --- | ---: | ---: | ---: |
| TCP / portopen | 592.70 → 53.85 ms | 234.38 → 20.45 ms | 5.32 → 93.16 |
| TLS / portopen | 1058.35 → 101.70 ms | 234.57 → 22.42 ms | 11.30 → 85.08 |
| UDP / portopen | 593.86 → 55.97 ms | 233.97 → 20.75 ms | paced test |
| TCP / portopen2 | 1770.64 → 421.77 ms | 227.74 → 20.32 ms | 6.33 → 75.55 |
| UDP / portopen2 | 1671.02 → 189.57 ms | 240.77 → 24.05 ms | paced test |

API UDP delivered 200/200 packets in both aging trials. Native UDP delivered
199/200 before and 200/200 after. This small difference does not establish a
general packet-loss improvement. Final fresh and aged trials completed all
ten sessions, with no lost UDP datagrams in that run.

The large stream gains above primarily reflect avoiding the distant route.
They are not evidence that encryption or a fixed relay became 8–18 times faster.

## Other bottlenecks and commit attribution

1. **Warm destination reconciliation was skipped.** A ticket pointing to an
   already-connected slow relay returned immediately, bypassing the existing
   alternate-ticket logic. The fix sends warm and cold candidates through the
   same bounded reconciliation path. A regression test supplies a 300 ms warm
   destination and a valid 20 ms alternate: the old code chooses the slow one,
   the new code chooses and caches the alternate. Ordinary fast routes and
   explicit configuration keep their existing behavior.
2. **Failed ping scores were still preferred.** Connected ranking ignored
   failure cooldowns. The fix demotes failed probes while keeping a connected
   fallback available, and restores preference after a successful measurement.
3. **0.5.1 serialized API writes.** Through `us2`, 0.5.1 measured 1.85–2.13 Mbps
   for TCP and 2.02–2.07 Mbps for TLS. 0.5.3 measured 5.03–12.94 Mbps and
   11.24–11.33 Mbps respectively. The ordered send window introduced in
   `017e3f7` / 0.5.2 already addresses this. It remains bounded at 256 KiB and
   16 frames: long-RTT throughput still has a window/RTT limit. Increasing that
   window needs separate memory, fairness, and backpressure measurements.
4. **Native setup had a TLS shutdown race.** In an intermediate live run,
   Native TCP and UDP each encountered a handshake failure after the signed
   message exchange. Both peers appended TLS close-notify records before
   releasing the temporary API ref; the other end could release it first,
   causing `port does not exist` and premature native-session cleanup. A real
   TLS loopback regression reproduces the failure by rejecting those shutdown
   records. Both sides now flush the complete signed messages and relay ACKs,
   then release the temporary ref without appending shutdown records. Identity
   verification, key derivation, encrypted native data, and normal API TLS
   shutdown are unchanged. The regression and final live matrix pass.
5. **Native still costs more to start.** It allocates a physical relay port,
   opens the TLS handshake channel, exchanges signed messages, and establishes
   the data socket. First echo is therefore substantially slower than warm
   echo. On a fixed US relay, Native TCP in 0.5.3 measured about 1.7 seconds to
   first echo and 6.0–6.4 Mbps for the short stream transfer. It is not uniformly
   faster than API TLS. The extra data socket also pays TCP slow start.

The score-aging and warm-destination defects originated in `8cd58dd` on
10 March, before the Moonbeam changes. `bc83e72` on 2 September additionally
applied the 1200 ms ping budget to full relay setup, and old scoring included
setup time in RTT. `017e3f7` already separated connection deadlines from ping
measurement and made first-ready startup nonblocking.

`f827272` on 4 September changed ticket epoch reads to `glmr:getblockpeak` and
`glmr:getblockheader` for the ticket's chain, retaining two sequential RPCs.
In the first live EU test those calls took 11.20 and 11.78 ms, close to ping RTT;
there was no prolonged Moonbeam lookup stall. That commit does not disable
nearest-node selection. These observations do not establish how remote RPC
availability behaved during the sunset itself. The epoch correction is kept.

CPU and event-loop samples do not show a CPU saturation explanation for the
long-RTT slowdown: representative distant stream samples took several seconds
while using tens to hundreds of milliseconds of combined local CPU. Raw CPU
figures include both identities and occasional manager activity.

## Verification and remaining work

- 245 library tests pass, including four added regression cases.
- Eight Native integration/error tests pass with `.node` addon loading disabled.
- Syntax checks for the three changed runtime files and benchmark pass;
  `git diff --check` passes.
- The final live managed matrix passes all ten fresh/aged transport sessions.
- Intermediate failures are retained in `routing-fixed.json`; they are not
  silently replaced by the successful final run.

Relay cleanup can still log duplicate `port does not exit` replies after an
otherwise successful transfer. Those cleanup replies are not counted as data
failures. Rare Native UDP loss appeared in earlier paced trials. Long-duration
throughput, many concurrent tunnels, bandwidth asymmetry, mobile/ARM hardware,
and client-to-Box paths from separate physical sites remain unmeasured.

Keep API as the default and preserve saved Native choices. Deployment should
update the library at both publishing and binding endpoints so both receive the
handshake correction. No fleet, organization policy, signing boundary, or
OrendaService release workflow was changed.

## Reproduction

From the library checkout in PowerShell:

```powershell
node scripts/benchmark-network.js --output selection.json
node scripts/benchmark-network.js --relay eu1.prenet.diode.io --output eu.json
node scripts/benchmark-network.js --relay us2.prenet.diode.io --output us.json
node scripts/benchmark-network.js --routing --output routing-current.json

# Isolate the old ranking against the current transport implementation.
$env:DIODE_BENCH_MANAGER_REF = '8feb655'
node scripts/benchmark-network.js --routing --output routing-old-manager.json
Remove-Item Env:DIODE_BENCH_MANAGER_REF

# For a complete historical source comparison, use a separate checkout with
# dependencies installed. No application identity or configuration is needed.
$env:DIODE_BENCH_LIBRARY = 'C:\path\to\diodejs-0.5.1-checkout'
node scripts/benchmark-network.js --relay us2.prenet.diode.io --output us-051.json
Remove-Item Env:DIODE_BENCH_LIBRARY

node --test test/*.test.js
node --require ./test/fixtures/no-native-addons.cjs --test test/nativeTcp.integration.test.js test/nativeHandshakeErrors.test.js
```

The benchmark removes its generated identity directory on completion. Results
contain command names and durations, not ticket contents or private keys. A
transport sample failure is retained in JSON and makes the final script exit
nonzero. A UDP loss observation is reported separately from setup failure.
