# Relay Selection Benchmark Report

- Generated: 2026-03-06T14:02:09.332Z
- Baseline old manager source: `HEAD` commit `a2a3ee05661e5e838a3d8db865f6f0c84e762f92`
- Candidate manager source: current working tree `clientManager.js`
- Relay pool: default pre-net seeds
- Device lookup samples: 0x4632c04cf8c44a586554951e7de03ca2bd3e8f1c, 0xca1e71d8105a598810578fb6042fa8cbc1e7f039, 0x5365baf29cb7ab58de588dfc448913cb609283e2
- Network discovery mode: disabled

## Summary

- Average connect time: old 2167.69 ms, current 3169.68 ms
- Average selected relay RTT: old 184.35 ms, current 16.7 ms
- Average best connected RTT: old 14.98 ms, current 16.7 ms
- Average gap to best: old 169.37 ms, current 0 ms
- Average device resolution: old 180.4 ms, current 33.41 ms

| Phase | Version | Connect ms | Startup relays | Selected relay | Source | Selected RTT ms | Best relay | Best RTT ms | Gap ms | Discovery usable | Discovery startup | Device relay | Device source | Device resolution ms |
| --- | --- | ---: | ---: | --- | --- | ---: | --- | ---: | ---: | ---: | ---: | --- | --- | ---: |
| cold | old | 2480.46 | 6 | as2.prenet.diode.io:41046 | seed | 178.82 | eu2.prenet.diode.io:41046 | 17.22 | 161.6 | n/a | n/a | us2.prenet.diode.io:41046 | seed | 186.64 |
| cold | current | 3175.72 | 3 | eu1.prenet.diode.io:41046 | seed | 25.3 | eu1.prenet.diode.io:41046 | 25.3 | 0 | 0 | 0 | us2.prenet.diode.io:41046 | seed | 44.22 |
| warm-1 | old | 2117.14 | 6 | as2.prenet.diode.io:41046 | seed | 188.9 | eu1.prenet.diode.io:41046 | 14.81 | 174.09 | n/a | n/a | us2.prenet.diode.io:41046 | seed | 176.53 |
| warm-1 | current | 3123.1 | 3 | eu1.prenet.diode.io:41046 | seed | 14.24 | eu1.prenet.diode.io:41046 | 14.24 | 0 | 0 | 0 | us2.prenet.diode.io:41046 | seed | 30.62 |
| warm-2 | old | 1905.46 | 6 | as2.prenet.diode.io:41046 | seed | 185.33 | eu1.prenet.diode.io:41046 | 12.92 | 172.41 | n/a | n/a | us2.prenet.diode.io:41046 | seed | 178.04 |
| warm-2 | current | 3210.23 | 3 | eu1.prenet.diode.io:41046 | seed | 10.55 | eu1.prenet.diode.io:41046 | 10.55 | 0 | 0 | 0 | us2.prenet.diode.io:41046 | seed | 25.38 |
