# Relay Selection Benchmark Report

- Generated: 2026-03-06T12:46:12.420Z
- Baseline old manager source: `HEAD` commit `a2a3ee05661e5e838a3d8db865f6f0c84e762f92`
- Candidate manager source: current working tree `clientManager.js`
- Relay pool: default pre-net seeds
- Device lookup samples: 0x4632c04cf8c44a586554951e7de03ca2bd3e8f1c, 0xca1e71d8105a598810578fb6042fa8cbc1e7f039, 0x5365baf29cb7ab58de588dfc448913cb609283e2
- Network discovery mode: disabled

## Summary

- Average connect time: old 2365.56 ms, current 3576.94 ms
- Average selected relay RTT: old 185.77 ms, current 23.07 ms
- Average best connected RTT: old 13.54 ms, current 23.07 ms
- Average gap to best: old 172.24 ms, current 0 ms
- Average device resolution: old 189.87 ms, current 111.24 ms

| Phase | Version | Connect ms | Startup relays | Selected relay | Source | Selected RTT ms | Best relay | Best RTT ms | Gap ms | Discovery usable | Discovery startup | Device relay | Device source | Device resolution ms |
| --- | --- | ---: | ---: | --- | --- | ---: | --- | ---: | ---: | ---: | ---: | --- | --- | ---: |
| cold | old | 2694.55 | 6 | as2.prenet.diode.io:41046 | seed | 174.48 | eu1.prenet.diode.io:41046 | 15.8 | 158.68 | n/a | n/a | us2.prenet.diode.io:41046 | seed | 192.9 |
| cold | current | 3149.3 | 3 | eu1.prenet.diode.io:41046 | seed | 10.92 | eu1.prenet.diode.io:41046 | 10.92 | 0 | 0 | 0 | us2.prenet.diode.io:41046 | seed | 284.95 |
| warm-1 | old | 2528.34 | 6 | as2.prenet.diode.io:41046 | seed | 178.75 | eu1.prenet.diode.io:41046 | 11.54 | 167.21 | n/a | n/a | us2.prenet.diode.io:41046 | seed | 189.16 |
| warm-1 | current | 3612.52 | 3 | eu1.prenet.diode.io:41046 | seed | 9.86 | eu1.prenet.diode.io:41046 | 9.86 | 0 | 0 | 0 | us2.prenet.diode.io:41046 | seed | 24.47 |
| warm-2 | old | 1873.8 | 6 | as2.prenet.diode.io:41046 | seed | 204.09 | eu1.prenet.diode.io:41046 | 13.28 | 190.81 | n/a | n/a | us2.prenet.diode.io:41046 | seed | 187.54 |
| warm-2 | current | 3969.01 | 3 | eu1.prenet.diode.io:41046 | seed | 48.45 | eu1.prenet.diode.io:41046 | 48.45 | 0 | 0 | 0 | us2.prenet.diode.io:41046 | seed | 24.29 |
