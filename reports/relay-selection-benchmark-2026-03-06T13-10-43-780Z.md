# Relay Selection Benchmark Report

- Generated: 2026-03-06T13:10:43.780Z
- Baseline old manager source: `HEAD` commit `a2a3ee05661e5e838a3d8db865f6f0c84e762f92`
- Candidate manager source: current working tree `clientManager.js`
- Relay pool: default pre-net seeds
- Device lookup samples: 0x4632c04cf8c44a586554951e7de03ca2bd3e8f1c, 0xca1e71d8105a598810578fb6042fa8cbc1e7f039, 0x5365baf29cb7ab58de588dfc448913cb609283e2
- Network discovery mode: disabled

## Summary

- Average connect time: old 2071.01 ms, current 3210.63 ms
- Average selected relay RTT: old 175.51 ms, current 12.46 ms
- Average best connected RTT: old 12.13 ms, current 12.46 ms
- Average gap to best: old 163.38 ms, current 0 ms
- Average device resolution: old 184.22 ms, current 26.2 ms

| Phase | Version | Connect ms | Startup relays | Selected relay | Source | Selected RTT ms | Best relay | Best RTT ms | Gap ms | Discovery usable | Discovery startup | Device relay | Device source | Device resolution ms |
| --- | --- | ---: | ---: | --- | --- | ---: | --- | ---: | ---: | ---: | ---: | --- | --- | ---: |
| cold | old | 2393.4 | 6 | as2.prenet.diode.io:41046 | seed | 180.36 | eu1.prenet.diode.io:41046 | 11.36 | 169 | n/a | n/a | us2.prenet.diode.io:41046 | seed | 190.51 |
| cold | current | 3010.17 | 3 | eu1.prenet.diode.io:41046 | seed | 14.57 | eu1.prenet.diode.io:41046 | 14.57 | 0 | 0 | 0 | us2.prenet.diode.io:41046 | seed | 28.93 |
| warm-1 | old | 1940.72 | 6 | as2.prenet.diode.io:41046 | seed | 172.11 | eu1.prenet.diode.io:41046 | 13.11 | 159 | n/a | n/a | us2.prenet.diode.io:41046 | seed | 181.4 |
| warm-1 | current | 3137.61 | 3 | eu1.prenet.diode.io:41046 | seed | 11.13 | eu1.prenet.diode.io:41046 | 11.13 | 0 | 0 | 0 | us2.prenet.diode.io:41046 | seed | 25.67 |
| warm-2 | old | 1878.91 | 6 | as2.prenet.diode.io:41046 | seed | 174.06 | eu1.prenet.diode.io:41046 | 11.93 | 162.13 | n/a | n/a | us2.prenet.diode.io:41046 | seed | 180.76 |
| warm-2 | current | 3484.11 | 3 | eu1.prenet.diode.io:41046 | seed | 11.69 | eu1.prenet.diode.io:41046 | 11.69 | 0 | 0 | 0 | us2.prenet.diode.io:41046 | seed | 24.01 |
