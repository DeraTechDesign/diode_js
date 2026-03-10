# Relay Selection Benchmark Report

- Generated: 2026-03-06T13:42:47.116Z
- Baseline old manager source: `HEAD` commit `a2a3ee05661e5e838a3d8db865f6f0c84e762f92`
- Candidate manager source: current working tree `clientManager.js`
- Relay pool: default pre-net seeds
- Device lookup samples: 0x4632c04cf8c44a586554951e7de03ca2bd3e8f1c, 0xca1e71d8105a598810578fb6042fa8cbc1e7f039, 0x5365baf29cb7ab58de588dfc448913cb609283e2
- Network discovery mode: live
- Benchmark profile: startup discovery only; background discovery probing disabled for deterministic timing

## Summary

- Average connect time: old 2114.15 ms, current 4516.54 ms
- Average selected relay RTT: old 179.53 ms, current 12.62 ms
- Average best connected RTT: old 18.29 ms, current 12.62 ms
- Average gap to best: old 161.24 ms, current 0 ms
- Average device resolution: old 191.42 ms, current 39.14 ms

| Phase | Version | Connect ms | Startup relays | Selected relay | Source | Selected RTT ms | Best relay | Best RTT ms | Gap ms | Discovery usable | Discovery startup | Device relay | Device source | Device resolution ms |
| --- | --- | ---: | ---: | --- | --- | ---: | --- | ---: | ---: | ---: | ---: | --- | --- | ---: |
| cold | old | 2300.79 | 6 | as2.prenet.diode.io:41046 | seed | 187.21 | eu1.prenet.diode.io:41046 | 26.01 | 161.21 | n/a | n/a | us2.prenet.diode.io:41046 | seed | 211.39 |
| cold | current | 4432.44 | 3 | eu1.prenet.diode.io:41046 | seed | 11.84 | eu1.prenet.diode.io:41046 | 11.84 | 0 | 160 | 2 | us2.prenet.diode.io:41046 | seed | 31.63 |
| warm-1 | old | 2025.06 | 6 | as2.prenet.diode.io:41046 | seed | 178.76 | eu1.prenet.diode.io:41046 | 12.05 | 166.71 | n/a | n/a | us2.prenet.diode.io:41046 | seed | 181.85 |
| warm-1 | current | 4511.23 | 3 | eu1.prenet.diode.io:41046 | seed | 10.69 | eu1.prenet.diode.io:41046 | 10.69 | 0 | 168 | 2 | us2.prenet.diode.io:41046 | seed | 32.78 |
| warm-2 | old | 2016.62 | 6 | as2.prenet.diode.io:41046 | seed | 172.62 | eu2.prenet.diode.io:41046 | 16.81 | 155.82 | n/a | n/a | us2.prenet.diode.io:41046 | seed | 181.01 |
| warm-2 | current | 4605.97 | 3 | eu1.prenet.diode.io:41046 | seed | 15.33 | eu1.prenet.diode.io:41046 | 15.33 | 0 | 161 | 2 | us2.prenet.diode.io:41046 | seed | 53.01 |
