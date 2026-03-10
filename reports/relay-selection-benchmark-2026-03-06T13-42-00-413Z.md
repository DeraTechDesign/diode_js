# Relay Selection Benchmark Report

- Generated: 2026-03-06T13:42:00.413Z
- Baseline old manager source: `HEAD` commit `a2a3ee05661e5e838a3d8db865f6f0c84e762f92`
- Candidate manager source: current working tree `clientManager.js`
- Relay pool: default pre-net seeds
- Device lookup samples: 0x4632c04cf8c44a586554951e7de03ca2bd3e8f1c, 0xca1e71d8105a598810578fb6042fa8cbc1e7f039, 0x5365baf29cb7ab58de588dfc448913cb609283e2
- Network discovery mode: disabled

## Summary

- Average connect time: old 2228.32 ms, current 3068.75 ms
- Average selected relay RTT: old 182.97 ms, current 13.63 ms
- Average best connected RTT: old 12.94 ms, current 13.63 ms
- Average gap to best: old 170.03 ms, current 0 ms
- Average device resolution: old 320.98 ms, current 121.45 ms

| Phase | Version | Connect ms | Startup relays | Selected relay | Source | Selected RTT ms | Best relay | Best RTT ms | Gap ms | Discovery usable | Discovery startup | Device relay | Device source | Device resolution ms |
| --- | --- | ---: | ---: | --- | --- | ---: | --- | ---: | ---: | ---: | ---: | --- | --- | ---: |
| cold | old | 2570.27 | 6 | as2.prenet.diode.io:41046 | seed | 203.18 | eu1.prenet.diode.io:41046 | 12.06 | 191.12 | n/a | n/a | us2.prenet.diode.io:41046 | seed | 609.45 |
| cold | current | 2774.61 | 3 | eu1.prenet.diode.io:41046 | seed | 16.9 | eu1.prenet.diode.io:41046 | 16.9 | 0 | 0 | 0 | us2.prenet.diode.io:41046 | seed | 286.82 |
| warm-1 | old | 2018.3 | 6 | as2.prenet.diode.io:41046 | seed | 179.61 | eu1.prenet.diode.io:41046 | 12.4 | 167.21 | n/a | n/a | us2.prenet.diode.io:41046 | seed | 184.84 |
| warm-1 | current | 3091.62 | 3 | eu1.prenet.diode.io:41046 | seed | 12.32 | eu1.prenet.diode.io:41046 | 12.32 | 0 | 0 | 0 | us2.prenet.diode.io:41046 | seed | 27.92 |
| warm-2 | old | 2096.38 | 6 | as2.prenet.diode.io:41046 | seed | 166.13 | eu1.prenet.diode.io:41046 | 14.37 | 151.76 | n/a | n/a | us2.prenet.diode.io:41046 | seed | 168.65 |
| warm-2 | current | 3340.01 | 3 | eu1.prenet.diode.io:41046 | seed | 11.67 | eu1.prenet.diode.io:41046 | 11.67 | 0 | 0 | 0 | us2.prenet.diode.io:41046 | seed | 49.6 |
