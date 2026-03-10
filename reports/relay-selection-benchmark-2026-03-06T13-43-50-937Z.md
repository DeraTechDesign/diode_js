# Relay Selection Benchmark Report

- Generated: 2026-03-06T13:43:50.937Z
- Baseline old manager source: `HEAD` commit `a2a3ee05661e5e838a3d8db865f6f0c84e762f92`
- Candidate manager source: current working tree `clientManager.js`
- Relay pool: default pre-net seeds
- Device lookup samples: 0x4632c04cf8c44a586554951e7de03ca2bd3e8f1c, 0xca1e71d8105a598810578fb6042fa8cbc1e7f039, 0x5365baf29cb7ab58de588dfc448913cb609283e2
- Network discovery mode: snapshot
- Benchmark profile: startup discovery only; background discovery probing disabled for deterministic timing
- Network discovery snapshot: `C:\Users\4ever\Documents\GitHub\diode_js\reports\dio-network-snapshot.json`

## Summary

- Average connect time: old 2174.04 ms, current 4679.16 ms
- Average selected relay RTT: old 187.09 ms, current 27.64 ms
- Average best connected RTT: old 13.88 ms, current 27.64 ms
- Average gap to best: old 173.22 ms, current 0 ms
- Average device resolution: old 192.07 ms, current 149.08 ms

| Phase | Version | Connect ms | Startup relays | Selected relay | Source | Selected RTT ms | Best relay | Best RTT ms | Gap ms | Discovery usable | Discovery startup | Device relay | Device source | Device resolution ms |
| --- | --- | ---: | ---: | --- | --- | ---: | --- | ---: | ---: | ---: | ---: | --- | --- | ---: |
| cold | old | 2373.47 | 6 | as2.prenet.diode.io:41046 | seed | 185.7 | eu1.prenet.diode.io:41046 | 13.83 | 171.88 | n/a | n/a | us2.prenet.diode.io:41046 | seed | 198.62 |
| cold | current | 4398.46 | 3 | eu2.prenet.diode.io:41046 | seed | 45.33 | eu2.prenet.diode.io:41046 | 45.33 | 0 | 2 | 2 | us2.prenet.diode.io:41046 | seed | 396.59 |
| warm-1 | old | 1968.59 | 6 | as2.prenet.diode.io:41046 | seed | 188.89 | eu1.prenet.diode.io:41046 | 15.76 | 173.13 | n/a | n/a | us2.prenet.diode.io:41046 | seed | 186.72 |
| warm-1 | current | 4748.18 | 3 | eu1.prenet.diode.io:41046 | seed | 11.87 | eu1.prenet.diode.io:41046 | 11.87 | 0 | 2 | 2 | us2.prenet.diode.io:41046 | seed | 25.78 |
| warm-2 | old | 2180.07 | 6 | as2.prenet.diode.io:41046 | seed | 186.69 | eu1.prenet.diode.io:41046 | 12.04 | 174.65 | n/a | n/a | us2.prenet.diode.io:41046 | seed | 190.87 |
| warm-2 | current | 4890.84 | 3 | eu1.prenet.diode.io:41046 | seed | 25.71 | eu1.prenet.diode.io:41046 | 25.71 | 0 | 2 | 2 | us2.prenet.diode.io:41046 | seed | 24.87 |
