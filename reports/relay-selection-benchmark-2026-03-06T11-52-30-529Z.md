# Relay Selection Benchmark Report

- Generated: 2026-03-06T11:52:30.530Z
- Baseline old manager source: `HEAD` commit `a2a3ee05661e5e838a3d8db865f6f0c84e762f92`
- Candidate manager source: current working tree `clientManager.js`
- Relay pool: default pre-net seeds
- Device lookup samples: 0x4632c04cf8c44a586554951e7de03ca2bd3e8f1c, 0xca1e71d8105a598810578fb6042fa8cbc1e7f039, 0x5365baf29cb7ab58de588dfc448913cb609283e2

## Summary

- Average connect time: old 2299.35 ms, current 4155.14 ms
- Average selected relay RTT: old 175.5 ms, current 14.78 ms
- Average best connected RTT: old 15.6 ms, current 14.78 ms
- Average gap to best: old 159.9 ms, current 0 ms
- Average device resolution: old 302.53 ms, current 616.42 ms

| Phase | Version | Connect ms | Startup relays | Selected relay | Selected RTT ms | Best relay | Best RTT ms | Gap ms | Device resolution ms |
| --- | --- | ---: | ---: | --- | ---: | --- | ---: | ---: | ---: |
| cold | old | 2205.07 | 6 | as2.prenet.diode.io:41046 | 169.3 | eu1.prenet.diode.io:41046 | 14.49 | 154.8 | 543.03 |
| cold | current | 3559.45 | 3 | eu1.prenet.diode.io:41046 | 15.7 | eu1.prenet.diode.io:41046 | 15.7 | 0 | 1795.29 |
| warm-1 | old | 2571.89 | 6 | as2.prenet.diode.io:41046 | 175.48 | eu1.prenet.diode.io:41046 | 12.31 | 163.17 | 169.67 |
| warm-1 | current | 4459.06 | 4 | eu1.prenet.diode.io:41046 | 14.49 | eu1.prenet.diode.io:41046 | 14.49 | 0 | 24.76 |
| warm-2 | old | 2121.1 | 6 | as2.prenet.diode.io:41046 | 181.73 | eu1.prenet.diode.io:41046 | 20 | 161.73 | 194.89 |
| warm-2 | current | 4446.92 | 4 | eu1.prenet.diode.io:41046 | 14.16 | eu1.prenet.diode.io:41046 | 14.16 | 0 | 29.22 |
