# Relay Selection Benchmark Report

- Generated: 2026-03-06T14:29:16.203Z
- Baseline old manager source: `HEAD` commit `a2a3ee05661e5e838a3d8db865f6f0c84e762f92`
- Candidate manager source: current working tree `clientManager.js`
- Relay pool: default pre-net seeds
- Device lookup samples: 0x4632c04cf8c44a586554951e7de03ca2bd3e8f1c, 0xca1e71d8105a598810578fb6042fa8cbc1e7f039, 0x5365baf29cb7ab58de588dfc448913cb609283e2
- Network discovery mode: live
- Benchmark profile: startup discovery only; background discovery probing disabled for deterministic timing

## Summary

- Average connect time: old 2270.5 ms, current 1966.02 ms
- Average selected relay RTT: old 183.77 ms, current 17.08 ms
- Average best connected RTT: old 18.16 ms, current 16.84 ms
- Average gap to best: old 165.61 ms, current 0.23 ms
- Average device resolution: old 691.21 ms, current 1798.65 ms
- Current device-resolution categories: control-plane lookup itself was slow: 3; no reconciliation needed: 5; no alternate answer available: 1

## Per-Phase Relay Summary

| Phase | Version | Connect ms | Startup relays | Selected relay | Source | Selected RTT ms | Best relay | Best RTT ms | Gap ms | Discovery usable | Discovery startup |
| --- | --- | ---: | ---: | --- | --- | ---: | --- | ---: | ---: | ---: | ---: |
| cold | old | 2543.16 | 6 | as2.prenet.diode.io:41046 | seed | 190.58 | eu1.prenet.diode.io:41046 | 20.02 | 170.56 | n/a | n/a |
| cold | current | 2001.59 | 3 | 100.42.185.191:41046 | network | 14.52 | eu1.prenet.diode.io:41046 | 13.81 | 0.7 | 160 | 2 |
| warm-1 | old | 2291.21 | 6 | as2.prenet.diode.io:41046 | seed | 180.23 | eu1.prenet.diode.io:41046 | 13.03 | 167.21 | n/a | n/a |
| warm-1 | current | 2006.26 | 3 | eu1.prenet.diode.io:41046 | seed | 15.85 | eu1.prenet.diode.io:41046 | 15.85 | 0 | 163 | 2 |
| warm-2 | old | 1977.14 | 6 | as2.prenet.diode.io:41046 | seed | 180.48 | eu1.prenet.diode.io:41046 | 21.43 | 159.05 | n/a | n/a |
| warm-2 | current | 1890.22 | 3 | eu1.prenet.diode.io:41046 | seed | 20.86 | eu1.prenet.diode.io:41046 | 20.86 | 0 | 163 | 2 |

## Per-Device Summary

| Device | Version | Samples | Successes | Avg resolution ms | Hosts seen | Categories |
| --- | --- | ---: | ---: | ---: | --- | --- |
| 0x4632c04cf8c44a586554951e7de03ca2bd3e8f1c | old | 3 | 3 | 316.99 | us2.prenet.diode.io:41046 | unclassified: 3 |
| 0xca1e71d8105a598810578fb6042fa8cbc1e7f039 | old | 3 | 3 | 1497.74 | us1.prenet.diode.io:41046 | unclassified: 3 |
| 0x5365baf29cb7ab58de588dfc448913cb609283e2 | old | 3 | 3 | 258.92 | us2.prenet.diode.io:41046 | unclassified: 3 |
| 0x4632c04cf8c44a586554951e7de03ca2bd3e8f1c | current | 3 | 3 | 3042.14 | 144.126.157.138:41046 | control-plane lookup itself was slow: 1; no reconciliation needed: 1; no alternate answer available: 1 |
| 0xca1e71d8105a598810578fb6042fa8cbc1e7f039 | current | 3 | 3 | 2042 | 100.42.185.191:41046, eu1.prenet.diode.io:41046 | control-plane lookup itself was slow: 2; no reconciliation needed: 1 |
| 0x5365baf29cb7ab58de588dfc448913cb609283e2 | current | 3 | 3 | 311.8 | us1.prenet.diode.io:41046, eu1.prenet.diode.io:41046 | no reconciliation needed: 3 |

## Per-Device Samples

| Phase | Version | Device | Relay | Source | Resolution ms | Category |
| --- | --- | --- | --- | --- | ---: | --- |
| cold | old | 0x4632c04cf8c44a586554951e7de03ca2bd3e8f1c | us2.prenet.diode.io:41046 | seed | 580.29 | n/a |
| cold | old | 0xca1e71d8105a598810578fb6042fa8cbc1e7f039 | us1.prenet.diode.io:41046 | seed | 4146.47 | n/a |
| cold | old | 0x5365baf29cb7ab58de588dfc448913cb609283e2 | us2.prenet.diode.io:41046 | seed | 492.57 | n/a |
| cold | current | 0x4632c04cf8c44a586554951e7de03ca2bd3e8f1c | 144.126.157.138:41046 | target | 6557.6 | control-plane lookup itself was slow |
| cold | current | 0xca1e71d8105a598810578fb6042fa8cbc1e7f039 | 100.42.185.191:41046 | network | 3158.21 | control-plane lookup itself was slow |
| cold | current | 0x5365baf29cb7ab58de588dfc448913cb609283e2 | us1.prenet.diode.io:41046 | seed | 227.87 | no reconciliation needed |
| warm-1 | old | 0x4632c04cf8c44a586554951e7de03ca2bd3e8f1c | us2.prenet.diode.io:41046 | seed | 190.72 | n/a |
| warm-1 | old | 0xca1e71d8105a598810578fb6042fa8cbc1e7f039 | us1.prenet.diode.io:41046 | seed | 169.51 | n/a |
| warm-1 | old | 0x5365baf29cb7ab58de588dfc448913cb609283e2 | us2.prenet.diode.io:41046 | seed | 132.37 | n/a |
| warm-1 | current | 0x4632c04cf8c44a586554951e7de03ca2bd3e8f1c | 144.126.157.138:41046 | target | 1225.89 | no reconciliation needed |
| warm-1 | current | 0xca1e71d8105a598810578fb6042fa8cbc1e7f039 | eu1.prenet.diode.io:41046 | seed | 2935.82 | control-plane lookup itself was slow |
| warm-1 | current | 0x5365baf29cb7ab58de588dfc448913cb609283e2 | eu1.prenet.diode.io:41046 | seed | 676.05 | no reconciliation needed |
| warm-2 | old | 0x4632c04cf8c44a586554951e7de03ca2bd3e8f1c | us2.prenet.diode.io:41046 | seed | 179.94 | n/a |
| warm-2 | old | 0xca1e71d8105a598810578fb6042fa8cbc1e7f039 | us1.prenet.diode.io:41046 | seed | 177.22 | n/a |
| warm-2 | old | 0x5365baf29cb7ab58de588dfc448913cb609283e2 | us2.prenet.diode.io:41046 | seed | 151.8 | n/a |
| warm-2 | current | 0x4632c04cf8c44a586554951e7de03ca2bd3e8f1c | 144.126.157.138:41046 | target | 1342.93 | no alternate answer available |
| warm-2 | current | 0xca1e71d8105a598810578fb6042fa8cbc1e7f039 | eu1.prenet.diode.io:41046 | seed | 31.97 | no reconciliation needed |
| warm-2 | current | 0x5365baf29cb7ab58de588dfc448913cb609283e2 | eu1.prenet.diode.io:41046 | seed | 31.49 | no reconciliation needed |
