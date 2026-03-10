# Relay Selection Benchmark Report

- Generated: 2026-03-06T11:54:42.684Z
- Baseline old manager source: `HEAD` commit `a2a3ee05661e5e838a3d8db865f6f0c84e762f92`
- Candidate manager source: current working tree `clientManager.js`
- Relay pool: default pre-net seeds
- Device lookup samples: 0x4632c04cf8c44a586554951e7de03ca2bd3e8f1c, 0xca1e71d8105a598810578fb6042fa8cbc1e7f039, 0x5365baf29cb7ab58de588dfc448913cb609283e2

## Summary

- Average connect time: old 2218.03 ms, current 3953.8 ms
- Average selected relay RTT: old 179.12 ms, current 13.49 ms
- Average best connected RTT: old 20.26 ms, current 13.49 ms
- Average gap to best: old 158.85 ms, current 0 ms
- Average device resolution: old 184.04 ms, current 28.15 ms

| Phase | Version | Connect ms | Startup relays | Selected relay | Selected RTT ms | Best relay | Best RTT ms | Gap ms | Device resolution ms |
| --- | --- | ---: | ---: | --- | ---: | --- | ---: | ---: | ---: |
| cold | old | 2518.13 | 6 | as2.prenet.diode.io:41046 | 174.27 | eu1.prenet.diode.io:41046 | 13.35 | 160.92 | 188.07 |
| cold | current | 3809.84 | 3 | eu1.prenet.diode.io:41046 | 12.61 | eu1.prenet.diode.io:41046 | 12.61 | 0 | 27.7 |
| warm-1 | old | 2045.96 | 6 | as2.prenet.diode.io:41046 | 183.27 | eu1.prenet.diode.io:41046 | 28.9 | 154.37 | 181.22 |
| warm-1 | current | 3863.42 | 3 | eu1.prenet.diode.io:41046 | 14.34 | eu1.prenet.diode.io:41046 | 14.34 | 0 | 29.62 |
| warm-2 | old | 2089.99 | 6 | as2.prenet.diode.io:41046 | 179.81 | eu2.prenet.diode.io:41046 | 18.54 | 161.27 | 182.82 |
| warm-2 | current | 4188.14 | 3 | eu1.prenet.diode.io:41046 | 13.53 | eu1.prenet.diode.io:41046 | 13.53 | 0 | 27.14 |
