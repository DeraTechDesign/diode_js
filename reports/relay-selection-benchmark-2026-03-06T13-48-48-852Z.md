# Relay Selection Benchmark Report

- Generated: 2026-03-06T13:48:48.853Z
- Baseline old manager source: `HEAD` commit `a2a3ee05661e5e838a3d8db865f6f0c84e762f92`
- Candidate manager source: current working tree `clientManager.js`
- Relay pool: default pre-net seeds
- Device lookup samples: 0x4632c04cf8c44a586554951e7de03ca2bd3e8f1c, 0xca1e71d8105a598810578fb6042fa8cbc1e7f039, 0x5365baf29cb7ab58de588dfc448913cb609283e2
- Network discovery mode: snapshot
- Benchmark profile: startup discovery only; background discovery probing disabled for deterministic timing
- Network discovery snapshot: `C:\Users\4ever\Documents\GitHub\diode_js\reports\dio-network-snapshot.json`

## Summary

- Average connect time: old 2094.25 ms, current 3025.14 ms
- Average selected relay RTT: old 207.1 ms, current 14.98 ms
- Average best connected RTT: old 18.12 ms, current 14.98 ms
- Average gap to best: old 188.98 ms, current 0 ms
- Average device resolution: old 220.04 ms, current 33.65 ms

| Phase | Version | Connect ms | Startup relays | Selected relay | Source | Selected RTT ms | Best relay | Best RTT ms | Gap ms | Discovery usable | Discovery startup | Device relay | Device source | Device resolution ms |
| --- | --- | ---: | ---: | --- | --- | ---: | --- | ---: | ---: | ---: | ---: | --- | --- | ---: |
| cold | old | 2332.45 | 6 | as2.prenet.diode.io:41046 | seed | 272.49 | eu1.prenet.diode.io:41046 | 16.12 | 256.37 | n/a | n/a | us2.prenet.diode.io:41046 | seed | 282.09 |
| cold | current | 3031.82 | 3 | eu1.prenet.diode.io:41046 | seed | 13.93 | eu1.prenet.diode.io:41046 | 13.93 | 0 | 2 | 2 | 144.126.157.138:41046 | network | 26.75 |
| warm-1 | old | 1921.5 | 6 | as2.prenet.diode.io:41046 | seed | 163.67 | eu1.prenet.diode.io:41046 | 18.29 | 145.38 | n/a | n/a | us2.prenet.diode.io:41046 | seed | 178.63 |
| warm-1 | current | 2842.58 | 3 | eu1.prenet.diode.io:41046 | seed | 11.7 | eu1.prenet.diode.io:41046 | 11.7 | 0 | 2 | 2 | 144.126.157.138:41046 | network | 28.56 |
| warm-2 | old | 2028.81 | 6 | as2.prenet.diode.io:41046 | seed | 185.14 | eu1.prenet.diode.io:41046 | 19.94 | 165.2 | n/a | n/a | us2.prenet.diode.io:41046 | seed | 199.41 |
| warm-2 | current | 3201.02 | 3 | eu1.prenet.diode.io:41046 | seed | 19.32 | eu1.prenet.diode.io:41046 | 19.32 | 0 | 2 | 2 | 144.126.157.138:41046 | network | 45.65 |
