# Relay Selection Benchmark Report

- Generated: 2026-03-06T13:48:05.781Z
- Baseline old manager source: `HEAD` commit `a2a3ee05661e5e838a3d8db865f6f0c84e762f92`
- Candidate manager source: current working tree `clientManager.js`
- Relay pool: default pre-net seeds
- Device lookup samples: 0x4632c04cf8c44a586554951e7de03ca2bd3e8f1c, 0xca1e71d8105a598810578fb6042fa8cbc1e7f039, 0x5365baf29cb7ab58de588dfc448913cb609283e2
- Network discovery mode: live
- Benchmark profile: startup discovery only; background discovery probing disabled for deterministic timing

## Summary

- Average connect time: old 2075.32 ms, current 2742.77 ms
- Average selected relay RTT: old 181.21 ms, current 13.08 ms
- Average best connected RTT: old 13.28 ms, current 13.08 ms
- Average gap to best: old 167.93 ms, current 0 ms
- Average device resolution: old 184.73 ms, current 1156.55 ms

| Phase | Version | Connect ms | Startup relays | Selected relay | Source | Selected RTT ms | Best relay | Best RTT ms | Gap ms | Discovery usable | Discovery startup | Device relay | Device source | Device resolution ms |
| --- | --- | ---: | ---: | --- | --- | ---: | --- | ---: | ---: | ---: | ---: | --- | --- | ---: |
| cold | old | 2133.1 | 6 | as2.prenet.diode.io:41046 | seed | 189.63 | eu1.prenet.diode.io:41046 | 13.82 | 175.8 | n/a | n/a | us2.prenet.diode.io:41046 | seed | 193.3 |
| cold | current | 2847.42 | 3 | eu1.prenet.diode.io:41046 | seed | 12.05 | eu1.prenet.diode.io:41046 | 12.05 | 0 | 156 | 2 | 144.126.157.138:41046 | target | 985.47 |
| warm-1 | old | 2105.6 | 6 | as2.prenet.diode.io:41046 | seed | 173.68 | eu1.prenet.diode.io:41046 | 10.83 | 162.85 | n/a | n/a | us2.prenet.diode.io:41046 | seed | 176.91 |
| warm-1 | current | 2688.39 | 3 | eu1.prenet.diode.io:41046 | seed | 11.01 | eu1.prenet.diode.io:41046 | 11.01 | 0 | 167 | 2 | 144.126.157.138:41046 | target | 1151.5 |
| warm-2 | old | 1987.25 | 6 | as2.prenet.diode.io:41046 | seed | 180.33 | eu1.prenet.diode.io:41046 | 15.18 | 165.14 | n/a | n/a | us2.prenet.diode.io:41046 | seed | 183.98 |
| warm-2 | current | 2692.48 | 3 | eu1.prenet.diode.io:41046 | seed | 16.16 | eu1.prenet.diode.io:41046 | 16.16 | 0 | 157 | 2 | 144.126.157.138:41046 | target | 1332.69 |
