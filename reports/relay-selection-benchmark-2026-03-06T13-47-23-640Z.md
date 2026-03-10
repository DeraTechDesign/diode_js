# Relay Selection Benchmark Report

- Generated: 2026-03-06T13:47:23.640Z
- Baseline old manager source: `HEAD` commit `a2a3ee05661e5e838a3d8db865f6f0c84e762f92`
- Candidate manager source: current working tree `clientManager.js`
- Relay pool: default pre-net seeds
- Device lookup samples: 0x4632c04cf8c44a586554951e7de03ca2bd3e8f1c, 0xca1e71d8105a598810578fb6042fa8cbc1e7f039, 0x5365baf29cb7ab58de588dfc448913cb609283e2
- Network discovery mode: disabled

## Summary

- Average connect time: old 2093.73 ms, current 3095.81 ms
- Average selected relay RTT: old 194.89 ms, current 11.61 ms
- Average best connected RTT: old 14.54 ms, current 11.61 ms
- Average gap to best: old 180.35 ms, current 0 ms
- Average device resolution: old 188.99 ms, current 42.06 ms

| Phase | Version | Connect ms | Startup relays | Selected relay | Source | Selected RTT ms | Best relay | Best RTT ms | Gap ms | Discovery usable | Discovery startup | Device relay | Device source | Device resolution ms |
| --- | --- | ---: | ---: | --- | --- | ---: | --- | ---: | ---: | ---: | ---: | --- | --- | ---: |
| cold | old | 2317.84 | 6 | as2.prenet.diode.io:41046 | seed | 176.41 | eu1.prenet.diode.io:41046 | 15.27 | 161.14 | n/a | n/a | us2.prenet.diode.io:41046 | seed | 201.06 |
| cold | current | 2961.2 | 3 | eu1.prenet.diode.io:41046 | seed | 10.46 | eu1.prenet.diode.io:41046 | 10.46 | 0 | 0 | 0 | us2.prenet.diode.io:41046 | seed | 62.31 |
| warm-1 | old | 1995.32 | 6 | as2.prenet.diode.io:41046 | seed | 233.87 | eu1.prenet.diode.io:41046 | 17.67 | 216.2 | n/a | n/a | us2.prenet.diode.io:41046 | seed | 187.24 |
| warm-1 | current | 3210.99 | 3 | eu1.prenet.diode.io:41046 | seed | 11.03 | eu1.prenet.diode.io:41046 | 11.03 | 0 | 0 | 0 | us2.prenet.diode.io:41046 | seed | 34.38 |
| warm-2 | old | 1968.02 | 6 | as2.prenet.diode.io:41046 | seed | 174.38 | eu1.prenet.diode.io:41046 | 10.68 | 163.7 | n/a | n/a | us2.prenet.diode.io:41046 | seed | 178.68 |
| warm-2 | current | 3115.23 | 3 | eu1.prenet.diode.io:41046 | seed | 13.35 | eu1.prenet.diode.io:41046 | 13.35 | 0 | 0 | 0 | us2.prenet.diode.io:41046 | seed | 29.48 |
