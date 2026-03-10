# Relay Selection Benchmark Report

- Generated: 2026-03-06T11:18:00.363Z
- Baseline old manager source: `HEAD` commit `a2a3ee05661e5e838a3d8db865f6f0c84e762f92`
- Current manager source: working tree `clientManager.js` with relay ranking changes
- Environment: local run from `c:\Users\4ever\Documents\GitHub\diode_js`, timezone `Europe/Berlin`
- Relay pool: default six pre-net seeds
- Device lookup sample: `0x4632c04cf8c44a586554951e7de03ca2bd3e8f1c`

## Summary

- Average connect time: old 2379.06 ms, current 3925.75 ms
- Average selected-relay RTT: old 177 ms, current 120.07 ms
- Average best-connected RTT seen by the manager: old 14.73 ms, current 120.07 ms
- Average device-resolution time: old 181.35 ms, current 130.8 ms
- Warm device-resolution time only: old 178.53 ms, current 134.09 ms

## Key Findings

- Old manager connected to all six seeds every time and round-robined across them. The first selected relay in every trial was `as2.prenet.diode.io:41046`, which was never the lowest-latency relay.
- Current manager consistently selected `us2.prenet.diode.io:41046`, and the selected relay RTT was materially lower than old-manager selection.
- Current manager did not probe `eu1` or `eu2` during these runs, so it missed the actual fastest relay available from this Berlin-based environment.
- The old manager had access to `eu1` with ~10-30 ms RTT, but because selection was round-robin, it still chose much slower relays for control-plane work.
- Current manager improved `getConnectionForDevice()` timing substantially, especially on cold start, because it kept using a better control relay than `as2`.
- Current defaults appear too aggressive for pruning the startup set: `startupProbeCount=4` plus `desiredWarmConnections=3` prevented later probes of the EU seeds once four relays were already connected.

## Per-Trial Results

| Phase | Version | Connect ms | Startup relays | Selected relay | Selected RTT ms | Best connected relay | Best RTT ms | Device resolution ms |
| --- | --- | ---: | ---: | --- | ---: | --- | ---: | ---: |
| cold | old | 2339.75 | 6 | as2.prenet.diode.io:41046 | 173.13 | eu1.prenet.diode.io:41046 | 13.1 | 186.99 |
| cold | current | 3465.82 | 4 | us2.prenet.diode.io:41046 | 110.2 | us2.prenet.diode.io:41046 | 110.2 | 124.21 |
| warm-1 | old | 2332.59 | 6 | as2.prenet.diode.io:41046 | 180.89 | eu1.prenet.diode.io:41046 | 17.24 | 183.5 |
| warm-1 | current | 4430.66 | 4 | us2.prenet.diode.io:41046 | 127.52 | us2.prenet.diode.io:41046 | 127.52 | 135.46 |
| warm-2 | old | 2464.82 | 6 | as2.prenet.diode.io:41046 | 176.99 | eu1.prenet.diode.io:41046 | 13.86 | 173.56 |
| warm-2 | current | 3880.76 | 4 | us2.prenet.diode.io:41046 | 122.48 | us2.prenet.diode.io:41046 | 122.48 | 132.73 |

## Selection Sequences

- cold old: as2.prenet.diode.io:41046 -> us1.prenet.diode.io:41046 -> us2.prenet.diode.io:41046 -> eu1.prenet.diode.io:41046 -> eu2.prenet.diode.io:41046 -> as1.prenet.diode.io:41046
- cold current: us2.prenet.diode.io:41046 -> us2.prenet.diode.io:41046 -> us2.prenet.diode.io:41046 -> us2.prenet.diode.io:41046 -> us2.prenet.diode.io:41046 -> us2.prenet.diode.io:41046
- warm-1 old: as2.prenet.diode.io:41046 -> us1.prenet.diode.io:41046 -> us2.prenet.diode.io:41046 -> eu1.prenet.diode.io:41046 -> eu2.prenet.diode.io:41046 -> as1.prenet.diode.io:41046
- warm-1 current: us2.prenet.diode.io:41046 -> us2.prenet.diode.io:41046 -> us2.prenet.diode.io:41046 -> us2.prenet.diode.io:41046 -> us2.prenet.diode.io:41046 -> us2.prenet.diode.io:41046
- warm-2 old: as2.prenet.diode.io:41046 -> us1.prenet.diode.io:41046 -> us2.prenet.diode.io:41046 -> eu1.prenet.diode.io:41046 -> eu2.prenet.diode.io:41046 -> as1.prenet.diode.io:41046
- warm-2 current: us2.prenet.diode.io:41046 -> us2.prenet.diode.io:41046 -> us2.prenet.diode.io:41046 -> us2.prenet.diode.io:41046 -> us2.prenet.diode.io:41046 -> us2.prenet.diode.io:41046

## Interpretation

- If the goal is to avoid obviously bad relay choices, the current manager is better than the old round-robin implementation.
- If the goal is to reach the true lowest-delay relay from this location, the current defaults are still insufficient because they never sampled the EU seeds.
- The benchmark therefore shows a partial improvement, not a complete solution to the original latency problem.

## Recommended Follow-Up

- Raise startup coverage so every default seed is sampled at least once, or ensure the startup set is region-diverse rather than a prefix of the seed list.
- Allow background probing of untested default seeds even when `desiredWarmConnections` is already satisfied.
- Consider persisting negative evidence too, but do not let early winners permanently block untested regions.