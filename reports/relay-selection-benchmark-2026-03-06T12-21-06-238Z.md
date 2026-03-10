# Relay Selection Benchmark Report

- Generated: 2026-03-06T12:21:06.239Z
- Baseline old manager source: `HEAD` commit `a2a3ee05661e5e838a3d8db865f6f0c84e762f92`
- Candidate manager source: current working tree `clientManager.js`
- Relay pool: default pre-net seeds
- Device lookup samples: 0x4632c04cf8c44a586554951e7de03ca2bd3e8f1c, 0xca1e71d8105a598810578fb6042fa8cbc1e7f039, 0x5365baf29cb7ab58de588dfc448913cb609283e2
- Provider file: `C:\Users\4ever\Documents\GitHub\diode_js\reports\provider-candidates.json`
- Provider candidates loaded: 1

## Summary

- Average connect time: old 2044 ms, current 3539.86 ms
- Average selected relay RTT: old 184.28 ms, current 21.59 ms
- Average best connected RTT: old 13.32 ms, current 21.59 ms
- Average gap to best: old 170.96 ms, current 0 ms
- Average device resolution: old 188.63 ms, current 39.01 ms

| Phase | Version | Connect ms | Startup relays | Selected relay | Source | Selected RTT ms | Best relay | Best RTT ms | Gap ms | Device relay | Device source | Device resolution ms |
| --- | --- | ---: | ---: | --- | --- | ---: | --- | ---: | ---: | --- | --- | ---: |
| cold | old | 2477.21 | 6 | as2.prenet.diode.io:41046 | seed | 186.94 | eu1.prenet.diode.io:41046 | 10.34 | 176.6 | us2.prenet.diode.io:41046 | seed | 186.61 |
| cold | current | 3204.66 | 4 | eu1.prenet.diode.io:41046 | seed | 12.69 | eu1.prenet.diode.io:41046 | 12.69 | 0 | us2.prenet.diode.io:41046 | seed | 31.91 |
| warm-1 | old | 1865.28 | 6 | as2.prenet.diode.io:41046 | seed | 183.98 | eu1.prenet.diode.io:41046 | 12.3 | 171.68 | us2.prenet.diode.io:41046 | seed | 185.11 |
| warm-1 | current | 3782.33 | 4 | eu1.prenet.diode.io:41046 | seed | 39.24 | eu1.prenet.diode.io:41046 | 39.24 | 0 | us2.prenet.diode.io:41046 | seed | 28.2 |
| warm-2 | old | 1789.51 | 6 | as2.prenet.diode.io:41046 | seed | 181.91 | eu1.prenet.diode.io:41046 | 17.32 | 164.6 | us2.prenet.diode.io:41046 | seed | 194.16 |
| warm-2 | current | 3632.6 | 4 | eu1.prenet.diode.io:41046 | seed | 12.84 | eu1.prenet.diode.io:41046 | 12.84 | 0 | us2.prenet.diode.io:41046 | seed | 56.92 |
