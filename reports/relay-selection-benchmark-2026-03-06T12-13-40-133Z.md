# Relay Selection Benchmark Report

- Generated: 2026-03-06T12:13:40.133Z
- Baseline old manager source: `HEAD` commit `a2a3ee05661e5e838a3d8db865f6f0c84e762f92`
- Candidate manager source: current working tree `clientManager.js`
- Relay pool: default pre-net seeds
- Device lookup samples: 0x4632c04cf8c44a586554951e7de03ca2bd3e8f1c, 0xca1e71d8105a598810578fb6042fa8cbc1e7f039, 0x5365baf29cb7ab58de588dfc448913cb609283e2

## Summary

- Average connect time: old 2424.13 ms, current 3741.42 ms
- Average selected relay RTT: old 184.75 ms, current 11.4 ms
- Average best connected RTT: old 13.31 ms, current 11.4 ms
- Average gap to best: old 171.44 ms, current 0 ms
- Average device resolution: old 298.31 ms, current 802.1 ms

| Phase | Version | Connect ms | Startup relays | Selected relay | Source | Selected RTT ms | Best relay | Best RTT ms | Gap ms | Device resolution ms |
| --- | --- | ---: | ---: | --- | --- | ---: | --- | ---: | ---: | ---: |
| cold | old | 2808.74 | 6 | as2.prenet.diode.io:41046 | seed | 207.74 | eu1.prenet.diode.io:41046 | 11.78 | 195.96 | 545.33 |
| cold | current | 3438.41 | 3 | eu1.prenet.diode.io:41046 | seed | 12.32 | eu1.prenet.diode.io:41046 | 12.32 | 0 | 2314.14 |
| warm-1 | old | 2270.87 | 6 | as2.prenet.diode.io:41046 | seed | 173.38 | eu1.prenet.diode.io:41046 | 13.25 | 160.14 | 178.28 |
| warm-1 | current | 3786.86 | 3 | eu1.prenet.diode.io:41046 | seed | 10.73 | eu1.prenet.diode.io:41046 | 10.73 | 0 | 44.53 |
| warm-2 | old | 2192.78 | 6 | as2.prenet.diode.io:41046 | seed | 173.13 | eu2.prenet.diode.io:41046 | 14.91 | 158.22 | 171.33 |
| warm-2 | current | 3999.01 | 3 | eu1.prenet.diode.io:41046 | seed | 11.14 | eu1.prenet.diode.io:41046 | 11.14 | 0 | 47.63 |
