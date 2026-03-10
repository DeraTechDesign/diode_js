# Relay Selection Benchmark Report

- Generated: 2026-03-06T12:21:05.907Z
- Baseline old manager source: `HEAD` commit `a2a3ee05661e5e838a3d8db865f6f0c84e762f92`
- Candidate manager source: current working tree `clientManager.js`
- Relay pool: default pre-net seeds
- Device lookup samples: 0x4632c04cf8c44a586554951e7de03ca2bd3e8f1c, 0xca1e71d8105a598810578fb6042fa8cbc1e7f039, 0x5365baf29cb7ab58de588dfc448913cb609283e2

## Summary

- Average connect time: old 2095.53 ms, current 3460.89 ms
- Average selected relay RTT: old 175.34 ms, current 13.7 ms
- Average best connected RTT: old 18.46 ms, current 13.7 ms
- Average gap to best: old 156.88 ms, current 0 ms
- Average device resolution: old 178.85 ms, current 31.68 ms

| Phase | Version | Connect ms | Startup relays | Selected relay | Source | Selected RTT ms | Best relay | Best RTT ms | Gap ms | Device relay | Device source | Device resolution ms |
| --- | --- | ---: | ---: | --- | --- | ---: | --- | ---: | ---: | --- | --- | ---: |
| cold | old | 2548.68 | 6 | as2.prenet.diode.io:41046 | seed | 179.81 | eu1.prenet.diode.io:41046 | 11.01 | 168.8 | us2.prenet.diode.io:41046 | seed | 180.81 |
| cold | current | 3218.92 | 3 | eu1.prenet.diode.io:41046 | seed | 15.4 | eu1.prenet.diode.io:41046 | 15.4 | 0 | us2.prenet.diode.io:41046 | seed | 32.78 |
| warm-1 | old | 1959.21 | 6 | as2.prenet.diode.io:41046 | seed | 165.6 | eu1.prenet.diode.io:41046 | 13.66 | 151.94 | us2.prenet.diode.io:41046 | seed | 172.15 |
| warm-1 | current | 3598.7 | 3 | eu1.prenet.diode.io:41046 | seed | 12.7 | eu1.prenet.diode.io:41046 | 12.7 | 0 | us2.prenet.diode.io:41046 | seed | 29.73 |
| warm-2 | old | 1778.69 | 6 | as2.prenet.diode.io:41046 | seed | 180.63 | eu1.prenet.diode.io:41046 | 30.72 | 149.9 | us2.prenet.diode.io:41046 | seed | 183.6 |
| warm-2 | current | 3565.05 | 3 | eu1.prenet.diode.io:41046 | seed | 13 | eu1.prenet.diode.io:41046 | 13 | 0 | us2.prenet.diode.io:41046 | seed | 32.54 |
