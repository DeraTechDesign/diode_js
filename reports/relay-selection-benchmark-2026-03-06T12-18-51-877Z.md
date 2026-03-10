# Relay Selection Benchmark Report

- Generated: 2026-03-06T12:18:51.877Z
- Baseline old manager source: `HEAD` commit `a2a3ee05661e5e838a3d8db865f6f0c84e762f92`
- Candidate manager source: current working tree `clientManager.js`
- Relay pool: default pre-net seeds
- Device lookup samples: 0x4632c04cf8c44a586554951e7de03ca2bd3e8f1c, 0xca1e71d8105a598810578fb6042fa8cbc1e7f039, 0x5365baf29cb7ab58de588dfc448913cb609283e2

## Summary

- Average connect time: old 2414.93 ms, current 4053.48 ms
- Average selected relay RTT: old 183.05 ms, current 15.07 ms
- Average best connected RTT: old 13.5 ms, current 15.07 ms
- Average gap to best: old 169.55 ms, current 0 ms
- Average device resolution: old 186.42 ms, current 28.96 ms

| Phase | Version | Connect ms | Startup relays | Selected relay | Source | Selected RTT ms | Best relay | Best RTT ms | Gap ms | Device relay | Device source | Device resolution ms |
| --- | --- | ---: | ---: | --- | --- | ---: | --- | ---: | ---: | --- | --- | ---: |
| cold | old | 2861.17 | 6 | as2.prenet.diode.io:41046 | seed | 185.45 | eu1.prenet.diode.io:41046 | 13.68 | 171.77 | us2.prenet.diode.io:41046 | seed | 183.1 |
| cold | current | 3868.9 | 3 | eu1.prenet.diode.io:41046 | seed | 18.48 | eu1.prenet.diode.io:41046 | 18.48 | 0 | us2.prenet.diode.io:41046 | seed | 35.35 |
| warm-1 | old | 2234.15 | 6 | as2.prenet.diode.io:41046 | seed | 195.51 | eu1.prenet.diode.io:41046 | 13.78 | 181.73 | us2.prenet.diode.io:41046 | seed | 205.23 |
| warm-1 | current | 4495.95 | 3 | eu1.prenet.diode.io:41046 | seed | 10.74 | eu1.prenet.diode.io:41046 | 10.74 | 0 | us2.prenet.diode.io:41046 | seed | 27.23 |
| warm-2 | old | 2149.48 | 6 | as2.prenet.diode.io:41046 | seed | 168.2 | eu1.prenet.diode.io:41046 | 13.05 | 155.15 | us2.prenet.diode.io:41046 | seed | 170.93 |
| warm-2 | current | 3795.59 | 3 | eu1.prenet.diode.io:41046 | seed | 15.99 | eu1.prenet.diode.io:41046 | 15.99 | 0 | us2.prenet.diode.io:41046 | seed | 24.3 |
