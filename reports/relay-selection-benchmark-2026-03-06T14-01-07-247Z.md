# Relay Selection Benchmark Report

- Generated: 2026-03-06T14:01:07.248Z
- Baseline old manager source: `HEAD` commit `a2a3ee05661e5e838a3d8db865f6f0c84e762f92`
- Candidate manager source: current working tree `clientManager.js`
- Relay pool: default pre-net seeds
- Device lookup samples: 0x4632c04cf8c44a586554951e7de03ca2bd3e8f1c, 0xca1e71d8105a598810578fb6042fa8cbc1e7f039, 0x5365baf29cb7ab58de588dfc448913cb609283e2
- Network discovery mode: live
- Benchmark profile: startup discovery only; background discovery probing disabled for deterministic timing

## Summary

- Average connect time: old 7289.76 ms, current 2535.68 ms
- Average selected relay RTT: old 176.74 ms, current 11.07 ms
- Average best connected RTT: old 13.47 ms, current 11.07 ms
- Average gap to best: old 163.27 ms, current 0 ms
- Average device resolution: old 197.36 ms, current 1594.52 ms

| Phase | Version | Connect ms | Startup relays | Selected relay | Source | Selected RTT ms | Best relay | Best RTT ms | Gap ms | Discovery usable | Discovery startup | Device relay | Device source | Device resolution ms |
| --- | --- | ---: | ---: | --- | --- | ---: | --- | ---: | ---: | ---: | ---: | --- | --- | ---: |
| cold | old | 3375.35 | 6 | as2.prenet.diode.io:41046 | seed | 172.02 | eu1.prenet.diode.io:41046 | 11.31 | 160.72 | n/a | n/a | us2.prenet.diode.io:41046 | seed | 181.15 |
| cold | current | 2848.91 | 3 | eu1.prenet.diode.io:41046 | seed | 11.24 | eu1.prenet.diode.io:41046 | 11.24 | 0 | 166 | 2 | eu1.prenet.diode.io:41046 | seed | 1679.94 |
| warm-1 | old | 14788.4 | 6 | as2.prenet.diode.io:41046 | seed | 179.28 | eu1.prenet.diode.io:41046 | 14.19 | 165.09 | n/a | n/a | us2.prenet.diode.io:41046 | seed | 204.25 |
| warm-1 | current | 2007.7 | 3 | eu1.prenet.diode.io:41046 | seed | 11.25 | eu1.prenet.diode.io:41046 | 11.25 | 0 | 168 | 2 | eu1.prenet.diode.io:41046 | seed | 1344.72 |
| warm-2 | old | 3705.52 | 6 | as2.prenet.diode.io:41046 | seed | 178.91 | eu1.prenet.diode.io:41046 | 14.91 | 164 | n/a | n/a | us2.prenet.diode.io:41046 | seed | 206.67 |
| warm-2 | current | 2750.44 | 3 | eu1.prenet.diode.io:41046 | seed | 10.73 | eu1.prenet.diode.io:41046 | 10.73 | 0 | 162 | 2 | 144.126.157.138:41046 | target | 1758.89 |
