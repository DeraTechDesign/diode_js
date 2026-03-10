# Relay Selection Benchmark Report

- Generated: 2026-03-06T14:14:12.307Z
- Baseline old manager source: `HEAD` commit `a2a3ee05661e5e838a3d8db865f6f0c84e762f92`
- Candidate manager source: current working tree `clientManager.js`
- Relay pool: default pre-net seeds
- Device lookup samples: 0x4632c04cf8c44a586554951e7de03ca2bd3e8f1c, 0xca1e71d8105a598810578fb6042fa8cbc1e7f039, 0x5365baf29cb7ab58de588dfc448913cb609283e2
- Network discovery mode: live
- Benchmark profile: startup discovery only; background discovery probing disabled for deterministic timing

## Summary

- Average connect time: old 2122.03 ms, current 2763.02 ms
- Average selected relay RTT: old 177.65 ms, current 12.27 ms
- Average best connected RTT: old 13.02 ms, current 12.27 ms
- Average gap to best: old 164.63 ms, current 0 ms
- Average device resolution: old 189.82 ms, current 1443.35 ms
- Current device-resolution categories: no alternate answer available: 3

| Phase | Version | Connect ms | Startup relays | Selected relay | Source | Selected RTT ms | Best relay | Best RTT ms | Gap ms | Discovery usable | Discovery startup | Device relay | Device source | Device resolution ms | Device resolution category |
| --- | --- | ---: | ---: | --- | --- | ---: | --- | ---: | ---: | ---: | ---: | --- | --- | ---: | --- |
| cold | old | 2347.21 | 6 | as2.prenet.diode.io:41046 | seed | 167.86 | eu1.prenet.diode.io:41046 | 13.74 | 154.13 | n/a | n/a | us2.prenet.diode.io:41046 | seed | 175.28 | n/a |
| cold | current | 2836.06 | 3 | eu1.prenet.diode.io:41046 | seed | 14.09 | eu1.prenet.diode.io:41046 | 14.09 | 0 | 159 | 2 | 144.126.157.138:41046 | target | 1726.32 | no alternate answer available |
| warm-1 | old | 1999.11 | 6 | as2.prenet.diode.io:41046 | seed | 181.35 | eu1.prenet.diode.io:41046 | 9.57 | 171.78 | n/a | n/a | us2.prenet.diode.io:41046 | seed | 183.5 | n/a |
| warm-1 | current | 2720.2 | 3 | eu1.prenet.diode.io:41046 | seed | 12.44 | eu1.prenet.diode.io:41046 | 12.44 | 0 | 161 | 2 | 144.126.157.138:41046 | target | 1315.58 | no alternate answer available |
| warm-2 | old | 2019.78 | 6 | as2.prenet.diode.io:41046 | seed | 183.72 | eu1.prenet.diode.io:41046 | 15.75 | 167.97 | n/a | n/a | us2.prenet.diode.io:41046 | seed | 210.68 | n/a |
| warm-2 | current | 2732.82 | 3 | eu1.prenet.diode.io:41046 | seed | 10.3 | eu1.prenet.diode.io:41046 | 10.3 | 0 | 167 | 2 | 144.126.157.138:41046 | target | 1288.15 | no alternate answer available |
