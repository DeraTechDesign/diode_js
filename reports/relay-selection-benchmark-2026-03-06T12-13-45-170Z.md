# Relay Selection Benchmark Report

- Generated: 2026-03-06T12:13:45.170Z
- Baseline old manager source: `HEAD` commit `a2a3ee05661e5e838a3d8db865f6f0c84e762f92`
- Candidate manager source: current working tree `clientManager.js`
- Relay pool: default pre-net seeds
- Device lookup samples: 0x4632c04cf8c44a586554951e7de03ca2bd3e8f1c, 0xca1e71d8105a598810578fb6042fa8cbc1e7f039, 0x5365baf29cb7ab58de588dfc448913cb609283e2
- Provider file: `C:\Users\4ever\Documents\GitHub\diode_js\reports\provider-candidates.json`
- Provider candidates loaded: 1

## Summary

- Average connect time: old 2414.12 ms, current 4132.8 ms
- Average selected relay RTT: old 205.82 ms, current 15.14 ms
- Average best connected RTT: old 10.98 ms, current 15.14 ms
- Average gap to best: old 194.84 ms, current 0 ms
- Average device resolution: old 209.36 ms, current 1527.99 ms

| Phase | Version | Connect ms | Startup relays | Selected relay | Source | Selected RTT ms | Best relay | Best RTT ms | Gap ms | Device resolution ms |
| --- | --- | ---: | ---: | --- | --- | ---: | --- | ---: | ---: | ---: |
| cold | old | 2488.63 | 6 | as2.prenet.diode.io:41046 | seed | 269.62 | eu1.prenet.diode.io:41046 | 10.7 | 258.92 | 282.48 |
| cold | current | 3536.89 | 4 | eu1.prenet.diode.io:41046 | seed | 17.73 | eu1.prenet.diode.io:41046 | 17.73 | 0 | 2267.97 |
| warm-1 | old | 2182.85 | 6 | as2.prenet.diode.io:41046 | seed | 163.61 | eu1.prenet.diode.io:41046 | 11.43 | 152.18 | 167.64 |
| warm-1 | current | 3825.42 | 4 | eu1.prenet.diode.io:41046 | seed | 14.53 | eu1.prenet.diode.io:41046 | 14.53 | 0 | 1091.52 |
| warm-2 | old | 2570.87 | 6 | as2.prenet.diode.io:41046 | seed | 184.22 | eu1.prenet.diode.io:41046 | 10.8 | 173.41 | 177.97 |
| warm-2 | current | 5036.08 | 4 | eu1.prenet.diode.io:41046 | seed | 13.17 | eu1.prenet.diode.io:41046 | 13.17 | 0 | 1224.48 |
