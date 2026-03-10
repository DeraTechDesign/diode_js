# Relay Selection Benchmark Report

- Generated: 2026-03-06T13:50:27.118Z
- Baseline old manager source: `HEAD` commit `a2a3ee05661e5e838a3d8db865f6f0c84e762f92`
- Candidate manager source: current working tree `clientManager.js`
- Relay pool: default pre-net seeds
- Device lookup samples: 0x4632c04cf8c44a586554951e7de03ca2bd3e8f1c, 0xca1e71d8105a598810578fb6042fa8cbc1e7f039, 0x5365baf29cb7ab58de588dfc448913cb609283e2
- Network discovery mode: live
- Benchmark profile: startup discovery only; background discovery probing disabled for deterministic timing

## Summary

- Average connect time: old 2376.8 ms, current 2761.2 ms
- Average selected relay RTT: old 177.96 ms, current 11.61 ms
- Average best connected RTT: old 13.26 ms, current 11.61 ms
- Average gap to best: old 164.71 ms, current 0 ms
- Average device resolution: old 199.7 ms, current 1193.66 ms

| Phase | Version | Connect ms | Startup relays | Selected relay | Source | Selected RTT ms | Best relay | Best RTT ms | Gap ms | Discovery usable | Discovery startup | Device relay | Device source | Device resolution ms |
| --- | --- | ---: | ---: | --- | --- | ---: | --- | ---: | ---: | ---: | ---: | --- | --- | ---: |
| cold | old | 2308.34 | 6 | as2.prenet.diode.io:41046 | seed | 185.78 | eu1.prenet.diode.io:41046 | 10.39 | 175.39 | n/a | n/a | us2.prenet.diode.io:41046 | seed | 204.55 |
| cold | current | 2894.79 | 3 | eu1.prenet.diode.io:41046 | seed | 11.8 | eu1.prenet.diode.io:41046 | 11.8 | 0 | 171 | 2 | 144.126.157.138:41046 | target | 1005.31 |
| warm-1 | old | 2863.97 | 6 | as2.prenet.diode.io:41046 | seed | 170.78 | eu1.prenet.diode.io:41046 | 18.47 | 152.31 | n/a | n/a | us2.prenet.diode.io:41046 | seed | 219.17 |
| warm-1 | current | 2744.53 | 3 | eu1.prenet.diode.io:41046 | seed | 10.64 | eu1.prenet.diode.io:41046 | 10.64 | 0 | 164 | 2 | 144.126.157.138:41046 | target | 1180.94 |
| warm-2 | old | 1958.07 | 6 | as2.prenet.diode.io:41046 | seed | 177.32 | eu1.prenet.diode.io:41046 | 10.9 | 166.42 | n/a | n/a | us2.prenet.diode.io:41046 | seed | 175.37 |
| warm-2 | current | 2644.27 | 3 | eu1.prenet.diode.io:41046 | seed | 12.37 | eu1.prenet.diode.io:41046 | 12.37 | 0 | 167 | 2 | 144.126.157.138:41046 | target | 1394.72 |
